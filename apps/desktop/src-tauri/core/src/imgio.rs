//! Image encode/decode with hard limits. Everything that touches untrusted bytes lives here.

use std::io::Cursor;

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};

/// Largest accepted input file.
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Largest accepted width or height.
pub const MAX_DIMENSION: u32 = 16_384;
/// Largest accepted pixel count (about 120 MP, so RGBA stays under half a gigabyte).
pub const MAX_PIXELS: u64 = 120_000_000;
/// Thumbnails fit inside this square.
pub const THUMB_SIZE: u32 = 256;

pub const ALLOWED_INPUT_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "bmp"];

pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Fast PNG: fdeflate compression, `Sub` filter. Measured as the best size/speed trade for UI
/// screenshots (large flat areas).
pub fn encode_png_fast(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let expected = width as usize * height as usize * 4;
    if rgba.len() != expected {
        return Err("Internal error: pixel buffer has the wrong size.".to_string());
    }
    let mut out = Vec::with_capacity(rgba.len() / 4 + 1024);
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Sub)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(|e| format!("Could not encode the image: {e}"))?;
    Ok(out)
}

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_image_width = Some(MAX_DIMENSION);
    l.max_image_height = Some(MAX_DIMENSION);
    l.max_alloc = Some(768 * 1024 * 1024);
    l
}

/// Decode PNG/JPEG/WebP/BMP bytes, checking dimensions before allocating pixel memory.
pub fn decode_limited(bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("That image is larger than the 64 MB limit.".to_string());
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "That file is not a supported image.".to_string())?;
    reader.limits(limits());
    match reader.format() {
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Bmp) => {}
        _ => return Err("Only PNG, JPEG, WebP and BMP images are supported.".to_string()),
    }
    let decoder = reader
        .into_decoder()
        .map_err(|_| "That image could not be read.".to_string())?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 || w > MAX_DIMENSION || h > MAX_DIMENSION {
        return Err(format!(
            "That image is too large ({w} x {h}). The limit is {MAX_DIMENSION} pixels per side."
        ));
    }
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err("That image has too many pixels (limit 120 megapixels).".to_string());
    }
    let img = image::DynamicImage::from_decoder(decoder)
        .map_err(|_| "That image could not be decoded.".to_string())?;
    let rgba = img.into_rgba8();
    Ok(Decoded {
        width: w,
        height: h,
        rgba: rgba.into_raw(),
    })
}

/// Read only the dimensions of an encoded image.
pub fn probe_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "That file is not a supported image.".to_string())?
        .into_dimensions()
        .map_err(|_| "That image could not be read.".to_string())
}

/// Thumbnail PNG fitting inside `THUMB_SIZE` x `THUMB_SIZE` (never upscaled).
pub fn thumbnail_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let (tw, th) = thumb_dims(width, height);
    if tw == width && th == height {
        return encode_png_fast(width, height, rgba);
    }
    let src = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or("Internal error: pixel buffer has the wrong size.")?;
    let small = image::imageops::resize(&src, tw, th, image::imageops::FilterType::Triangle);
    encode_png_fast(tw, th, small.as_raw())
}

pub fn thumb_dims(w: u32, h: u32) -> (u32, u32) {
    if w <= THUMB_SIZE && h <= THUMB_SIZE {
        return (w.max(1), h.max(1));
    }
    let scale = f64::from(THUMB_SIZE) / f64::from(w.max(h));
    (
        ((f64::from(w) * scale).round() as u32).max(1),
        ((f64::from(h) * scale).round() as u32).max(1),
    )
}

/// True when any pixel is not fully opaque.
pub fn has_transparency(rgba: &[u8]) -> bool {
    rgba.chunks_exact(4).any(|p| p[3] != 255)
}

/// Composite over white, dropping alpha (for formats that cannot carry it).
pub fn flatten_on_white(rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len());
    for p in rgba.chunks_exact(4) {
        let a = u32::from(p[3]);
        let blend = |c: u8| ((u32::from(c) * a + 255 * (255 - a) + 127) / 255) as u8;
        out.extend_from_slice(&[blend(p[0]), blend(p[1]), blend(p[2]), 255]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::new();
        for y in 0..h {
            for x in 0..w {
                v.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 128, 255]);
            }
        }
        v
    }

    #[test]
    fn png_round_trip() {
        let px = gradient(37, 21);
        let png = encode_png_fast(37, 21, &px).unwrap();
        let d = decode_limited(&png).unwrap();
        assert_eq!((d.width, d.height), (37, 21));
        assert_eq!(d.rgba, px);
        assert_eq!(probe_dimensions(&png).unwrap(), (37, 21));
    }

    #[test]
    fn encode_rejects_mismatched_buffers() {
        assert!(encode_png_fast(10, 10, &[0; 12]).is_err());
    }

    #[test]
    fn decode_rejects_garbage_and_oversized_headers() {
        assert!(decode_limited(b"not an image").is_err());
        assert!(decode_limited(&[]).is_err());
        // A valid PNG header claiming 20000 x 20000 must be refused before any allocation.
        let mut png = encode_png_fast(1, 1, &[0, 0, 0, 255]).unwrap();
        png[16..20].copy_from_slice(&20_000u32.to_be_bytes());
        png[20..24].copy_from_slice(&20_000u32.to_be_bytes());
        let err = decode_limited(&png).err().unwrap();
        assert!(!err.is_empty());
    }

    #[test]
    fn thumbnail_dimensions() {
        assert_eq!(thumb_dims(100, 50), (100, 50));
        assert_eq!(thumb_dims(512, 256), (256, 128));
        assert_eq!(thumb_dims(1000, 4000), (64, 256));
        assert_eq!(thumb_dims(10_000, 1), (256, 1));
        let px = gradient(512, 256);
        let t = thumbnail_png(512, 256, &px).unwrap();
        assert_eq!(probe_dimensions(&t).unwrap(), (256, 128));
    }

    #[test]
    fn transparency_and_flatten() {
        assert!(!has_transparency(&[1, 2, 3, 255, 4, 5, 6, 255]));
        assert!(has_transparency(&[1, 2, 3, 254]));
        let flat = flatten_on_white(&[0, 0, 0, 0, 0, 0, 0, 255, 100, 100, 100, 128]);
        assert_eq!(&flat[0..4], &[255, 255, 255, 255]); // transparent -> white
        assert_eq!(&flat[4..8], &[0, 0, 0, 255]); // opaque unchanged
        assert!(flat[8] > 100 && flat[8] < 255); // half-transparent grey lightened
    }
}
