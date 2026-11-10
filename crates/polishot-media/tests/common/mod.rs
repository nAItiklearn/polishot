//! Deterministic synthetic screens for the stitching and GIF tests.
//!
//! A "document" is a tall, text-like page: sections with different pastel backgrounds, lines of
//! random glyph-like marks (every row is unique), gradient "images" and thin rules. Viewport
//! frames are slices of it with an optional fixed header bar on top and footer bar at the bottom,
//! exactly as a browser with sticky chrome would render them.
#![allow(dead_code)]

use polishot_media::Frame;

/// xorshift64* generator (no external crates).
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn below(&mut self, n: u32) -> u32 {
        ((self.next_u64() >> 33) % u64::from(n)) as u32
    }
}

fn pastel(rng: &mut Rng) -> [u8; 3] {
    [
        (200 + rng.below(56)) as u8,
        (200 + rng.below(56)) as u8,
        (200 + rng.below(56)) as u8,
    ]
}

fn dark(rng: &mut Rng) -> [u8; 3] {
    [
        rng.below(110) as u8,
        rng.below(110) as u8,
        rng.below(110) as u8,
    ]
}

fn put(row: &mut [u8], x: usize, c: [u8; 3]) {
    row[x * 4] = c[0];
    row[x * 4 + 1] = c[1];
    row[x * 4 + 2] = c[2];
    row[x * 4 + 3] = 255;
}

fn solid_row(w: usize, c: [u8; 3]) -> Vec<u8> {
    let mut row = vec![255u8; w * 4];
    for x in 0..w {
        put(&mut row, x, c);
    }
    row
}

/// One row of glyph-like marks: words of 5-px glyphs whose pixels are random per row.
fn glyph_row(w: usize, bg: [u8; 3], ink: [u8; 3], rng: &mut Rng) -> Vec<u8> {
    let mut row = solid_row(w, bg);
    let mut x = 8;
    while x + 6 < w.saturating_sub(8) {
        let word_len = 2 + rng.below(7) as usize;
        for _ in 0..word_len {
            if x + 6 >= w {
                break;
            }
            for gx in 0..5 {
                if rng.below(100) < 55 {
                    let shade = rng.below(40) as u8;
                    let c = [
                        ink[0].saturating_add(shade),
                        ink[1].saturating_add(shade),
                        ink[2].saturating_add(shade),
                    ];
                    put(&mut row, x + gx, c);
                }
            }
            x += 6;
        }
        x += 4 + rng.below(6) as usize;
    }
    row
}

/// A tall page `width` x `height` pixels.
pub fn document(width: usize, height: usize, seed: u64) -> Frame {
    let mut rng = Rng::new(seed);
    let mut rgba: Vec<u8> = Vec::with_capacity(width * height * 4);
    let mut bg = pastel(&mut rng);
    let mut section_left = 150 + rng.below(200) as usize;
    let mut rows = 0usize;
    while rows < height {
        if section_left == 0 {
            bg = pastel(&mut rng);
            section_left = 150 + rng.below(200) as usize;
        }
        let mut block: Vec<Vec<u8>> = Vec::new();
        match rng.below(10) {
            0..=6 => {
                let ink = dark(&mut rng);
                for _ in 0..3 {
                    block.push(solid_row(width, bg));
                }
                for _ in 0..8 {
                    block.push(glyph_row(width, bg, ink, &mut rng));
                }
                for _ in 0..3 {
                    block.push(solid_row(width, bg));
                }
            }
            7 => {
                let a = dark(&mut rng);
                let b = pastel(&mut rng);
                for r in 0..24usize {
                    let mut row = vec![255u8; width * 4];
                    for x in 0..width {
                        let t = (x * 255 / width.max(1)) as u32;
                        let v = (r as u32 * 7) % 40;
                        let c = [
                            ((u32::from(a[0]) * (255 - t) + u32::from(b[0]) * t) / 255) as u8,
                            ((u32::from(a[1]) * (255 - t) + u32::from(b[1]) * t) / 255) as u8,
                            ((u32::from(a[2]) * (255 - t) + u32::from(b[2]) * t) / 255)
                                .saturating_sub(v) as u8,
                        ];
                        put(&mut row, x, c);
                    }
                    block.push(row);
                }
            }
            8 => {
                block.push(solid_row(width, dark(&mut rng)));
                for _ in 0..3 {
                    block.push(solid_row(width, bg));
                }
            }
            _ => {
                for _ in 0..6 {
                    block.push(solid_row(width, bg));
                }
            }
        }
        for row in block {
            if rows == height {
                break;
            }
            rgba.extend_from_slice(&row);
            rows += 1;
            section_left = section_left.saturating_sub(1);
        }
    }
    Frame {
        width: width as u32,
        height: height as u32,
        rgba,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BarKind {
    /// Every row the same single colour.
    Uniform,
    /// Logo/text-like marks on a coloured bar with a darker edge line.
    Textured,
}

/// A fixed header or footer bar.
pub fn bar(width: usize, height: usize, kind: BarKind, seed: u64, header: bool) -> Frame {
    let mut rng = Rng::new(seed);
    let base = [
        rng.below(60) as u8,
        60 + rng.below(80) as u8,
        120 + rng.below(100) as u8,
    ];
    let mut rgba = Vec::with_capacity(width * height * 4);
    for r in 0..height {
        match kind {
            BarKind::Uniform => rgba.extend_from_slice(&solid_row(width, base)),
            BarKind::Textured => {
                let edge = if header { r + 1 == height } else { r == 0 };
                if edge {
                    rgba.extend_from_slice(&solid_row(width, [10, 10, 10]));
                } else {
                    rgba.extend_from_slice(&glyph_row(width, base, [235, 235, 235], &mut rng));
                }
            }
        }
    }
    Frame {
        width: width as u32,
        height: height as u32,
        rgba,
    }
}

/// The screen showing `doc` rows `y0..` under an optional fixed header and footer.
pub fn viewport(
    doc: &Frame,
    y0: usize,
    vh: usize,
    header: Option<&Frame>,
    footer: Option<&Frame>,
) -> Frame {
    let w = doc.width as usize;
    let ht = header.map_or(0, |f| f.height as usize);
    let ft = footer.map_or(0, |f| f.height as usize);
    let mut rgba = Vec::with_capacity(w * vh * 4);
    for i in 0..vh {
        let row: &[u8] = if let (Some(h), true) = (header, i < ht) {
            &h.rgba[i * w * 4..(i + 1) * w * 4]
        } else if let (Some(f), true) = (footer, i >= vh - ft) {
            let r = i - (vh - ft);
            &f.rgba[r * w * 4..(r + 1) * w * 4]
        } else {
            let y = y0 + i;
            &doc.rgba[y * w * 4..(y + 1) * w * 4]
        };
        rgba.extend_from_slice(row);
    }
    Frame {
        width: w as u32,
        height: vh as u32,
        rgba,
    }
}

/// What a perfect stitch of a capture that ended at scroll offset `y_last` looks like: the
/// header once, every document row that was ever visible below it, then the footer once.
pub fn expected(
    doc: &Frame,
    header: Option<&Frame>,
    footer: Option<&Frame>,
    vh: usize,
    y_last: usize,
) -> Frame {
    let w = doc.width as usize;
    let ht = header.map_or(0, |f| f.height as usize);
    let ft = footer.map_or(0, |f| f.height as usize);
    let mut rgba = Vec::new();
    if let Some(h) = header {
        rgba.extend_from_slice(&h.rgba);
    }
    rgba.extend_from_slice(&doc.rgba[ht * w * 4..(y_last + vh - ft) * w * 4]);
    if let Some(f) = footer {
        rgba.extend_from_slice(&f.rgba);
    }
    Frame {
        width: w as u32,
        height: (y_last + vh) as u32,
        rgba,
    }
}

/// Unstructured noise (not a document).
pub fn noise(width: usize, height: usize, seed: u64) -> Frame {
    let mut rng = Rng::new(seed);
    let mut rgba = vec![255u8; width * height * 4];
    for px in rgba.chunks_exact_mut(4) {
        px[0] = rng.below(256) as u8;
        px[1] = rng.below(256) as u8;
        px[2] = rng.below(256) as u8;
    }
    Frame {
        width: width as u32,
        height: height as u32,
        rgba,
    }
}

/// Index of the first differing byte, for readable assertion failures.
pub fn first_diff(a: &[u8], b: &[u8]) -> Option<usize> {
    a.iter().zip(b).position(|(x, y)| x != y).or({
        if a.len() == b.len() {
            None
        } else {
            Some(a.len().min(b.len()))
        }
    })
}

/// Asserts two frames are byte-identical, reporting the first differing row on failure.
pub fn assert_same(actual: &Frame, expected: &Frame) {
    assert_eq!(
        (actual.width, actual.height),
        (expected.width, expected.height),
        "dimensions differ"
    );
    if let Some(i) = first_diff(&actual.rgba, &expected.rgba) {
        let row = i / (actual.width as usize * 4);
        panic!("pixels differ, first at row {row} (byte {i})");
    }
}
