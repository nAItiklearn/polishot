//! Streaming GIF89a encoder for short screen recordings.
//!
//! Frames are optionally downscaled (area average), merged with their predecessor when they are
//! bit-identical (the previous delay is extended), quantised to a per-frame local palette with
//! NeuQuant (or an exact palette when the frame has 256 colours or fewer) and written with the
//! `gif` crate. No transparency is used and gifski (AGPL) is not involved.

use crate::frame::{pixels_differ, Frame, FrameError};
use crate::scale::{downscale_box, target_size};
use color_quant::NeuQuant;
use std::borrow::Cow;
use std::fmt;
use std::io::Write;

/// Consecutive frames whose changed-pixel fraction is not above this are merged.
const DUPLICATE_THRESHOLD: f32 = 0.0;
/// Entries in the direct-mapped colour to palette-index cache (power of two).
const CACHE_SIZE: usize = 1 << 14;
/// A palette fit is measured on every n-th pixel (a prime, so it does not align with rows).
const ERROR_SAMPLE_STRIDE: usize = 13;
/// A sampled pixel counts as badly represented above this largest-channel error.
const BAD_PIXEL_ERROR: u8 = 24;

/// Encoder settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GifOptions {
    /// Capture rate, clamped to 1..=30. Each added frame lasts `1 / fps` seconds (identical
    /// consecutive frames extend the previous one). Delays are in whole centiseconds, with the
    /// rounding error spread over frames so the overall duration stays exact.
    pub fps: u16,
    /// Frames wider than this are scaled down, keeping the aspect ratio. `0` disables scaling.
    /// Frames are never enlarged.
    pub max_width: u32,
    /// NeuQuant sampling factor, clamped to 1..=30: `1` is the best palette and the slowest,
    /// `30` the fastest. `10` is a good compromise.
    pub quality: u8,
    /// Loop the animation forever (otherwise it plays once).
    pub loop_forever: bool,
}

impl Default for GifOptions {
    fn default() -> Self {
        GifOptions {
            fps: 15,
            max_width: 800,
            quality: 10,
            loop_forever: true,
        }
    }
}

/// Why a frame could not be added or the GIF could not be finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GifError {
    /// The frame's buffer does not match its dimensions.
    InvalidFrame(FrameError),
    /// The frame is not the same size as the first one.
    SizeMismatch {
        expected: (u32, u32),
        actual: (u32, u32),
    },
    /// The output would be wider or taller than the 65 535 pixels GIF can describe.
    TooLarge,
    /// `finish` was called before any frame was added.
    NoFrames,
    /// The underlying writer or GIF encoder failed.
    Encoding(String),
}

impl fmt::Display for GifError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GifError::InvalidFrame(e) => write!(f, "invalid frame: {e}"),
            GifError::SizeMismatch { expected, actual } => write!(
                f,
                "frame is {}x{} but the recording started at {}x{}",
                actual.0, actual.1, expected.0, expected.1
            ),
            GifError::TooLarge => write!(f, "frame is too large for a GIF"),
            GifError::NoFrames => write!(f, "no frames were added"),
            GifError::Encoding(msg) => write!(f, "GIF encoding failed: {msg}"),
        }
    }
}

impl std::error::Error for GifError {}

impl From<FrameError> for GifError {
    fn from(e: FrameError) -> Self {
        GifError::InvalidFrame(e)
    }
}

fn enc_err(e: gif::EncodingError) -> GifError {
    GifError::Encoding(e.to_string())
}

/// A decoded-size frame waiting for the next frame to decide its delay.
struct Pending {
    /// Scaled, opaque RGBA.
    pixels: Vec<u8>,
    /// Index of the first input frame it represents.
    start: u64,
    /// One past the last input frame it represents (grows when duplicates are merged).
    end: u64,
}

/// Streams RGBA frames into a GIF written to `W`.
///
/// ```
/// use polishot_media::{Frame, GifEncoder, GifOptions};
///
/// let frame = |v: u8| Frame { width: 8, height: 8, rgba: vec![v; 8 * 8 * 4] };
/// let mut enc = GifEncoder::new(Vec::new(), GifOptions { fps: 10, ..GifOptions::default() });
/// enc.add_frame(&frame(10)).unwrap();
/// enc.add_frame(&frame(10)).unwrap(); // identical: merged into a 200 ms frame
/// enc.add_frame(&frame(200)).unwrap();
/// let bytes = enc.finish().unwrap();
/// assert_eq!(&bytes[..6], b"GIF89a");
/// ```
pub struct GifEncoder<W: Write> {
    opts: GifOptions,
    /// The sink until the first frame fixes the dimensions.
    writer: Option<W>,
    encoder: Option<gif::Encoder<W>>,
    src_dims: Option<(u32, u32)>,
    out_dims: (u16, u16),
    /// Copy of the last distinct source frame (for duplicate detection).
    last_src: Vec<u8>,
    pending: Option<Pending>,
    /// Number of input frames seen, duplicates included.
    ticks: u64,
    written: u32,
    quantizer: Quantizer,
}

impl<W: Write> GifEncoder<W> {
    /// Creates an encoder. Nothing is written until the first frame arrives (the GIF header needs
    /// the final frame size). `fps` and `quality` are clamped to their valid ranges.
    #[must_use]
    pub fn new(writer: W, opts: GifOptions) -> Self {
        GifEncoder {
            opts: GifOptions {
                fps: opts.fps.clamp(1, 30),
                quality: opts.quality.clamp(1, 30),
                ..opts
            },
            writer: Some(writer),
            encoder: None,
            src_dims: None,
            out_dims: (0, 0),
            last_src: Vec::new(),
            pending: None,
            ticks: 0,
            written: 0,
            quantizer: Quantizer::new(opts.quality),
        }
    }

    /// Adds the next captured frame (one `1 / fps` tick). All frames must share the first
    /// frame's size.
    pub fn add_frame(&mut self, frame: &Frame) -> Result<(), GifError> {
        frame.validate()?;
        let dims = (frame.width, frame.height);
        match self.src_dims {
            Some(expected) if expected != dims => {
                return Err(GifError::SizeMismatch {
                    expected,
                    actual: dims,
                });
            }
            Some(_) => {}
            None => {
                let (ow, oh) = target_size(frame.width, frame.height, self.opts.max_width);
                let ow = u16::try_from(ow).map_err(|_| GifError::TooLarge)?;
                let oh = u16::try_from(oh).map_err(|_| GifError::TooLarge)?;
                self.out_dims = (ow, oh);
                self.src_dims = Some(dims);
            }
        }

        let tick = self.ticks;
        self.ticks += 1;

        if let Some(pending) = self.pending.as_mut() {
            if !pixels_differ(&self.last_src, &frame.rgba, DUPLICATE_THRESHOLD) {
                pending.end = self.ticks;
                return Ok(());
            }
        }

        let pixels = downscale_box(
            &frame.rgba,
            frame.width as usize,
            frame.height as usize,
            usize::from(self.out_dims.0),
            usize::from(self.out_dims.1),
        );
        self.last_src.clear();
        self.last_src.extend_from_slice(&frame.rgba);
        let previous = self.pending.replace(Pending {
            pixels,
            start: tick,
            end: tick + 1,
        });
        if let Some(previous) = previous {
            self.write_pending(previous)?;
        }
        Ok(())
    }

    /// Number of GIF frames written so far (the newest pending frame is not counted until the
    /// next distinct frame or `finish`).
    #[must_use]
    pub fn frames_written(&self) -> u32 {
        self.written
    }

    /// Size of the encoded animation, known after the first frame.
    #[must_use]
    pub fn output_size(&self) -> Option<(u32, u32)> {
        self.src_dims
            .map(|_| (u32::from(self.out_dims.0), u32::from(self.out_dims.1)))
    }

    /// Writes the last frame and the GIF trailer, and returns the writer.
    pub fn finish(mut self) -> Result<W, GifError> {
        if let Some(pending) = self.pending.take() {
            self.write_pending(pending)?;
        }
        match self.encoder.take() {
            Some(encoder) => encoder.into_inner().map_err(enc_err),
            None => Err(GifError::NoFrames),
        }
    }

    /// Frame delay in centiseconds for input ticks `start..end`, rounded against the running
    /// total so that the animation length does not drift.
    fn delay_cs(&self, start: u64, end: u64) -> u16 {
        let fps = u64::from(self.opts.fps);
        let to_cs = |t: u64| (t.saturating_mul(100) + fps / 2) / fps;
        let delay = to_cs(end).saturating_sub(to_cs(start));
        u16::try_from(delay.clamp(2, u64::from(u16::MAX))).unwrap_or(u16::MAX)
    }

    fn write_pending(&mut self, pending: Pending) -> Result<(), GifError> {
        let delay = self.delay_cs(pending.start, pending.end);
        let (palette, indices) = self.quantizer.quantize(&pending.pixels);
        let frame = gif::Frame {
            delay,
            width: self.out_dims.0,
            height: self.out_dims.1,
            palette: Some(palette),
            buffer: Cow::Owned(indices),
            ..gif::Frame::default()
        };
        let encoder = match self.encoder.as_mut() {
            Some(encoder) => encoder,
            None => {
                let writer = self
                    .writer
                    .take()
                    .ok_or_else(|| GifError::Encoding("writer already consumed".into()))?;
                let mut encoder = gif::Encoder::new(writer, self.out_dims.0, self.out_dims.1, &[])
                    .map_err(enc_err)?;
                if self.opts.loop_forever {
                    encoder.set_repeat(gif::Repeat::Infinite).map_err(enc_err)?;
                }
                self.encoder.insert(encoder)
            }
        };
        encoder.write_frame(&frame).map_err(enc_err)?;
        self.written += 1;
        Ok(())
    }
}

/// Direct-mapped cache from an RGB colour to its palette index. Screen content repeats a small
/// number of colours, so this removes almost all NeuQuant lookups.
struct ColorCache {
    keys: Vec<u32>,
    vals: Vec<u8>,
}

impl ColorCache {
    fn new() -> Self {
        ColorCache {
            keys: vec![u32::MAX; CACHE_SIZE],
            vals: vec![0; CACHE_SIZE],
        }
    }

    fn reset(&mut self) {
        self.keys.fill(u32::MAX);
    }

    /// Palette index of the RGBA pixel `px` under `net`.
    #[inline]
    fn index(&mut self, net: &NeuQuant, px: &[u8]) -> u8 {
        let key = u32::from(px[0]) << 16 | u32::from(px[1]) << 8 | u32::from(px[2]);
        let slot = (key.wrapping_mul(0x9E37_79B1) >> 18) as usize & (CACHE_SIZE - 1);
        if self.keys[slot] == key {
            self.vals[slot]
        } else {
            let idx = net.index_of(px) as u8;
            self.keys[slot] = key;
            self.vals[slot] = idx;
            idx
        }
    }
}

/// How well a palette represents a frame, measured on a pixel sample.
#[derive(Clone, Copy, Default)]
struct PaletteError {
    /// Mean of the largest per-channel error (0..255).
    mean: f32,
    /// Fraction of sampled pixels whose largest channel error exceeds [`BAD_PIXEL_ERROR`].
    bad: f32,
}

/// Turns opaque RGBA frames into `(palette, indices)` pairs.
///
/// Frames with at most 256 colours get an exact palette. Otherwise NeuQuant trains a palette; the
/// next frame keeps using that palette for as long as it represents the new frame about as well
/// as it did the frame it was trained on. Reusing a palette is what keeps static regions from
/// shimmering between frames and skips the (by far) most expensive step for typical recordings,
/// where consecutive frames share their colours. Every frame still carries its own local palette.
struct Quantizer {
    quality: i32,
    net: Option<NeuQuant>,
    palette: Vec<u8>,
    cache: ColorCache,
    baseline: PaletteError,
}

impl Quantizer {
    fn new(quality: u8) -> Self {
        Quantizer {
            quality: i32::from(quality.clamp(1, 30)),
            net: None,
            palette: Vec::new(),
            cache: ColorCache::new(),
            baseline: PaletteError::default(),
        }
    }

    fn quantize(&mut self, rgba: &[u8]) -> (Vec<u8>, Vec<u8>) {
        if let Some(exact) = exact_palette(rgba) {
            return exact;
        }
        let reusable = match self.net.as_ref() {
            Some(net) => {
                let err = sample_error(net, &mut self.cache, &self.palette, rgba);
                accepts(self.baseline, err)
            }
            None => false,
        };
        if !reusable {
            let net = NeuQuant::new(self.quality, 256, rgba);
            self.palette = net.color_map_rgb();
            self.cache.reset();
            self.baseline = sample_error(&net, &mut self.cache, &self.palette, rgba);
            self.net = Some(net);
        }
        let Some(net) = self.net.as_ref() else {
            return (Vec::new(), Vec::new());
        };
        let indices = rgba
            .chunks_exact(4)
            .map(|px| self.cache.index(net, px))
            .collect();
        (self.palette.clone(), indices)
    }
}

/// Whether a palette trained to reach `baseline` is still good enough for a frame with `err`.
fn accepts(baseline: PaletteError, err: PaletteError) -> bool {
    err.mean <= baseline.mean * 1.25 + 1.0 && err.bad <= baseline.bad * 1.5 + 0.003
}

/// Palette fit of `rgba` measured on every `ERROR_SAMPLE_STRIDE`-th pixel.
fn sample_error(
    net: &NeuQuant,
    cache: &mut ColorCache,
    palette: &[u8],
    rgba: &[u8],
) -> PaletteError {
    let (mut sum, mut bad, mut count) = (0u64, 0u32, 0u32);
    for px in rgba.chunks_exact(4).step_by(ERROR_SAMPLE_STRIDE) {
        let i = usize::from(cache.index(net, px)) * 3;
        let Some(c) = palette.get(i..i + 3) else {
            continue;
        };
        let e = px[..3]
            .iter()
            .zip(c)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        sum += u64::from(e);
        bad += u32::from(e > BAD_PIXEL_ERROR);
        count += 1;
    }
    if count == 0 {
        return PaletteError::default();
    }
    PaletteError {
        mean: sum as f32 / count as f32,
        bad: bad as f32 / count as f32,
    }
}

fn exact_palette(rgba: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    const TABLE: usize = 1024;
    let mut keys = [u32::MAX; TABLE];
    let mut vals = [0u8; TABLE];
    let mut count = 0usize;
    let mut palette = Vec::with_capacity(768);
    let mut indices = Vec::with_capacity(rgba.len() / 4);
    for px in rgba.chunks_exact(4) {
        let key = u32::from(px[0]) << 16 | u32::from(px[1]) << 8 | u32::from(px[2]);
        let mut slot = (key.wrapping_mul(0x9E37_79B1) >> 22) as usize & (TABLE - 1);
        loop {
            if keys[slot] == key {
                indices.push(vals[slot]);
                break;
            }
            if keys[slot] == u32::MAX {
                if count == 256 {
                    return None;
                }
                keys[slot] = key;
                vals[slot] = count as u8;
                palette.extend_from_slice(&px[..3]);
                indices.push(count as u8);
                count += 1;
                break;
            }
            slot = (slot + 1) & (TABLE - 1);
        }
    }
    Some((palette, indices))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoder(fps: u16) -> GifEncoder<Vec<u8>> {
        GifEncoder::new(
            Vec::new(),
            GifOptions {
                fps,
                ..GifOptions::default()
            },
        )
    }

    #[test]
    fn delays_do_not_drift() {
        let enc = encoder(15);
        // 15 single-frame ticks add up to exactly one second.
        let total: u32 = (0..15).map(|i| u32::from(enc.delay_cs(i, i + 1))).sum();
        assert_eq!(total, 100);
        // Merged duplicates extend the delay.
        assert_eq!(enc.delay_cs(0, 3), 20);
        let enc30 = encoder(30);
        let total30: u32 = (0..30).map(|i| u32::from(enc30.delay_cs(i, i + 1))).sum();
        assert_eq!(total30, 100);
    }

    #[test]
    fn options_are_clamped() {
        let enc = GifEncoder::new(
            Vec::new(),
            GifOptions {
                fps: 0,
                quality: 0,
                max_width: 0,
                loop_forever: false,
            },
        );
        assert_eq!((enc.opts.fps, enc.opts.quality), (1, 1));
        let enc = GifEncoder::new(
            Vec::new(),
            GifOptions {
                fps: 500,
                quality: 200,
                ..GifOptions::default()
            },
        );
        assert_eq!((enc.opts.fps, enc.opts.quality), (30, 30));
    }

    #[test]
    fn exact_palette_is_lossless_up_to_256_colours() {
        let mut px = Vec::new();
        for i in 0..256u32 {
            px.extend_from_slice(&[i as u8, (i * 3) as u8, 9, 255]);
        }
        let (palette, indices) = exact_palette(&px).expect("256 colours fit");
        assert_eq!(palette.len(), 256 * 3);
        for (i, &idx) in indices.iter().enumerate() {
            assert_eq!(
                &palette[idx as usize * 3..idx as usize * 3 + 3],
                &px[i * 4..i * 4 + 3]
            );
        }
        px.extend_from_slice(&[1, 2, 3, 255]);
        assert!(exact_palette(&px).is_none(), "257th colour overflows");
    }

    #[test]
    fn finish_without_frames_is_an_error() {
        assert_eq!(encoder(10).finish().unwrap_err(), GifError::NoFrames);
    }
}
