mod common;

use common::*;
use polishot_media::{frames_differ, Frame, FrameError, GifEncoder, GifError, GifOptions};
use std::io::{self, Cursor, Write};

/// Decoded GIF: logical screen size, loop mode and per-frame (width, height, delay, RGBA).
struct Decoded {
    width: u16,
    height: u16,
    repeat: gif::Repeat,
    frames: Vec<(u16, u16, u16, Vec<u8>)>,
}

fn decode(bytes: &[u8]) -> Decoded {
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::RGBA);
    let mut dec = options
        .read_info(Cursor::new(bytes))
        .expect("valid GIF header");
    let mut frames = Vec::new();
    while let Some(f) = dec.read_next_frame().expect("valid frame") {
        frames.push((f.width, f.height, f.delay, f.buffer.to_vec()));
    }
    Decoded {
        width: dec.width(),
        height: dec.height(),
        repeat: dec.repeat(),
        frames,
    }
}

/// A flat-colour scene (well under 256 colours) with a square at column `x`.
fn scene(w: u32, h: u32, x: u32) -> Frame {
    let mut rgba = vec![255u8; (w * h * 4) as usize];
    for y in 0..h {
        for xx in 0..w {
            let i = ((y * w + xx) * 4) as usize;
            let in_box = xx >= x && xx < x + 20 && (20..40).contains(&y);
            let c = if in_box {
                [220u8, 60, 40]
            } else if y < h / 2 {
                [30, 40, 70]
            } else {
                [230, 230, 225]
            };
            rgba[i..i + 3].copy_from_slice(&c);
        }
    }
    Frame {
        width: w,
        height: h,
        rgba,
    }
}

fn opts(fps: u16) -> GifOptions {
    GifOptions {
        fps,
        max_width: 0,
        quality: 10,
        loop_forever: true,
    }
}

fn encode(frames: &[Frame], o: GifOptions) -> Vec<u8> {
    let mut enc = GifEncoder::new(Vec::new(), o);
    for f in frames {
        enc.add_frame(f).expect("add frame");
    }
    enc.finish().expect("finish")
}

#[test]
fn ten_frames_round_trip() {
    let frames: Vec<Frame> = (0..10).map(|i| scene(120, 80, 4 + i * 9)).collect();
    let bytes = encode(&frames, opts(10));
    assert_eq!(&bytes[..6], b"GIF89a");
    assert_eq!(*bytes.last().expect("non-empty"), 0x3B, "GIF trailer");

    let d = decode(&bytes);
    assert_eq!((d.width, d.height), (120, 80));
    assert_eq!(d.repeat, gif::Repeat::Infinite);
    assert_eq!(d.frames.len(), 10);
    for (i, (w, h, delay, px)) in d.frames.iter().enumerate() {
        assert_eq!((*w, *h), (120, 80), "frame {i} size");
        assert_eq!(*delay, 10, "frame {i} delay (10 fps = 100 ms)");
        // Fewer than 256 colours: the palette is exact, so pixels survive losslessly.
        let src = &frames[i];
        for (a, b) in px.chunks_exact(4).zip(src.rgba.chunks_exact(4)) {
            assert_eq!(&a[..3], &b[..3], "frame {i} pixel mismatch");
            assert_eq!(a[3], 255, "no transparency");
        }
    }
}

#[test]
fn identical_frames_are_merged_into_longer_delays() {
    let a = scene(64, 48, 2);
    let b = scene(64, 48, 20);
    let c = scene(64, 48, 40);
    let seq = [&a, &a, &b, &b, &b, &c];
    let mut enc = GifEncoder::new(Vec::new(), opts(10));
    for f in seq {
        enc.add_frame(f).expect("add");
    }
    assert_eq!(enc.frames_written(), 2, "the last frame is still pending");
    let bytes = enc.finish().expect("finish");
    let d = decode(&bytes);
    assert_eq!(d.frames.len(), 3);
    let delays: Vec<u16> = d.frames.iter().map(|f| f.2).collect();
    assert_eq!(delays, vec![20, 30, 10]);
    // Total duration is preserved: six ticks at 100 ms.
    assert_eq!(delays.iter().map(|&x| u32::from(x)).sum::<u32>(), 60);
}

#[test]
fn fractional_frame_times_do_not_drift() {
    // 15 fps is 6.67 cs per frame: the delays alternate 7/6 and 30 frames last exactly 2 s.
    let frames: Vec<Frame> = (0..30).map(|i| scene(48, 32, i)).collect();
    let d = decode(&encode(&frames, opts(15)));
    assert_eq!(d.frames.len(), 30);
    assert!(d.frames.iter().all(|f| f.2 == 6 || f.2 == 7));
    assert_eq!(d.frames.iter().map(|f| u32::from(f.2)).sum::<u32>(), 200);
}

#[test]
fn downscale_keeps_aspect_ratio() {
    let frames: Vec<Frame> = (0..3).map(|i| scene(640, 360, i * 30)).collect();
    let o = GifOptions {
        max_width: 320,
        ..opts(10)
    };
    let d = decode(&encode(&frames, o));
    assert_eq!((d.width, d.height), (320, 180));
    assert!(d.frames.iter().all(|f| (f.0, f.1) == (320, 180)));
    // Flat regions are unchanged by area averaging: top-left is the dark band, bottom-left light.
    let px = &d.frames[0].3;
    assert_eq!(&px[..3], &[30, 40, 70]);
    let last_row = (179 * 320) * 4;
    assert_eq!(&px[last_row..last_row + 3], &[230, 230, 225]);
    // A frame that is already narrow enough is not scaled up.
    let small = decode(&encode(&[scene(100, 50, 3)], opts(10)));
    assert_eq!((small.width, small.height), (100, 50));
}

#[test]
fn photographic_frames_use_neuquant_with_small_error() {
    // Smooth gradients have thousands of colours, forcing the quantiser path.
    let (w, h) = (160usize, 100usize);
    let make = |shift: usize| {
        let mut rgba = vec![255u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                rgba[i] = ((x + shift) * 255 / (w + 40)) as u8;
                rgba[i + 1] = (y * 255 / h) as u8;
                rgba[i + 2] = (((x + y + shift) * 3) % 256) as u8;
            }
        }
        Frame {
            width: w as u32,
            height: h as u32,
            rgba,
        }
    };
    let frames = [make(0), make(10), make(20)];
    let d = decode(&encode(
        &frames,
        GifOptions {
            quality: 1,
            ..opts(10)
        },
    ));
    assert_eq!(d.frames.len(), 3);
    for (i, f) in d.frames.iter().enumerate() {
        let total: u64 =
            f.3.chunks_exact(4)
                .zip(frames[i].rgba.chunks_exact(4))
                .map(|(a, b)| (0..3).map(|c| u64::from(a[c].abs_diff(b[c]))).sum::<u64>())
                .sum();
        let mean = total as f64 / (w * h * 3) as f64;
        assert!(mean < 6.0, "frame {i}: mean channel error {mean:.2}");
    }
}

#[test]
fn play_once_has_no_loop_extension() {
    let o = GifOptions {
        loop_forever: false,
        ..opts(10)
    };
    let d = decode(&encode(&[scene(32, 32, 1), scene(32, 32, 9)], o));
    assert_ne!(d.repeat, gif::Repeat::Infinite);
    assert_eq!(d.frames.len(), 2);
}

#[test]
fn single_colour_and_tiny_frames_encode() {
    let flat = Frame {
        width: 1,
        height: 1,
        rgba: vec![9, 99, 199, 0],
    };
    let d = decode(&encode(&[flat], opts(30)));
    assert_eq!((d.width, d.height), (1, 1));
    assert_eq!(&d.frames[0].3[..3], &[9, 99, 199]);
    assert_eq!(d.frames[0].3[3], 255, "alpha is ignored, output is opaque");
}

#[test]
fn bad_input_is_an_error_not_a_panic() {
    let mut enc = GifEncoder::new(Vec::new(), opts(10));
    // Wrong buffer length.
    let bad = Frame {
        width: 4,
        height: 4,
        rgba: vec![0; 15],
    };
    assert_eq!(
        enc.add_frame(&bad),
        Err(GifError::InvalidFrame(FrameError::BadLength {
            expected: 64,
            actual: 15
        }))
    );
    // Zero size.
    let zero = Frame {
        width: 0,
        height: 5,
        rgba: Vec::new(),
    };
    assert_eq!(
        enc.add_frame(&zero),
        Err(GifError::InvalidFrame(FrameError::ZeroSize))
    );
    // Mismatched size after a good first frame.
    enc.add_frame(&scene(40, 30, 1)).expect("first frame");
    assert_eq!(
        enc.add_frame(&scene(41, 30, 1)),
        Err(GifError::SizeMismatch {
            expected: (40, 30),
            actual: (41, 30)
        })
    );
    // Still usable afterwards.
    enc.add_frame(&scene(40, 30, 8)).expect("second frame");
    assert_eq!(decode(&enc.finish().expect("finish")).frames.len(), 2);

    // Too wide for a GIF.
    let wide = Frame {
        width: 70_000,
        height: 1,
        rgba: vec![0; 70_000 * 4],
    };
    let mut enc = GifEncoder::new(Vec::new(), opts(10));
    assert_eq!(enc.add_frame(&wide), Err(GifError::TooLarge));

    // Nothing to write.
    let enc = GifEncoder::new(Vec::new(), opts(10));
    assert_eq!(enc.finish().unwrap_err(), GifError::NoFrames);
}

struct FailingWriter {
    budget: usize,
}

impl Write for FailingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.len() > self.budget {
            return Err(io::Error::other("disk full"));
        }
        self.budget -= buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn writer_failures_surface_as_errors() {
    let mut enc = GifEncoder::new(FailingWriter { budget: 40 }, opts(10));
    let mut failed = false;
    for i in 0..4 {
        if enc.add_frame(&scene(64, 48, i * 7)).is_err() {
            failed = true;
            break;
        }
    }
    let finished = enc.finish();
    assert!(
        failed || finished.is_err(),
        "a failing sink must be reported"
    );
}

#[test]
fn duplicate_detection_matches_frames_differ() {
    let a = scene(50, 40, 3);
    let b = scene(50, 40, 4);
    assert!(!frames_differ(&a, &a.clone(), 0.0));
    assert!(frames_differ(&a, &b, 0.0));
    // The encoder merges exactly the bit-identical neighbours.
    let bytes = encode(&[a.clone(), a, b], opts(20));
    assert_eq!(decode(&bytes).frames.len(), 2);
}

#[test]
fn encoding_is_deterministic() {
    let frames: Vec<Frame> = (0..4).map(|i| noise(40, 30, 100 + i)).collect();
    let o = GifOptions {
        quality: 5,
        ..opts(12)
    };
    assert_eq!(encode(&frames, o), encode(&frames, o));
}

/// Local palette of every frame, in file order.
fn palettes(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut dec = gif::DecodeOptions::new()
        .read_info(Cursor::new(bytes))
        .expect("valid GIF header");
    let mut out = Vec::new();
    while let Some(f) = dec.read_next_frame().expect("valid frame") {
        out.push(f.palette.clone().expect("every frame has a local palette"));
    }
    out
}

#[test]
fn palette_is_kept_while_it_fits_and_retrained_when_it_does_not() {
    let (w, h) = (160usize, 100usize);
    // Reds, or the same colours with red and blue swapped (a disjoint region of colour space).
    let make = |swapped: bool, nudge: bool| {
        let mut rgba = vec![255u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                let red = (100 + x * 155 / w) as u8;
                let green = (y * 60 / h) as u8;
                let blue = (((x + y) * 3) % 40) as u8;
                let px = if swapped {
                    [blue, green, red]
                } else {
                    [red, green, blue]
                };
                rgba[i..i + 3].copy_from_slice(&px);
            }
        }
        if nudge {
            rgba[0] ^= 1; // a single pixel differs, so the frames are not merged
        }
        Frame {
            width: w as u32,
            height: h as u32,
            rgba,
        }
    };
    let frames = [make(false, false), make(false, true), make(true, false)];
    let pals = palettes(&encode(&frames, opts(10)));
    assert_eq!(pals.len(), 3);
    assert!(pals.iter().all(|p| p.len() == 256 * 3));
    assert_eq!(
        pals[0], pals[1],
        "near-identical frames share their palette"
    );
    assert_ne!(
        pals[1], pals[2],
        "a very different frame gets a new palette"
    );
}
