//! Platform logic for the Polishot desktop app.
//!
//! Everything here is independent of Tauri so that `cargo test` can run it as an ordinary
//! executable (test binaries that link Tauri/WebView need an application manifest to start).
//! The `polishot-desktop` crate is the thin Tauri shell around it.

pub mod bmp;
pub mod clipboard;
pub mod cropping;
pub mod export;
pub mod geometry;
pub mod gifrec;
pub mod grab;
pub mod history;
pub mod ids;
pub mod imgio;
pub mod jobs;
pub mod layout;
pub mod license;
pub mod ocr;
pub mod opener;
pub mod paths;
pub mod pinmath;
pub mod qsengine;
pub mod qspeers;
pub mod qsstore;
pub mod routes;
pub mod scroll;
pub mod secure;
pub mod settings;
pub mod store;
pub mod timing;
pub mod winsrc;
pub mod winutil;
