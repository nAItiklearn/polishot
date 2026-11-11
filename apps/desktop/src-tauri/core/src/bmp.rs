//! Uncompressed 32-bit BMP: the fastest thing to hand a webview, since decoding is a memcpy.
//!
//! Layout: BITMAPFILEHEADER (14) + BITMAPINFOHEADER (40) + three channel masks (12), then BGRX
//! pixels, top-down. Using BI_BITFIELDS with no alpha mask makes decoders ignore the unused
//! fourth byte, so screen grabs (alpha undefined) display opaque without a fix-up pass.

/// Two zero bytes after the channel masks put the pixel data on a 4-byte boundary, so the overlay
/// can read it as a `Uint32Array` without copying (the offset field says where the pixels start,
/// so every BMP decoder is unaffected).
pub const HEADER_LEN: usize = 14 + 40 + 12 + 2;

/// Write the BMP header for a `w x h` top-down 32bpp image into `out[..HEADER_LEN]`.
pub fn write_header(out: &mut [u8], w: u32, h: u32) {
    let data_len = w as usize * h as usize * 4;
    let total = (HEADER_LEN + data_len) as u32;
    let put32 = |o: &mut [u8], at: usize, v: u32| o[at..at + 4].copy_from_slice(&v.to_le_bytes());
    out[..HEADER_LEN].fill(0);
    out[0] = b'B';
    out[1] = b'M';
    put32(out, 2, total);
    put32(out, 10, HEADER_LEN as u32); // pixel data offset
    put32(out, 14, 40); // BITMAPINFOHEADER size
    put32(out, 18, w);
    put32(out, 22, (-(h as i32)) as u32); // negative height = top-down
    out[26..28].copy_from_slice(&1u16.to_le_bytes()); // planes
    out[28..30].copy_from_slice(&32u16.to_le_bytes()); // bits per pixel
    put32(out, 30, 3); // BI_BITFIELDS
    put32(out, 34, data_len as u32);
    put32(out, 38, 2835); // 72 dpi
    put32(out, 42, 2835);
    put32(out, 54, 0x00FF_0000); // red mask   (BGRX byte order)
    put32(out, 58, 0x0000_FF00); // green mask
    put32(out, 62, 0x0000_00FF); // blue mask
}

/// Build a BMP from tightly packed RGBA pixels (alpha is dropped by the decoder).
pub fn from_rgba(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; HEADER_LEN + rgba.len()];
    write_header(&mut out, w, h);
    // A u32 channel swap per pixel, in row bands on a few threads for big images.
    let row = (w as usize * 4).max(4);
    crate::pixels::par_rows(
        &mut out[HEADER_LEN..],
        row,
        crate::pixels::default_threads(),
        |i, dst| crate::pixels::swap_rb(dst, &rgba[i * row..(i + 1) * row], true),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_layout() {
        let rgba = [30u8, 20, 10, 0, 60, 50, 40, 0];
        let bmp = from_rgba(2, 1, &rgba);
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(
            u32::from_le_bytes(bmp[2..6].try_into().unwrap()) as usize,
            bmp.len()
        );
        assert_eq!(
            u32::from_le_bytes(bmp[10..14].try_into().unwrap()) as usize,
            HEADER_LEN
        );
        assert_eq!(i32::from_le_bytes(bmp[18..22].try_into().unwrap()), 2);
        assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), -1);
        assert_eq!(u16::from_le_bytes(bmp[28..30].try_into().unwrap()), 32);
        assert_eq!(u32::from_le_bytes(bmp[30..34].try_into().unwrap()), 3);
        assert_eq!(&bmp[HEADER_LEN..], &[10, 20, 30, 255, 40, 50, 60, 255]);
    }

    #[test]
    fn pixel_data_starts_on_a_word_boundary() {
        // The overlay reads the pixels as 32-bit words straight out of the response body.
        assert_eq!(HEADER_LEN % 4, 0);
        assert_eq!(HEADER_LEN, 68);
        let bmp = from_rgba(1, 1, &[1, 2, 3, 4]);
        assert_eq!(&bmp[66..68], &[0, 0], "padding after the masks");
        assert_eq!(&bmp[68..], &[3, 2, 1, 255]);
    }

    #[test]
    fn decodes_with_the_image_crate() {
        // 2x2: red, green / blue, white (RGBA in)
        let rgba = [
            255u8, 0, 0, 255, 0, 255, 0, 255, //
            0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let bmp = from_rgba(2, 2, &rgba);
        let img = image::load_from_memory_with_format(&bmp, image::ImageFormat::Bmp)
            .expect("valid bmp")
            .to_rgba8();
        assert_eq!(img.dimensions(), (2, 2));
        assert_eq!(img.get_pixel(0, 0).0[..3], [255, 0, 0]);
        assert_eq!(img.get_pixel(1, 0).0[..3], [0, 255, 0]);
        assert_eq!(img.get_pixel(0, 1).0[..3], [0, 0, 255]);
        assert_eq!(img.get_pixel(1, 1).0[..3], [255, 255, 255]);
    }
}
