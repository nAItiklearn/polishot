//! OCR through `Windows.Media.Ocr`. Output is `OcrWord[]` in source-image pixels (CONTRACTS
//! section 2) with `line` set to the reading-order line index. Text is never logged.

use serde::Serialize;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

pub const NO_LANGUAGE_MESSAGE: &str = "No OCR language is installed. Add a language in Windows Settings > Time & language > Language & region, then try again.";

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct BoxF {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OcrWord {
    pub text: String,
    #[serde(rename = "box")]
    pub bbox: BoxF,
    pub line: u32,
}

/// How an image must be scaled to fit the engine's maximum dimension.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScalePlan {
    pub width: u32,
    pub height: u32,
    /// Original / scaled factors, used to map boxes back to source pixels.
    pub inv_x: f64,
    pub inv_y: f64,
}

/// `None` when the image already fits; otherwise the downscaled size and the inverse factors.
pub fn plan_scale(width: u32, height: u32, max_dim: u32) -> Option<ScalePlan> {
    if max_dim == 0 || (width <= max_dim && height <= max_dim) {
        return None;
    }
    let k = f64::from(max_dim) / f64::from(width.max(height));
    let w = ((f64::from(width) * k).floor() as u32).clamp(1, max_dim);
    let h = ((f64::from(height) * k).floor() as u32).clamp(1, max_dim);
    Some(ScalePlan {
        width: w,
        height: h,
        inv_x: f64::from(width) / f64::from(w),
        inv_y: f64::from(height) / f64::from(h),
    })
}

/// Map a box in engine (scaled) pixels back to source pixels: scale up, round to whole pixels,
/// clamp inside `src_w x src_h`, and never return an empty box.
pub fn map_box(b: BoxF, inv_x: f64, inv_y: f64, src_w: u32, src_h: u32) -> BoxF {
    let (sw, sh) = (f64::from(src_w), f64::from(src_h));
    let x0 = (b.x * inv_x).floor().clamp(0.0, sw);
    let y0 = (b.y * inv_y).floor().clamp(0.0, sh);
    let x1 = ((b.x + b.w) * inv_x).ceil().clamp(0.0, sw);
    let y1 = ((b.y + b.h) * inv_y).ceil().clamp(0.0, sh);
    BoxF {
        x: x0,
        y: y0,
        w: (x1 - x0).max(1.0),
        h: (y1 - y0).max(1.0),
    }
}

/// Rec. 601 luma. The engine converts to grey internally, so sending Gray8 is 4x less data.
pub fn rgba_to_gray(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .map(|p| {
            ((u32::from(p[0]) * 299 + u32::from(p[1]) * 587 + u32::from(p[2]) * 114) / 1000) as u8
        })
        .collect()
}

fn downscale_gray(gray: &[u8], w: u32, h: u32, plan: &ScalePlan) -> Result<Vec<u8>, String> {
    let src = image::GrayImage::from_raw(w, h, gray.to_vec())
        .ok_or("Internal error: grey buffer has the wrong size.")?;
    let out = image::imageops::resize(
        &src,
        plan.width,
        plan.height,
        image::imageops::FilterType::Triangle,
    );
    Ok(out.into_raw())
}

fn werr(e: windows::core::Error) -> String {
    format!("Text recognition failed: {}", e.message())
}

fn create_engine() -> Result<OcrEngine, String> {
    if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
        return Ok(engine);
    }
    if let Ok(langs) = OcrEngine::AvailableRecognizerLanguages() {
        for lang in langs {
            if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                return Ok(engine);
            }
        }
    }
    Err(NO_LANGUAGE_MESSAGE.to_string())
}

/// Recognise text in an RGBA image. Blocking; call from a worker thread.
pub fn recognize(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<OcrWord>, String> {
    if rgba.len() != width as usize * height as usize * 4 || width == 0 || height == 0 {
        return Err("Internal error: pixel buffer has the wrong size.".to_string());
    }
    // Safe to call repeatedly; a different apartment type already set on this thread is fine.
    // SAFETY: plain COM/WinRT initialisation with no pointer arguments.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };

    let engine = create_engine()?;
    let max_dim = OcrEngine::MaxImageDimension().map_err(werr)?;
    let plan = plan_scale(width, height, max_dim);

    let mut gray = rgba_to_gray(rgba);
    let (ew, eh, inv_x, inv_y) = match &plan {
        Some(p) => {
            gray = downscale_gray(&gray, width, height, p)?;
            (p.width, p.height, p.inv_x, p.inv_y)
        }
        None => (width, height, 1.0, 1.0),
    };

    let writer = DataWriter::new().map_err(werr)?;
    writer.WriteBytes(&gray).map_err(werr)?;
    let buffer = writer.DetachBuffer().map_err(werr)?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Gray8,
        ew as i32,
        eh as i32,
    )
    .map_err(werr)?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(werr)?
        .join()
        .map_err(werr)?;

    let mut words = Vec::new();
    for (line_idx, line) in result.Lines().map_err(werr)?.into_iter().enumerate() {
        for word in line.Words().map_err(werr)? {
            let r = word.BoundingRect().map_err(werr)?;
            let text = word.Text().map_err(werr)?.to_string();
            if text.trim().is_empty() {
                continue;
            }
            let b = BoxF {
                x: f64::from(r.X),
                y: f64::from(r.Y),
                w: f64::from(r.Width),
                h: f64::from(r.Height),
            };
            words.push(OcrWord {
                text,
                bbox: map_box(b, inv_x, inv_y, width, height),
                line: line_idx as u32,
            });
        }
    }
    Ok(words)
}

/// Plain text of recognised words, one line per OCR line (for the history search index).
pub fn words_to_text(words: &[OcrWord]) -> String {
    let mut out = String::new();
    let mut current: Option<u32> = None;
    for w in words {
        match current {
            Some(l) if l == w.line => out.push(' '),
            Some(_) => out.push('\n'),
            None => {}
        }
        current = Some(w.line);
        out.push_str(&w.text);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_scaling_when_the_image_fits() {
        assert_eq!(plan_scale(1920, 1080, 10_000), None);
        assert_eq!(plan_scale(10_000, 10_000, 10_000), None);
        assert_eq!(plan_scale(100, 100, 0), None);
    }

    #[test]
    fn scaling_keeps_aspect_ratio_and_fits() {
        let p = plan_scale(16_000, 8_000, 10_000).unwrap();
        assert_eq!((p.width, p.height), (10_000, 5_000));
        assert!((p.inv_x - 1.6).abs() < 1e-9);
        assert!((p.inv_y - 1.6).abs() < 1e-9);
        let tall = plan_scale(100, 25_000, 10_000).unwrap();
        assert_eq!((tall.width, tall.height), (40, 10_000));
        assert!(tall.width >= 1);
        let sliver = plan_scale(1, 50_000, 10_000).unwrap();
        assert_eq!((sliver.width, sliver.height), (1, 10_000));
    }

    #[test]
    fn boxes_map_back_to_source_pixels() {
        let p = plan_scale(20_000, 10_000, 10_000).unwrap();
        assert_eq!(
            (p.width, p.height, p.inv_x, p.inv_y),
            (10_000, 5_000, 2.0, 2.0)
        );
        let b = map_box(
            BoxF {
                x: 100.0,
                y: 50.0,
                w: 200.0,
                h: 40.0,
            },
            p.inv_x,
            p.inv_y,
            20_000,
            10_000,
        );
        assert_eq!(
            b,
            BoxF {
                x: 200.0,
                y: 100.0,
                w: 400.0,
                h: 80.0
            }
        );
    }

    #[test]
    fn identity_mapping_keeps_integer_boxes() {
        let b = map_box(
            BoxF {
                x: 10.0,
                y: 20.0,
                w: 30.0,
                h: 40.0,
            },
            1.0,
            1.0,
            500,
            500,
        );
        assert_eq!(
            b,
            BoxF {
                x: 10.0,
                y: 20.0,
                w: 30.0,
                h: 40.0
            }
        );
    }

    #[test]
    fn fractional_boxes_grow_to_cover_whole_pixels() {
        let b = map_box(
            BoxF {
                x: 10.4,
                y: 20.6,
                w: 5.2,
                h: 3.1,
            },
            1.0,
            1.0,
            500,
            500,
        );
        // covers [10.4, 15.6] x [20.6, 23.7] -> [10, 16] x [20, 24]
        assert_eq!(
            b,
            BoxF {
                x: 10.0,
                y: 20.0,
                w: 6.0,
                h: 4.0
            }
        );
    }

    #[test]
    fn boxes_are_clamped_inside_the_image_and_never_empty() {
        let b = map_box(
            BoxF {
                x: -5.0,
                y: -5.0,
                w: 20.0,
                h: 20.0,
            },
            1.0,
            1.0,
            100,
            100,
        );
        assert_eq!(
            b,
            BoxF {
                x: 0.0,
                y: 0.0,
                w: 15.0,
                h: 15.0
            }
        );
        let edge = map_box(
            BoxF {
                x: 95.0,
                y: 95.0,
                w: 30.0,
                h: 30.0,
            },
            1.0,
            1.0,
            100,
            100,
        );
        assert_eq!(
            edge,
            BoxF {
                x: 95.0,
                y: 95.0,
                w: 5.0,
                h: 5.0
            }
        );
        let zero = map_box(
            BoxF {
                x: 50.0,
                y: 50.0,
                w: 0.0,
                h: 0.0,
            },
            1.0,
            1.0,
            100,
            100,
        );
        assert_eq!((zero.w, zero.h), (1.0, 1.0));
        let off = map_box(
            BoxF {
                x: 500.0,
                y: 500.0,
                w: 10.0,
                h: 10.0,
            },
            1.0,
            1.0,
            100,
            100,
        );
        assert!(off.x <= 100.0 && off.y <= 100.0 && off.w >= 1.0 && off.h >= 1.0);
    }

    #[test]
    fn grey_conversion() {
        assert_eq!(rgba_to_gray(&[255, 255, 255, 255]), [255]);
        assert_eq!(rgba_to_gray(&[0, 0, 0, 255]), [0]);
        let g = rgba_to_gray(&[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
        assert_eq!(g, [76, 149, 29]);
    }

    #[test]
    fn json_shape_matches_the_contract() {
        let w = OcrWord {
            text: "hi".into(),
            bbox: BoxF {
                x: 1.0,
                y: 2.0,
                w: 3.0,
                h: 4.0,
            },
            line: 2,
        };
        assert_eq!(
            serde_json::to_string(&w).unwrap(),
            r#"{"text":"hi","box":{"x":1.0,"y":2.0,"w":3.0,"h":4.0},"line":2}"#
        );
    }

    #[test]
    fn text_is_rebuilt_line_by_line() {
        let mk = |t: &str, line| OcrWord {
            text: t.into(),
            bbox: BoxF {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
            line,
        };
        let words = [mk("a", 0), mk("b", 0), mk("c", 1)];
        assert_eq!(words_to_text(&words), "a b\nc");
        assert_eq!(words_to_text(&[]), "");
    }

    /// Needs an installed Windows OCR language; run with `cargo test -- --ignored ocr_smoke`.
    #[test]
    #[ignore]
    fn ocr_smoke() {
        // White canvas with a black block "text-like" pattern: just proves the pipeline runs.
        let (w, h) = (200u32, 80u32);
        let rgba = vec![255u8; (w * h * 4) as usize];
        match recognize(w, h, &rgba) {
            Ok(words) => assert!(words.is_empty()),
            Err(e) => assert_eq!(e, NO_LANGUAGE_MESSAGE),
        }
    }
}
