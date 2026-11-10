//! The `polishot` custom protocol (`http://polishot.localhost/...` inside a Windows webview).
//!
//! Routes (CONTRACTS section 5):
//!   /frame/<monitor>   frozen monitor frame      overlay-<monitor> only
//!   /capture/<id>      full capture image         preview, pin-*
//!   /history/<id>      stored capture (PNG)       preview, pin-*
//!   /thumb/<id>        256px thumbnail (PNG)      preview, pin-*
//!
//! Ids are validated before they get anywhere near a path; paths are only ever built from the
//! validated id plus a fixed extension.

use std::borrow::Cow;

use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{AppHandle, UriSchemeContext, UriSchemeResponder};

use crate::imgio;
use crate::routes::{allowed, parse_route, Route};
use crate::state::{state, FrameFormat};
use crate::{bmp, timing, tlog};

const ORIGINS: [&str; 5] = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://127.0.0.1:1420",
    "http://localhost:1420",
];

type Reply = Response<Cow<'static, [u8]>>;

fn reply(
    status: StatusCode,
    content_type: &str,
    cache: &str,
    origin: Option<&str>,
    body: Vec<u8>,
) -> Reply {
    let mut b = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache)
        .header("X-Content-Type-Options", "nosniff");
    if let Some(o) = origin.filter(|o| ORIGINS.contains(o)) {
        b = b
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, o)
            .header(header::VARY, "Origin")
            .header("Cross-Origin-Resource-Policy", "cross-origin");
    }
    b.body(Cow::Owned(body)).unwrap_or_else(|_| {
        let mut r = Response::new(Cow::Borrowed(&b""[..]));
        *r.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        r
    })
}

fn not_found(origin: Option<&str>) -> Reply {
    reply(
        StatusCode::NOT_FOUND,
        "text/plain; charset=utf-8",
        "no-store",
        origin,
        b"not found".to_vec(),
    )
}

pub fn handle(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let label = ctx.webview_label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(serve(&app, &label, &request));
    });
}

fn serve(app: &AppHandle, label: &str, request: &Request<Vec<u8>>) -> Reply {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    let head_only = request.method() == Method::HEAD;
    if request.method() == Method::OPTIONS {
        return reply(
            StatusCode::NO_CONTENT,
            "text/plain",
            "no-store",
            origin,
            Vec::new(),
        );
    }
    if request.method() != Method::GET && !head_only {
        return reply(
            StatusCode::METHOD_NOT_ALLOWED,
            "text/plain",
            "no-store",
            origin,
            Vec::new(),
        );
    }
    let Some(route) = parse_route(request.uri().path()) else {
        return not_found(origin);
    };
    if !allowed(&route, label) {
        return reply(
            StatusCode::FORBIDDEN,
            "text/plain; charset=utf-8",
            "no-store",
            origin,
            b"forbidden".to_vec(),
        );
    }
    let found = match route {
        Route::Frame(n) => serve_frame(app, n),
        Route::Capture(id) => serve_capture(app, id),
        Route::History(id) => serve_png_file(app, id, false),
        Route::Thumb(id) => serve_png_file(app, id, true),
    };
    match found {
        Some((ctype, cache, body)) => {
            let body = if head_only { Vec::new() } else { body };
            reply(StatusCode::OK, ctype, cache, origin, body)
        }
        None => not_found(origin),
    }
}

type Found = Option<(&'static str, &'static str, Vec<u8>)>;

const NO_STORE: &str = "no-store";
const IMMUTABLE: &str = "private, max-age=31536000, immutable";

fn serve_frame(app: &AppHandle, monitor: usize) -> Found {
    let st = state(app);
    let frame = {
        let guard = st.session.lock().ok()?;
        guard.as_ref()?.frames.get(monitor)?.clone()
    };
    match st.frame_format {
        FrameFormat::Bmp => Some(("image/bmp", NO_STORE, frame.buf.clone())),
        FrameFormat::Png => {
            // Benchmark-only path (POLISHOT_FRAME_FORMAT=png).
            let t = std::time::Instant::now();
            let rgba = crate::geometry::crop_to_rgba(
                frame.pixels(),
                frame.width,
                crate::geometry::IRect::new(0, 0, frame.width as i32, frame.height as i32),
                true,
                true,
            );
            let png = imgio::encode_png_fast(frame.width, frame.height, &rgba).ok()?;
            tlog!(
                "frame png encode {:.1} ms ({} bytes)",
                timing::ms(t),
                png.len()
            );
            Some(("image/png", NO_STORE, png))
        }
    }
}

fn serve_capture(app: &AppHandle, id: &str) -> Found {
    let st = state(app);
    let capture = {
        let mut store = st.store.lock().ok()?;
        store.get(id)
    };
    let capture = match capture {
        Some(c) => c,
        None => return serve_png_file(app, id, false),
    };
    if let Some(png) = capture.png() {
        return Some(("image/png", IMMUTABLE, png.as_ref().clone()));
    }
    if capture.opaque {
        let bmp = bmp::from_rgba(capture.meta.width, capture.meta.height, &capture.rgba);
        return Some(("image/bmp", NO_STORE, bmp));
    }
    let png =
        imgio::encode_png_fast(capture.meta.width, capture.meta.height, &capture.rgba).ok()?;
    capture.set_png(std::sync::Arc::new(png.clone()));
    Some(("image/png", NO_STORE, png))
}

fn serve_png_file(app: &AppHandle, id: &str, thumb: bool) -> Found {
    let st = state(app);
    let path = if thumb {
        st.paths.thumb_file(id)?
    } else {
        st.paths.capture_file(id)?
    };
    let bytes = std::fs::read(path).ok()?;
    Some(("image/png", IMMUTABLE, bytes))
}
