//! Windows clipboard: images (registered "PNG" + CF_DIBV5 + CF_DIB) and text.
//!
//! * Browsers, Slack, Discord and Office read "PNG" and keep transparency.
//! * CF_DIBV5 carries alpha for apps that prefer bitmaps.
//! * CF_DIB is flattened on white so legacy apps (Paint, Word) never show black corners.
//!
//! The DIB builders/parsers are pure and unit-tested; the Win32 calls are thin wrappers.

use std::time::Duration;

use windows::core::w;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_UNICODETEXT};

use crate::imgio;

const MAX_CLIPBOARD_BYTES: usize = 256 * 1024 * 1024;
const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;
const LCS_SRGB: u32 = 0x7352_4742; // 'sRGB'

// ---- pure DIB helpers ------------------------------------------------------------------------

fn put_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}

fn put_u16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}

/// CF_DIB: BITMAPINFOHEADER + bottom-up 24-bit BGR rows (4-byte aligned), flattened on white.
pub fn build_dib24(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let flat = imgio::flatten_on_white(rgba);
    let stride = (w as usize * 3).div_ceil(4) * 4;
    let image_size = stride * h as usize;
    let mut out = Vec::with_capacity(40 + image_size);
    put_u32(&mut out, 40);
    put_u32(&mut out, w);
    put_u32(&mut out, h); // positive = bottom-up
    put_u16(&mut out, 1);
    put_u16(&mut out, 24);
    put_u32(&mut out, BI_RGB);
    put_u32(&mut out, image_size as u32);
    put_u32(&mut out, 2835);
    put_u32(&mut out, 2835);
    put_u32(&mut out, 0);
    put_u32(&mut out, 0);
    for y in (0..h as usize).rev() {
        let row = &flat[y * w as usize * 4..(y + 1) * w as usize * 4];
        let start = out.len();
        for p in row.chunks_exact(4) {
            out.extend_from_slice(&[p[2], p[1], p[0]]);
        }
        out.resize(start + stride, 0);
    }
    out
}

/// CF_DIBV5: BITMAPV5HEADER + bottom-up 32-bit BGRA with an alpha mask.
pub fn build_dibv5(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let image_size = w as usize * h as usize * 4;
    let mut out = Vec::with_capacity(124 + image_size);
    put_u32(&mut out, 124);
    put_u32(&mut out, w);
    put_u32(&mut out, h);
    put_u16(&mut out, 1);
    put_u16(&mut out, 32);
    put_u32(&mut out, BI_BITFIELDS);
    put_u32(&mut out, image_size as u32);
    put_u32(&mut out, 2835);
    put_u32(&mut out, 2835);
    put_u32(&mut out, 0);
    put_u32(&mut out, 0);
    put_u32(&mut out, 0x00FF_0000); // red
    put_u32(&mut out, 0x0000_FF00); // green
    put_u32(&mut out, 0x0000_00FF); // blue
    put_u32(&mut out, 0xFF00_0000); // alpha
    put_u32(&mut out, LCS_SRGB);
    out.extend_from_slice(&[0u8; 36]); // CIEXYZTRIPLE endpoints
    put_u32(&mut out, 0); // gamma red
    put_u32(&mut out, 0); // gamma green
    put_u32(&mut out, 0); // gamma blue
    put_u32(&mut out, 4); // LCS_GM_IMAGES
    put_u32(&mut out, 0); // profile data
    put_u32(&mut out, 0); // profile size
    put_u32(&mut out, 0); // reserved
    debug_assert_eq!(out.len(), 124);
    for y in (0..h as usize).rev() {
        let row = &rgba[y * w as usize * 4..(y + 1) * w as usize * 4];
        for p in row.chunks_exact(4) {
            out.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
        }
    }
    out
}

fn rd_u32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn rd_u16(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}

/// Wrap a packed DIB (as found on the clipboard) in a BITMAPFILEHEADER so a BMP decoder can
/// read it. Returns `None` for headers we do not understand.
pub fn dib_to_bmp_file(dib: &[u8]) -> Option<Vec<u8>> {
    let header_size = rd_u32(dib, 0)? as usize;
    if !matches!(header_size, 40 | 52 | 56 | 108 | 124) || dib.len() < header_size {
        return None;
    }
    let bit_count = rd_u16(dib, 14)?;
    let compression = rd_u32(dib, 16)?;
    let colors_used = rd_u32(dib, 32)? as usize;
    // Colour masks follow a plain 40-byte header when it is BI_BITFIELDS (3) or ALPHABITFIELDS (6).
    let masks = if header_size == 40 {
        match compression {
            3 => 12,
            6 => 16,
            _ => 0,
        }
    } else {
        0
    };
    let palette = if bit_count <= 8 {
        let n = if colors_used == 0 {
            1usize << bit_count
        } else {
            colors_used
        };
        n * 4
    } else {
        colors_used * 4
    };
    let offset = 14 + header_size + masks + palette;
    if dib.len() < offset - 14 {
        return None;
    }
    let mut out = Vec::with_capacity(14 + dib.len());
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&((14 + dib.len()) as u32).to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&(offset as u32).to_le_bytes());
    out.extend_from_slice(dib);
    Some(out)
}

/// Decode a clipboard DIB. `has_alpha` should be true only for CF_DIBV5; plain CF_DIB leaves the
/// fourth byte undefined, so it is forced opaque.
pub fn dib_to_rgba(dib: &[u8], has_alpha: bool) -> Result<imgio::Decoded, String> {
    let bmp = dib_to_bmp_file(dib).ok_or("The clipboard image format is not supported.")?;
    let mut d = imgio::decode_limited(&bmp)?;
    if !has_alpha || d.rgba.chunks_exact(4).all(|p| p[3] == 0) {
        for p in d.rgba.chunks_exact_mut(4) {
            p[3] = 255;
        }
    }
    Ok(d)
}

// ---- Win32 wrappers --------------------------------------------------------------------------

struct Open;

impl Open {
    fn new(hwnd: HWND) -> Result<Self, String> {
        for _ in 0..20 {
            // SAFETY: plain FFI call; the owner window handle outlives the call.
            if unsafe { OpenClipboard(Some(hwnd)) }.is_ok() {
                return Ok(Open);
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        Err("The clipboard is busy. Try again in a moment.".to_string())
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        // SAFETY: we hold the clipboard open (see `Open::new`).
        let _ = unsafe { CloseClipboard() };
    }
}

fn set_format(format: u32, data: &[u8]) -> Result<(), String> {
    // SAFETY: allocates a movable block, copies `data` in while locked, then hands ownership to
    // the clipboard on success. On failure the block is freed here.
    unsafe {
        let hmem = GlobalAlloc(GMEM_MOVEABLE, data.len().max(1))
            .map_err(|_| "Not enough memory to copy the image.".to_string())?;
        let ptr = GlobalLock(hmem) as *mut u8;
        if ptr.is_null() {
            let _ = GlobalFree(Some(hmem));
            return Err("Could not lock clipboard memory.".to_string());
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        let _ = GlobalUnlock(hmem);
        if SetClipboardData(format, Some(HANDLE(hmem.0))).is_err() {
            let _ = GlobalFree(Some(hmem));
            return Err("Could not write to the clipboard.".to_string());
        }
    }
    Ok(())
}

fn read_format(format: u32) -> Option<Vec<u8>> {
    // SAFETY: the clipboard is open (callers hold `Open`); the handle is only read while locked
    // and the data is copied out before unlocking.
    unsafe {
        let handle = GetClipboardData(format).ok()?;
        let hmem = HGLOBAL(handle.0);
        let size = GlobalSize(hmem);
        if size == 0 || size > MAX_CLIPBOARD_BYTES {
            return None;
        }
        let ptr = GlobalLock(hmem) as *const u8;
        if ptr.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
        let _ = GlobalUnlock(hmem);
        Some(bytes)
    }
}

fn png_format() -> u32 {
    // SAFETY: static wide string literal.
    unsafe { RegisterClipboardFormatW(w!("PNG")) }
}

fn available(format: u32) -> bool {
    // SAFETY: plain query.
    unsafe { IsClipboardFormatAvailable(format) }.is_ok()
}

/// Put an image on the clipboard. `png` is the encoded image; `decoded` is the same image as RGBA.
pub fn set_image(hwnd: HWND, png: &[u8], decoded: &imgio::Decoded) -> Result<(), String> {
    let _open = Open::new(hwnd)?;
    // SAFETY: clipboard is open.
    unsafe { EmptyClipboard() }.map_err(|_| "Could not clear the clipboard.".to_string())?;
    set_format(png_format(), png)?;
    set_format(
        u32::from(CF_DIBV5.0),
        &build_dibv5(decoded.width, decoded.height, &decoded.rgba),
    )?;
    set_format(
        u32::from(CF_DIB.0),
        &build_dib24(decoded.width, decoded.height, &decoded.rgba),
    )?;
    Ok(())
}

pub fn set_text(hwnd: HWND, text: &str) -> Result<(), String> {
    if text.len() > 32 * 1024 * 1024 {
        return Err("That text is too large to copy.".to_string());
    }
    let mut wide: Vec<u8> = Vec::with_capacity(text.len() * 2 + 2);
    for u in text.encode_utf16() {
        wide.extend_from_slice(&u.to_le_bytes());
    }
    wide.extend_from_slice(&[0, 0]);
    let _open = Open::new(hwnd)?;
    // SAFETY: clipboard is open.
    unsafe { EmptyClipboard() }.map_err(|_| "Could not clear the clipboard.".to_string())?;
    set_format(u32::from(CF_UNICODETEXT.0), &wide)
}

/// Read an image from the clipboard, preferring PNG (lossless with alpha), then DIBV5, then DIB.
pub fn get_image(hwnd: HWND) -> Result<Option<imgio::Decoded>, String> {
    let _open = Open::new(hwnd)?;
    let png = png_format();
    if available(png) {
        if let Some(bytes) = read_format(png) {
            if let Ok(d) = imgio::decode_limited(&bytes) {
                return Ok(Some(d));
            }
        }
    }
    if available(u32::from(CF_DIBV5.0)) {
        if let Some(bytes) = read_format(u32::from(CF_DIBV5.0)) {
            if let Ok(d) = dib_to_rgba(&bytes, true) {
                return Ok(Some(d));
            }
        }
    }
    if available(u32::from(CF_DIB.0)) {
        if let Some(bytes) = read_format(u32::from(CF_DIB.0)) {
            return dib_to_rgba(&bytes, false).map(Some);
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> (u32, u32, Vec<u8>) {
        // 3x2 (width not a multiple of 4 to exercise 24-bit row padding)
        let rgba = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, //
            10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255,
        ];
        (3, 2, rgba)
    }

    #[test]
    fn dib24_round_trips_through_the_bmp_decoder() {
        let (w, h, rgba) = sample();
        let dib = build_dib24(w, h, &rgba);
        assert_eq!(dib.len(), 40 + 12 * 2); // 3 px * 3 B = 9 -> padded to 12 per row
        let d = dib_to_rgba(&dib, false).unwrap();
        assert_eq!((d.width, d.height), (w, h));
        assert_eq!(d.rgba, rgba);
    }

    #[test]
    fn dibv5_round_trips_with_alpha() {
        let (w, h, mut rgba) = sample();
        rgba[3] = 128;
        rgba[7] = 0;
        let dib = build_dibv5(w, h, &rgba);
        assert_eq!(dib.len(), 124 + 3 * 2 * 4);
        let bmp = dib_to_bmp_file(&dib).unwrap();
        assert!(
            imgio::decode_limited(&bmp).is_ok(),
            "image crate must read BITMAPV5HEADER"
        );
        let d = dib_to_rgba(&dib, true).unwrap();
        assert_eq!(d.rgba, rgba);
    }

    #[test]
    fn plain_dib_is_forced_opaque() {
        // 32-bit BI_RGB DIB whose alpha byte is zero (typical of CF_DIB).
        let mut dib = Vec::new();
        put_u32(&mut dib, 40);
        put_u32(&mut dib, 1);
        put_u32(&mut dib, 1);
        put_u16(&mut dib, 1);
        put_u16(&mut dib, 32);
        put_u32(&mut dib, BI_RGB);
        for _ in 0..5 {
            put_u32(&mut dib, 0);
        }
        dib.extend_from_slice(&[30, 20, 10, 0]); // BGRA with alpha 0
        let d = dib_to_rgba(&dib, false).unwrap();
        assert_eq!(d.rgba, vec![10, 20, 30, 255]);
    }

    #[test]
    fn rejects_garbage_dibs() {
        assert!(dib_to_bmp_file(&[]).is_none());
        assert!(dib_to_bmp_file(&[1, 2, 3, 4, 5, 6, 7, 8]).is_none());
        let mut bad = vec![0u8; 60];
        bad[0] = 99; // unknown header size
        assert!(dib_to_bmp_file(&bad).is_none());
        assert!(dib_to_rgba(&[0; 8], true).is_err());
    }

    #[test]
    fn dib24_flattens_transparency_on_white() {
        let dib = build_dib24(1, 1, &[0, 0, 0, 0]);
        let d = dib_to_rgba(&dib, false).unwrap();
        assert_eq!(d.rgba, vec![255, 255, 255, 255]);
    }
}
