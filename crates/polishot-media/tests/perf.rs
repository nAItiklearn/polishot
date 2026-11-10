//! Timing checks. They are `#[ignore]`d because only release builds are meaningful:
//!
//! ```text
//! cargo test -p polishot-media --release --test perf -- --ignored --nocapture
//! ```

mod common;

use common::*;
use polishot_media::{Frame, GifEncoder, GifOptions, StitchOptions, Stitcher};
use std::time::{Duration, Instant};

#[test]
#[ignore = "timing test: run in release mode"]
fn stitch_push_1080p_is_under_15_ms() {
    let (w, vh) = (1920usize, 1080usize);
    let doc = document(w, 9000, 3);
    let header = bar(w, 80, BarKind::Textured, 11, true);
    let footer = bar(w, 48, BarKind::Textured, 13, false);
    let shot = |y: usize| viewport(&doc, y, vh, Some(&header), Some(&footer));

    let mut st = Stitcher::new(shot(0), StitchOptions::default());
    let deltas = [380usize, 410, 350, 440, 300, 395, 420, 365, 330, 405];
    let mut y = 0usize;
    let mut times: Vec<Duration> = Vec::new();
    // Warm-up pass over the same code (page faults, caches), then the measured one.
    for round in 0..2 {
        if round == 1 {
            st = Stitcher::new(shot(0), StitchOptions::default());
            y = 0;
            times.clear();
        }
        for &d in deltas.iter().cycle().take(20) {
            y += d;
            if y > doc.height as usize - vh {
                break;
            }
            let frame = shot(y);
            let start = Instant::now();
            let got = st.push(&frame);
            times.push(start.elapsed());
            assert_eq!(got, Ok(d as u32));
        }
    }
    let total: Duration = times.iter().sum();
    let avg = total / times.len() as u32;
    let max = times.iter().max().copied().unwrap_or_default();
    let mut sorted = times.clone();
    sorted.sort();
    let median = sorted[sorted.len() / 2];
    eprintln!(
        "stitch 1920x1080: {} pushes, avg {:.2} ms, median {:.2} ms, max {:.2} ms",
        times.len(),
        avg.as_secs_f64() * 1e3,
        median.as_secs_f64() * 1e3,
        max.as_secs_f64() * 1e3
    );
    let out = st.finish();
    assert_eq!(
        out.rgba,
        expected(&doc, Some(&header), Some(&footer), vh, y).rgba
    );
    assert!(
        avg < Duration::from_millis(15),
        "average push {avg:?} exceeds the 15 ms budget"
    );
}

fn encode_run(label: &str, src_w: usize, src_h: usize, out_w: u32) {
    let doc = document(src_w, src_h * 3, 17);
    let mut enc = GifEncoder::new(
        Vec::new(),
        GifOptions {
            fps: 15,
            max_width: out_w,
            quality: 10,
            loop_forever: true,
        },
    );
    let mut spent = Duration::ZERO;
    // 10 seconds at 15 fps, scrolling 6 px per frame; every frame differs.
    let frames = 150usize;
    for i in 0..frames {
        let f: Frame = viewport(&doc, i * 6, src_h, None, None);
        let start = Instant::now();
        enc.add_frame(&f).expect("add frame");
        spent += start.elapsed();
    }
    let start = Instant::now();
    let bytes = enc.finish().expect("finish");
    spent += start.elapsed();
    eprintln!(
        "gif {label}: {frames} frames in {:.2} s ({:.1} ms/frame, {:.1}x realtime), {:.2} MB",
        spent.as_secs_f64(),
        spent.as_secs_f64() * 1e3 / frames as f64,
        10.0 / spent.as_secs_f64(),
        bytes.len() as f64 / 1e6
    );
    assert!(spent < Duration::from_secs(30));
}

#[test]
#[ignore = "timing test: run in release mode"]
fn gif_encode_10s_15fps_800w() {
    // Source already 800 px wide: quantise + LZW only.
    encode_run("800x450 source", 800, 450, 800);
    // 1080p source scaled to 800 px wide: box filter + quantise + LZW.
    encode_run("1920x1080 -> 800 wide", 1920, 1080, 800);
}
