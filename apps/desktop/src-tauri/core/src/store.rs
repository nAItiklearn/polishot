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

/// Recycles the big buffers of frozen frames. Every hotkey allocates one 33 MB buffer per 4K
/// monitor; a fresh allocation is zero-filled by faulting in thousands of pages, which costs more
/// than copying the pixels into it. The buffers of the previous capture are kept for the next.
pub struct BufferPool {
    slots: Mutex<Vec<Vec<u8>>>,
    max_buffers: usize,
    max_bytes: usize,
}

/// Smaller buffers are cheap to allocate and not worth keeping.
const MIN_POOLED_BYTES: usize = 1 << 20;

impl BufferPool {
    pub const fn new(max_buffers: usize, max_bytes: usize) -> Self {
        Self {
            slots: Mutex::new(Vec::new()),
            max_buffers,
            max_bytes,
        }
    }

    /// A buffer of exactly `len` bytes with unspecified content, if one is kept.
    pub fn take(&self, len: usize) -> Option<Vec<u8>> {
        let mut slots = self.slots.lock().ok()?;
        let at = slots.iter().position(|b| b.len() == len)?;
        Some(slots.swap_remove(at))
    }

    /// Keep `buf` for reuse unless the pool is full or the buffer is small.
    pub fn give(&self, buf: Vec<u8>) {
        if buf.len() < MIN_POOLED_BYTES {
            return;
        }
        if let Ok(mut slots) = self.slots.lock() {
            let kept: usize = slots.iter().map(Vec::len).sum();
            if slots.len() < self.max_buffers && kept + buf.len() <= self.max_bytes {
                slots.push(buf);
            }
        }
    }

    #[cfg(test)]
    fn kept(&self) -> (usize, usize) {
        let slots = self.slots.lock().unwrap();
        (slots.len(), slots.iter().map(Vec::len).sum())
    }
}

/// Frame buffers of the last capture: two monitors' worth, never more than 80 MB.
static FRAME_BUFFERS: BufferPool = BufferPool::new(2, 80 << 20);

impl Drop for Frame {
    fn drop(&mut self) {
        FRAME_BUFFERS.give(std::mem::take(&mut self.buf));
    }
}

impl Frame {
    /// Allocate a frame whose pixel area is still zeroed; fill it through [`Frame::pixels_mut`].
    pub fn blank(width: u32, height: u32) -> Self {
        let mut f = Self::uninit(width, height);
        f.pixels_mut().fill(0);
        f
    }

    /// A frame with a valid header whose pixel area holds *whatever the recycled buffer held*.
    /// The caller must overwrite every pixel.
    fn uninit(width: u32, height: u32) -> Self {
        let len = bmp::HEADER_LEN + width as usize * height as usize * 4;
        let mut buf = FRAME_BUFFERS.take(len).unwrap_or_else(|| vec![0u8; len]);
        bmp::write_header(&mut buf, width, height);
        Self { width, height, buf }
    }

    pub fn from_bgra(width: u32, height: u32, bgra: &[u8]) -> Result<Self, String> {
        if bgra.len() != width as usize * height as usize * 4 {
            return Err("Screen grab returned an unexpected buffer size.".to_string());
        }
        // Every pixel is overwritten right below, so a recycled buffer needs no clearing.
        let mut f = Self::uninit(width, height);
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
    fn the_pool_reuses_exact_sizes_and_stays_small() {
        let pool = BufferPool::new(2, 5 << 20);
        let mb = |n: usize| vec![7u8; n << 20];
        assert!(pool.take(1 << 20).is_none());
        pool.give(vec![0u8; 1000]); // too small to keep
        assert_eq!(pool.kept(), (0, 0));
        pool.give(mb(2));
        pool.give(mb(2));
        pool.give(mb(1)); // a third buffer: over the count limit
        assert_eq!(pool.kept(), (2, 4 << 20));
        assert!(pool.take(3 << 20).is_none(), "only exact sizes are reused");
        let got = pool.take(2 << 20).expect("a 2 MB buffer");
        assert_eq!(got.len(), 2 << 20);
        assert_eq!(pool.kept(), (1, 2 << 20));
        // The byte limit holds too.
        pool.give(mb(4));
        assert_eq!(pool.kept(), (1, 2 << 20), "2 + 4 MB would exceed 5 MB");
    }

    #[test]
    fn recycled_frame_buffers_never_leak_old_pixels() {
        // blank() clears; from_bgra() overwrites everything; a stale pixel is never visible.
        let (w, h) = (700u32, 400u32); // 1.1 MB, large enough to be pooled
        let pixels = vec![9u8; (w * h * 4) as usize];
        let a = Frame::from_bgra(w, h, &pixels).unwrap();
        drop(a); // its buffer goes back to the pool
        let blank = Frame::blank(w, h);
        assert!(blank.pixels().iter().all(|&b| b == 0), "blank is zeroed");
        drop(blank);
        let other = vec![3u8; (w * h * 4) as usize];
        let b = Frame::from_bgra(w, h, &other).unwrap();
        assert!(b.pixels().iter().all(|&p| p == 3));
        assert_eq!(&b.buf[..2], b"BM", "the header is rewritten");
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
