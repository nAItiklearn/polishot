//! Windows clipboard: images (registered "PNG" + CF_DIBV5 + CF_DIB) and text.
//!
//! * Browsers, Slack, Discord and Office read "PNG" and keep transparency.
//! * CF_DIBV5 carries alpha for apps that prefer bitmaps.
//! * CF_DIB is flattened on white so legacy apps (Paint, Word) never show black corners. Opaque
//!   images skip it: Windows synthesises CF_DIB from CF_DIBV5 on request.
//!
//! Copying is two-phase so it feels instant: the PNG goes on the clipboard at once (a few
//! milliseconds, and it is what browsers, Slack and modern Office read), and the bitmap formats,
//! which cost hundreds of milliseconds to build for a 4K screenshot, are added a moment later on a
//! background thread, only if nothing else has been copied in between.
//!
//! The DIB builders/parsers are pure and unit-tested; the Win32 calls are thin wrappers.

use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use windows::core::w;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
};
use windows::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_UNICODETEXT};

use crate::{imgio, pixels, tlog};

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

/// Bytes per row of a 24-bit DIB: three bytes per pixel, padded to a multiple of four.
fn dib24_stride(w: u32) -> usize {
    (w as usize * 3).div_ceil(4) * 4
}

/// Total size of a CF_DIB for a `w x h` image.
pub fn dib24_len(w: u32, h: u32) -> usize {
    40 + dib24_stride(w) * h as usize
}

/// Total size of a CF_DIBV5 for a `w x h` image.
pub fn dibv5_len(w: u32, h: u32) -> usize {
    124 + w as usize * h as usize * 4
}

fn dib24_header(w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(40);
    put_u32(&mut out, 40);
    put_u32(&mut out, w);
    put_u32(&mut out, h); // positive = bottom-up
    put_u16(&mut out, 1);
    put_u16(&mut out, 24);
    put_u32(&mut out, BI_RGB);
    put_u32(&mut out, (dib24_stride(w) * h as usize) as u32);
    put_u32(&mut out, 2835);
    put_u32(&mut out, 2835);
    put_u32(&mut out, 0);
    put_u32(&mut out, 0);
    out
}

fn dibv5_header(w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(124);
    put_u32(&mut out, 124);
    put_u32(&mut out, w);
    put_u32(&mut out, h);
    put_u16(&mut out, 1);
    put_u16(&mut out, 32);
    put_u32(&mut out, BI_BITFIELDS);
    put_u32(&mut out, (w as usize * h as usize * 4) as u32);
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
    out
}

/// Write a CF_DIB into `dst` (exactly [`dib24_len`] bytes): BITMAPINFOHEADER + bottom-up
/// 24-bit BGR rows (4-byte aligned), flattened on white. Rows are filled in parallel bands.
pub fn fill_dib24(dst: &mut [u8], w: u32, h: u32, rgba: &[u8], threads: usize) {
    debug_assert_eq!(dst.len(), dib24_len(w, h));
    debug_assert_eq!(rgba.len(), w as usize * h as usize * 4);
    let (head, body) = dst.split_at_mut(40);
    head.copy_from_slice(&dib24_header(w, h));
    let px = w as usize;
    let last = h as usize - 1;
    pixels::par_rows(body, dib24_stride(w), threads, |i, row| {
        let y = last - i; // bottom-up
        let src = &rgba[y * px * 4..(y + 1) * px * 4];
        for (d, p) in row.chunks_exact_mut(3).zip(src.chunks_exact(4)) {
            let a = u32::from(p[3]);
            if a == 255 {
                d[0] = p[2];
                d[1] = p[1];
                d[2] = p[0];
            } else {
                // Same arithmetic as `imgio::flatten_on_white`.
                let blend = |c: u8| ((u32::from(c) * a + 255 * (255 - a) + 127) / 255) as u8;
                d[0] = blend(p[2]);
                d[1] = blend(p[1]);
                d[2] = blend(p[0]);
            }
        }
        row[px * 3..].fill(0); // row padding
    });
}

/// Write a CF_DIBV5 into `dst` (exactly [`dibv5_len`] bytes): BITMAPV5HEADER + bottom-up 32-bit
/// BGRA with an alpha mask. A u32 channel swap per pixel, in parallel bands.
pub fn fill_dibv5(dst: &mut [u8], w: u32, h: u32, rgba: &[u8], threads: usize) {
    debug_assert_eq!(dst.len(), dibv5_len(w, h));
    debug_assert_eq!(rgba.len(), w as usize * h as usize * 4);
    let (head, body) = dst.split_at_mut(124);
    head.copy_from_slice(&dibv5_header(w, h));
    let row_bytes = w as usize * 4;
    let last = h as usize - 1;
    pixels::par_rows(body, row_bytes, threads, |i, row| {
        let y = last - i; // bottom-up
        pixels::swap_rb(row, &rgba[y * row_bytes..(y + 1) * row_bytes], false);
    });
}

/// CF_DIB: BITMAPINFOHEADER + bottom-up 24-bit BGR rows (4-byte aligned), flattened on white.
pub fn build_dib24(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; dib24_len(w, h)];
    fill_dib24(&mut out, w, h, rgba, pixels::default_threads());
    out
}

/// CF_DIBV5: BITMAPV5HEADER + bottom-up 32-bit BGRA with an alpha mask.
pub fn build_dibv5(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; dibv5_len(w, h)];
    fill_dibv5(&mut out, w, h, rgba, pixels::default_threads());
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

/// A block of global memory filled with one clipboard format, allocated and copied *before* the
/// clipboard is opened. Copying tens of megabytes while holding the clipboard would keep every
/// other app (and the user's paste) waiting; this leaves only the hand-over inside the lock.
struct Staged {
    format: u32,
    hmem: Option<HGLOBAL>,
}

impl Staged {
    fn new(format: u32, data: &[u8]) -> Result<Self, String> {
        Self::build(format, data.len(), |dst| dst.copy_from_slice(data))
    }

    /// Allocate `len` zeroed bytes and let `fill` write the format straight into them, so a
    /// big bitmap is built once, in place, instead of in a Vec and then copied.
    fn build(format: u32, len: usize, fill: impl FnOnce(&mut [u8])) -> Result<Self, String> {
        // SAFETY: allocates a movable block and fills it while it is locked. The block is freed
        // by `Drop` unless `put` hands it to the clipboard.
        unsafe {
            let hmem = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, len.max(1))
                .map_err(|_| "Not enough memory to copy the image.".to_string())?;
            let ptr = GlobalLock(hmem) as *mut u8;
            if ptr.is_null() {
                let _ = GlobalFree(Some(hmem));
                return Err("Could not lock clipboard memory.".to_string());
            }
            fill(std::slice::from_raw_parts_mut(ptr, len));
            let _ = GlobalUnlock(hmem);
            Ok(Self {
                format,
                hmem: Some(hmem),
            })
        }
    }

    /// Give the block to the (open) clipboard. On success the clipboard owns it.
    fn put(mut self) -> Result<(), String> {
        let Some(hmem) = self.hmem.take() else {
            return Ok(());
        };
        // SAFETY: the clipboard is open (callers hold `Open`) and `hmem` is a valid movable block.
        if unsafe { SetClipboardData(self.format, Some(HANDLE(hmem.0))) }.is_err() {
            // SAFETY: the clipboard did not take ownership.
            let _ = unsafe { GlobalFree(Some(hmem)) };
            return Err("Could not write to the clipboard.".to_string());
        }
        Ok(())
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if let Some(hmem) = self.hmem.take() {
            // SAFETY: still ours: it was never handed to the clipboard.
            let _ = unsafe { GlobalFree(Some(hmem)) };
        }
    }
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

/// Above this many pixel bytes (64 MB, about a 4K screenshot and a half) the explicit CF_DIB is
/// skipped even for transparent images: a flattened 24-bit copy of a huge image costs time and
/// memory, and Windows synthesises a CF_DIB from CF_DIBV5 on request anyway.
pub const MAX_EXPLICIT_DIB_BYTES: usize = 64 * 1024 * 1024;

/// Whether an image gets an explicit, white-flattened CF_DIB: only if it has transparency (an
/// opaque image's synthesised CF_DIB is already right) and is not huge.
pub fn explicit_dib_needed(rgba: &[u8]) -> bool {
    rgba.len() <= MAX_EXPLICIT_DIB_BYTES && pixels::has_transparency(rgba)
}

/// Phase 1 of an image copy: replace the clipboard with just the PNG. Returns the clipboard
/// sequence number right after the write, which phase 2 uses to detect that something else was
/// copied in the meantime.
pub fn set_png(hwnd: HWND, png: &[u8]) -> Result<u32, String> {
    let block = Staged::new(png_format(), png)?;
    let _open = Open::new(hwnd)?;
    // SAFETY: clipboard is open.
    unsafe { EmptyClipboard() }.map_err(|_| "Could not clear the clipboard.".to_string())?;
    block.put()?;
    // SAFETY: plain query.
    Ok(unsafe { GetClipboardSequenceNumber() })
}

/// Phase 2: add CF_DIBV5 (and CF_DIB where needed) to the clipboard content written by
/// [`set_png`], unless the clipboard changed since (then nothing is touched and `false` is
/// returned). The bitmaps are built straight into global memory before the clipboard is opened.
fn append_bitmaps(hwnd: HWND, expected_seq: u32, decoded: &imgio::Decoded) -> Result<bool, String> {
    let (w, h, rgba) = (decoded.width, decoded.height, &decoded.rgba[..]);
    let threads = pixels::default_threads();
    let mut staged = vec![Staged::build(
        u32::from(CF_DIBV5.0),
        dibv5_len(w, h),
        |dst| fill_dibv5(dst, w, h, rgba, threads),
    )?];
    if explicit_dib_needed(rgba) {
        staged.push(Staged::build(
            u32::from(CF_DIB.0),
            dib24_len(w, h),
            |dst| fill_dib24(dst, w, h, rgba, threads),
        )?);
    }
    let _open = Open::new(hwnd)?;
    // SAFETY: plain query.
    if unsafe { GetClipboardSequenceNumber() } != expected_seq {
        return Ok(false); // the user copied something else; leave it alone
    }
    for block in staged {
        block.put()?;
    }
    Ok(true)
}

/// Newest image copy; a slower, older phase 2 gives up when it sees it has been superseded.
static COPY_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Copy an image: the PNG is on the clipboard when this returns (a few milliseconds), and the
/// bitmap formats follow from a background thread. `decoded` is the same image as RGBA if the
/// caller has it; otherwise the PNG is decoded in the background.
pub fn copy_png_fast(
    hwnd: HWND,
    png: Vec<u8>,
    decoded: Option<imgio::Decoded>,
) -> Result<(), String> {
    let seq = set_png(hwnd, &png)?;
    let generation = COPY_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let owner = hwnd.0 as isize;
    let spawned = std::thread::Builder::new()
        .name("clipboard-bitmaps".to_string())
        .spawn(move || {
            let started = std::time::Instant::now();
            let decoded = match decoded {
                Some(d) => d,
                None => match imgio::decode_limited(&png) {
                    Ok(d) => d,
                    Err(e) => {
                        tlog!("clipboard bitmaps skipped: {e}");
                        return;
                    }
                },
            };
            drop(png);
            if COPY_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let hwnd = HWND(owner as *mut c_void);
            match append_bitmaps(hwnd, seq, &decoded) {
                Ok(true) => tlog!(
                    "clipboard bitmaps added in {:.1} ms",
                    crate::timing::ms(started)
                ),
                Ok(false) => tlog!("clipboard bitmaps skipped: something else was copied"),
                Err(e) => tlog!("clipboard bitmaps failed: {e}"),
            }
        });
    if spawned.is_err() {
        tlog!("could not start the clipboard bitmap thread");
    }
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
    let block = Staged::new(u32::from(CF_UNICODETEXT.0), &wide)?;
    let _open = Open::new(hwnd)?;
    // SAFETY: clipboard is open.
    unsafe { EmptyClipboard() }.map_err(|_| "Could not clear the clipboard.".to_string())?;
    block.put()
}

/// Copy one format's bytes off the clipboard and release the clipboard again, so decoding a large
/// image never happens while other apps are locked out.
fn copy_format(hwnd: HWND, format: u32) -> Result<Option<Vec<u8>>, String> {
    let _open = Open::new(hwnd)?;
    Ok(if available(format) {
        read_format(format)
    } else {
        None
    })
}

#[derive(Clone, Copy)]
enum Kind {
    Png,
    DibV5,
    Dib,
}

/// Read an image from the clipboard, preferring PNG (lossless with alpha), then DIBV5, then DIB.
/// The clipboard is open only while the bytes are copied out; decoding happens after it is closed.
pub fn get_image(hwnd: HWND) -> Result<Option<imgio::Decoded>, String> {
    let mut last_error = None;
    for (format, kind) in [
        (png_format(), Kind::Png),
        (u32::from(CF_DIBV5.0), Kind::DibV5),
        (u32::from(CF_DIB.0), Kind::Dib),
    ] {
        let Some(bytes) = copy_format(hwnd, format)? else {
            continue;
        };
        let decoded = match kind {
            Kind::Png => imgio::decode_limited(&bytes),
            Kind::DibV5 => dib_to_rgba(&bytes, true),
            Kind::Dib => dib_to_rgba(&bytes, false),
        };
        match decoded {
            Ok(d) => return Ok(Some(d)),
            Err(e) => last_error = Some(e),
        }
    }
    // Nothing usable: an error only if something was there but could not be read.
    last_error.map_or(Ok(None), Err)
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
    fn the_explicit_dib_is_only_for_transparent_images_that_are_not_huge() {
        let opaque = vec![255u8; 4 * 100];
        let mut see_through = opaque.clone();
        see_through[3] = 128;
        assert!(!explicit_dib_needed(&opaque), "Windows synthesises it");
        assert!(explicit_dib_needed(&see_through));
        assert!(!explicit_dib_needed(&[]));
        // Huge transparent images skip it too.
        let mut huge = vec![255u8; MAX_EXPLICIT_DIB_BYTES + 4];
        huge[3] = 0;
        assert!(!explicit_dib_needed(&huge));
        huge.truncate(MAX_EXPLICIT_DIB_BYTES);
        assert!(explicit_dib_needed(&huge));
    }

    /// The straightforward builders the fast ones replaced, kept as the reference.
    fn reference_dibv5(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
        let mut out = dibv5_header(w, h);
        for y in (0..h as usize).rev() {
            for p in rgba[y * w as usize * 4..(y + 1) * w as usize * 4].chunks_exact(4) {
                out.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
            }
        }
        out
    }

    fn reference_dib24(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
        let flat = imgio::flatten_on_white(rgba);
        let stride = (w as usize * 3).div_ceil(4) * 4;
        let mut out = dib24_header(w, h);
        for y in (0..h as usize).rev() {
            let start = out.len();
            for p in flat[y * w as usize * 4..(y + 1) * w as usize * 4].chunks_exact(4) {
                out.extend_from_slice(&[p[2], p[1], p[0]]);
            }
            out.resize(start + stride, 0);
        }
        out
    }

    fn noisy(w: u32, h: u32, seed: u32, transparent: bool) -> Vec<u8> {
        let mut x = seed | 1;
        (0..w as usize * h as usize * 4)
            .map(|i| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                let b = (x >> 8) as u8;
                if i % 4 == 3 && !transparent {
                    255
                } else {
                    b
                }
            })
            .collect()
    }

    #[test]
    fn the_fast_builders_match_the_straightforward_ones_byte_for_byte() {
        // Odd widths exercise the 24-bit row padding; 1200 x 900 is large enough to split into
        // bands across threads.
        for (w, h) in [(1, 1), (3, 2), (7, 5), (64, 33), (1200, 900)] {
            for transparent in [false, true] {
                let rgba = noisy(w, h, w * 31 + h, transparent);
                let v5 = reference_dibv5(w, h, &rgba);
                let d24 = reference_dib24(w, h, &rgba);
                for threads in [1usize, 2, 4] {
                    let mut got5 = vec![0xAAu8; dibv5_len(w, h)];
                    fill_dibv5(&mut got5, w, h, &rgba, threads);
                    assert_eq!(
                        got5, v5,
                        "dibv5 {w}x{h} transparent={transparent} t={threads}"
                    );
                    // Padding and every other byte are written even into dirty memory.
                    let mut got24 = vec![0xAAu8; dib24_len(w, h)];
                    fill_dib24(&mut got24, w, h, &rgba, threads);
                    assert_eq!(
                        got24, d24,
                        "dib24 {w}x{h} transparent={transparent} t={threads}"
                    );
                }
                assert_eq!(build_dibv5(w, h, &rgba), v5);
                assert_eq!(build_dib24(w, h, &rgba), d24);
            }
        }
    }

    /// `cargo test --release -p polishot-desktop-core -- --ignored clipboard_build_times --nocapture`
    /// Where the time of a 4K copy goes, and what the fast builders save.
    #[test]
    #[ignore = "timing test: run in release mode"]
    fn clipboard_build_times() {
        use std::time::Instant;
        let (w, h) = (3786u32, 2566u32);
        let rgba = noisy(w, h, 11, false);
        let time = |label: &str, f: &mut dyn FnMut()| {
            let t = Instant::now();
            f();
            eprintln!("{label:<34} {:>7.1} ms", t.elapsed().as_secs_f64() * 1e3);
        };
        let png = imgio::encode_png_fast(w, h, &rgba).unwrap();
        eprintln!("{w}x{h}, PNG {} KB", png.len() / 1024);
        time("decode PNG (was before the toast)", &mut || {
            let _ = imgio::decode_limited(&png).unwrap();
        });
        time("has_transparency (opaque scan)", &mut || {
            assert!(!pixels::has_transparency(&rgba));
        });
        time("CF_DIBV5 old per-pixel push", &mut || {
            let _ = reference_dibv5(w, h, &rgba);
        });
        let mut out = vec![0u8; dibv5_len(w, h)];
        time("CF_DIBV5 new, 1 thread", &mut || {
            fill_dibv5(&mut out, w, h, &rgba, 1)
        });
        time("CF_DIBV5 new, 4 threads", &mut || {
            fill_dibv5(&mut out, w, h, &rgba, 4)
        });
        time("CF_DIB old flatten + push (opaque)", &mut || {
            let _ = reference_dib24(w, h, &rgba);
        });
        let mut out24 = vec![0u8; dib24_len(w, h)];
        time("CF_DIB new, 4 threads (opaque)", &mut || {
            fill_dib24(&mut out24, w, h, &rgba, 4)
        });
    }

    #[test]
    fn declared_lengths_match_what_is_built() {
        for (w, h) in [(1u32, 1u32), (5, 3), (4, 4), (3786, 2)] {
            assert_eq!(
                dib24_len(w, h),
                40 + (w as usize * 3).div_ceil(4) * 4 * h as usize
            );
            assert_eq!(dibv5_len(w, h), 124 + w as usize * h as usize * 4);
            let rgba = vec![200u8; w as usize * h as usize * 4];
            assert_eq!(build_dib24(w, h, &rgba).len(), dib24_len(w, h));
            assert_eq!(build_dibv5(w, h, &rgba).len(), dibv5_len(w, h));
        }
    }

    #[test]
    fn dib24_flattens_transparency_on_white() {
        let dib = build_dib24(1, 1, &[0, 0, 0, 0]);
        let d = dib_to_rgba(&dib, false).unwrap();
        assert_eq!(d.rgba, vec![255, 255, 255, 255]);
    }
}
