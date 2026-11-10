//! In-memory captures (an LRU bounded by count and bytes) and the frozen monitor frames.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::bmp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Region,
    Window,
    File,
    Clipboard,
    Scroll,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Region => "region",
            Source::Window => "window",
            Source::File => "file",
            Source::Clipboard => "clipboard",
            Source::Scroll => "scroll",
        }
    }

    /// Unknown values map to `Region` so old database rows never fail to load.
    pub fn parse(s: &str) -> Source {
        match s {
            "window" => Source::Window,
            "file" => Source::File,
            "clipboard" => Source::Clipboard,
            "scroll" => Source::Scroll,
            _ => Source::Region,
        }
    }
}

/// `CaptureMeta` from CONTRACTS section 5. `createdAt` is Unix epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMeta {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub created_at: u64,
    pub source: Source,
}

/// A stored capture. Pixels are RGBA, tightly packed.
pub struct Capture {
    pub meta: CaptureMeta,
    pub rgba: Vec<u8>,
    /// True when every pixel is opaque (so a BMP may represent it exactly).
    pub opaque: bool,
    /// PNG bytes once encoded (done off the hot path).
    png: Mutex<Option<Arc<Vec<u8>>>>,
}

impl Capture {
    pub fn new(meta: CaptureMeta, rgba: Vec<u8>, opaque: bool) -> Self {
        Self {
            meta,
            rgba,
            opaque,
            png: Mutex::new(None),
        }
    }

    pub fn bytes(&self) -> usize {
        self.rgba.len()
    }

    pub fn png(&self) -> Option<Arc<Vec<u8>>> {
        self.png.lock().ok().and_then(|g| g.clone())
    }

    pub fn set_png(&self, png: Arc<Vec<u8>>) {
        if let Ok(mut g) = self.png.lock() {
            *g = Some(png);
        }
    }
}

/// LRU of captures. The most recently inserted/read capture is never evicted.
pub struct CaptureStore {
    max_items: usize,
    max_bytes: usize,
    bytes: usize,
    map: HashMap<String, Arc<Capture>>,
    order: VecDeque<String>, // front = least recently used
}

impl CaptureStore {
    pub fn new(max_items: usize, max_bytes: usize) -> Self {
        Self {
            max_items: max_items.max(1),
            max_bytes,
            bytes: 0,
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn touch(&mut self, id: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == id) {
            if let Some(k) = self.order.remove(pos) {
                self.order.push_back(k);
            }
        }
    }

    pub fn insert(&mut self, capture: Arc<Capture>) {
        let id = capture.meta.id.clone();
        if let Some(old) = self.map.remove(&id) {
            self.bytes -= old.bytes();
            self.order.retain(|k| k != &id);
        }
        self.bytes += capture.bytes();
        self.map.insert(id.clone(), capture);
        self.order.push_back(id);
        while self.order.len() > 1
            && (self.order.len() > self.max_items || self.bytes > self.max_bytes)
        {
            if let Some(oldest) = self.order.pop_front() {
                if let Some(c) = self.map.remove(&oldest) {
                    self.bytes -= c.bytes();
                }
            }
        }
    }

    pub fn get(&mut self, id: &str) -> Option<Arc<Capture>> {
        let found = self.map.get(id).cloned();
        if found.is_some() {
            self.touch(id);
        }
        found
    }

    pub fn remove(&mut self, id: &str) {
        if let Some(c) = self.map.remove(id) {
            self.bytes -= c.bytes();
            self.order.retain(|k| k != id);
        }
    }

    pub fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
        self.bytes = 0;
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

/// A frozen monitor frame. `buf` already holds the BMP header followed by BGRX pixels, so it can
/// be served as-is with no copy or encode step.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub buf: Vec<u8>,
}

impl Frame {
    /// Allocate a frame whose pixel area is still zeroed; fill it through [`Frame::pixels_mut`].
    pub fn blank(width: u32, height: u32) -> Self {
        let mut buf = vec![0u8; bmp::HEADER_LEN + width as usize * height as usize * 4];
        bmp::write_header(&mut buf, width, height);
        Self { width, height, buf }
    }

    pub fn from_bgra(width: u32, height: u32, bgra: &[u8]) -> Result<Self, String> {
        if bgra.len() != width as usize * height as usize * 4 {
            return Err("Screen grab returned an unexpected buffer size.".to_string());
        }
        let mut f = Self::blank(width, height);
        f.pixels_mut().copy_from_slice(bgra);
        Ok(f)
    }

    pub fn pixels(&self) -> &[u8] {
        &self.buf[bmp::HEADER_LEN..]
    }

    pub fn pixels_mut(&mut self) -> &mut [u8] {
        &mut self.buf[bmp::HEADER_LEN..]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(id: &str, bytes: usize) -> Arc<Capture> {
        Arc::new(Capture::new(
            CaptureMeta {
                id: id.to_string(),
                width: 1,
                height: 1,
                created_at: 0,
                source: Source::Region,
            },
            vec![0; bytes],
            true,
        ))
    }

    #[test]
    fn evicts_least_recently_used_by_count() {
        let mut s = CaptureStore::new(3, usize::MAX);
        for id in ["a", "b", "c"] {
            s.insert(cap(id, 4));
        }
        assert!(s.get("a").is_some()); // a becomes most recent; b is now oldest
        s.insert(cap("d", 4));
        assert!(s.get("b").is_none());
        assert!(s.get("a").is_some() && s.get("c").is_some() && s.get("d").is_some());
        assert_eq!(s.len(), 3);
    }

    #[test]
    fn evicts_by_bytes_but_keeps_the_newest() {
        let mut s = CaptureStore::new(100, 100);
        s.insert(cap("a", 60));
        s.insert(cap("b", 60));
        assert!(s.get("a").is_none());
        assert!(s.get("b").is_some());
        // A single capture larger than the budget is still kept.
        s.insert(cap("huge", 500));
        assert!(s.get("huge").is_some());
        assert_eq!(s.len(), 1);
        assert_eq!(s.bytes(), 500);
    }

    #[test]
    fn replace_and_remove_keep_accounting_correct() {
        let mut s = CaptureStore::new(10, usize::MAX);
        s.insert(cap("a", 10));
        s.insert(cap("a", 30));
        assert_eq!(s.bytes(), 30);
        assert_eq!(s.len(), 1);
        s.remove("a");
        assert_eq!(s.bytes(), 0);
        assert!(s.is_empty());
        s.insert(cap("x", 5));
        s.clear();
        assert_eq!((s.len(), s.bytes()), (0, 0));
    }

    #[test]
    fn frame_header_and_pixels() {
        let f = Frame::from_bgra(2, 1, &[1, 2, 3, 0, 4, 5, 6, 0]).unwrap();
        assert_eq!(f.pixels(), &[1, 2, 3, 0, 4, 5, 6, 0]);
        assert_eq!(&f.buf[0..2], b"BM");
        assert!(Frame::from_bgra(2, 2, &[0; 4]).is_err());
    }

    #[test]
    fn png_cache() {
        let c = cap("p", 4);
        assert!(c.png().is_none());
        c.set_png(Arc::new(vec![1, 2, 3]));
        assert_eq!(c.png().unwrap().as_slice(), &[1, 2, 3]);
    }

    #[test]
    fn source_text_round_trip() {
        for s in [
            Source::Region,
            Source::Window,
            Source::File,
            Source::Clipboard,
            Source::Scroll,
        ] {
            assert_eq!(Source::parse(s.as_str()), s);
        }
        assert_eq!(Source::parse("garbage"), Source::Region);
    }

    #[test]
    fn source_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&Source::Clipboard).unwrap(),
            "\"clipboard\""
        );
        let m = CaptureMeta {
            id: "i".into(),
            width: 2,
            height: 3,
            created_at: 7,
            source: Source::Window,
        };
        assert_eq!(
            serde_json::to_string(&m).unwrap(),
            r#"{"id":"i","width":2,"height":3,"createdAt":7,"source":"window"}"#
        );
    }
}
