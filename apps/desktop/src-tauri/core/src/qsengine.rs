//! Quick send engine: pair a phone once (compare a six-digit code), then send images over the
//! local network, end to end encrypted. The protocol lives in `polishot-quicksend`; this module
//! owns the listener, discovery, persistence and the events the UI reacts to.
//!
//! It is independent of Tauri: everything it needs from the app (events to the main window,
//! bringing that window forward, registering a received image as a capture) goes through
//! [`Host`], so the whole IPC behaviour is tested here over loopback sockets.
//!
//! Nothing starts until the feature is used. Discovery advertises this PC only while it can
//! usefully be reached: a device is paired, or the pairing dialog is open.
//!
//! Events (to the main window): `qs:devices`, `qs:pair-code`, `qs:incoming`, `qs:received`.

use std::collections::HashMap;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use polishot_quicksend::discovery::{Advertiser, Browser, PeerEvent};
use polishot_quicksend::{
    clean_device_name, pair_initiator, send_file, serve, Config, FileMeta, Identity, Incoming,
    OfferInfo, PairRecord, PairingRateLimiter, PendingPairing, ReceivedFile, ServeConfig,
    MAX_FILE_SIZE,
};
use serde::Serialize;

use crate::imgio;
use crate::qspeers::{find_device_id, DeviceEntry, PeerTable};
use crate::qsstore::QsStore;
use crate::store::CaptureMeta;
use crate::tlog;

pub const EVENT_DEVICES: &str = "qs:devices";
pub const EVENT_PAIR_CODE: &str = "qs:pair-code";
pub const EVENT_INCOMING: &str = "qs:incoming";
pub const EVENT_RECEIVED: &str = "qs:received";

const MAX_CONCURRENT_CONNECTIONS: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a sender waits for us (the protocol's own limit is 60 s); answer before that.
const INCOMING_DECISION: Duration = Duration::from_secs(55);
/// A pairing screen that is forgotten about closes itself.
const PAIRING_WINDOW: Duration = Duration::from_secs(300);
const PENDING_PAIRING_TTL: Duration = Duration::from_secs(90);
/// Pairing attempts served per minute (protocol section 8).
const PAIRING_ATTEMPTS_PER_MINUTE: usize = 5;

/// What the engine needs from the app around it.
pub trait Host: Send + Sync + 'static {
    /// Send an event to the main window.
    fn emit(&self, event: &str, payload: serde_json::Value);
    /// Bring the main window forward: a prompt or a received image is waiting for the user.
    fn show_window(&self);
    /// Register decoded RGBA pixels as a new capture (history, OCR, preview protocol).
    fn register_image(&self, width: u32, height: u32, rgba: Vec<u8>) -> CaptureMeta;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PairRole {
    Initiator,
    Responder,
}

/// Payload of `qs:pair-code` and the result of `qs_pair_start`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairCode {
    /// Six digits grouped for reading, e.g. `"042 917"`. Compare it with the other screen.
    pub sas: String,
    pub peer_name: String,
    pub peer_id: String,
    pub role: PairRole,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IncomingPrompt {
    request_id: u64,
    peer_name: String,
    name: String,
    mime: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Received {
    meta: CaptureMeta,
    peer_name: String,
}

struct Pending {
    pairing: PendingPairing<TcpStream>,
    created: Instant,
}

pub struct QuickSend {
    host: Arc<dyn Host>,
    store: QsStore,
    identity: Identity,
    name: String,
    pairs: RwLock<Vec<PairRecord>>,
    table: Mutex<PeerTable>,
    pairing_open_until: Mutex<Option<Instant>>,
    limiter: PairingRateLimiter,
    pending: Mutex<Option<Pending>>,
    incoming: Mutex<HashMap<u64, Sender<bool>>>,
    next_request: AtomicU64,
    active_connections: AtomicUsize,
    stopped: AtomicBool,
    /// Port of the listener once it runs (0 before).
    port: AtomicU16,
    /// Whether mDNS advertising is wanted at all (off in tests).
    discovery: bool,
    // Dropping the advertiser unregisters the mDNS service.
    advertiser: Mutex<Option<Advertiser>>,
}

/// `"042917"` -> `"042 917"`.
pub fn group_sas(sas: &str) -> String {
    if sas.len() == 6 && sas.bytes().all(|b| b.is_ascii_digit()) {
        format!("{} {}", &sas[..3], &sas[3..])
    } else {
        sas.to_string()
    }
}

/// Validate the shape of a device id received over IPC (16 base32 characters; lower case is
/// accepted and normalised to upper case, as docs/QUICKSEND.md section 3 requires of parsers).
pub fn parse_device_text(text: &str) -> Result<String, String> {
    let upper = text.to_ascii_uppercase();
    if upper.len() == 16
        && upper
            .bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
    {
        Ok(upper)
    } else {
        Err("Invalid device id.".to_string())
    }
}

/// Display name of this PC, as other devices see it.
pub fn local_name_from(raw: &str) -> String {
    if raw.trim().is_empty() {
        "Windows PC".to_string()
    } else {
        clean_device_name(raw)
    }
}

impl QuickSend {
    /// Load the identity and pair records. No network yet: call [`QuickSend::serve_on`] (and
    /// [`QuickSend::start_discovery`]) next.
    pub fn new(
        host: Arc<dyn Host>,
        store: QsStore,
        name: String,
        discovery: bool,
    ) -> Result<Arc<QuickSend>, String> {
        let identity = store.load_or_create_identity()?;
        let pairs = store.load_pairs();
        Ok(Arc::new(QuickSend {
            host,
            store,
            identity,
            name,
            pairs: RwLock::new(pairs),
            table: Mutex::new(PeerTable::default()),
            pairing_open_until: Mutex::new(None),
            limiter: PairingRateLimiter::new(PAIRING_ATTEMPTS_PER_MINUTE, Duration::from_secs(60)),
            pending: Mutex::new(None),
            incoming: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(1),
            active_connections: AtomicUsize::new(0),
            stopped: AtomicBool::new(false),
            port: AtomicU16::new(0),
            discovery,
            advertiser: Mutex::new(None),
        }))
    }

    /// Production start: bind the listener (this triggers the Windows Firewall prompt on first
    /// use), browse for devices and advertise when it makes sense.
    pub fn start(
        host: Arc<dyn Host>,
        store: QsStore,
        name: String,
    ) -> Result<Arc<QuickSend>, String> {
        let q = Self::new(host, store, name, true)?;
        let listener = TcpListener::bind(("0.0.0.0", 0))
            .map_err(|_| "Quick send could not open a network port.".to_string())?;
        let browser = Browser::start(q.identity.id())
            .map_err(|_| "Quick send could not look for devices.".to_string())?;
        q.serve_on(listener)?;
        q.refresh_advertising();
        let browse = q.clone();
        std::thread::spawn(move || browse.browse_loop(&browser));
        tlog!("quick send listening");
        Ok(q)
    }

    /// Accept connections on `listener` from a background thread.
    pub fn serve_on(self: &Arc<Self>, listener: TcpListener) -> Result<(), String> {
        let port = listener
            .local_addr()
            .map_err(|_| "Quick send could not open a network port.".to_string())?
            .port();
        self.port.store(port, Ordering::SeqCst);
        let accept = self.clone();
        std::thread::spawn(move || accept.accept_loop(&listener));
        Ok(())
    }

    /// This device's id in text form (16 base32 characters).
    pub fn id_text(&self) -> String {
        self.identity.id().to_string()
    }

    /// Stop accepting work and stop advertising.
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Ok(mut a) = self.advertiser.lock() {
            *a = None;
        }
    }

    fn emit<S: Serialize>(&self, event: &str, payload: S) {
        let value = serde_json::to_value(payload).unwrap_or(serde_json::Value::Null);
        self.host.emit(event, value);
    }

    // ---- discovery ----------------------------------------------------------------------------

    fn browse_loop(&self, browser: &Browser) {
        while !self.stopped.load(Ordering::Relaxed) {
            match browser.next_event(Duration::from_secs(1)) {
                Ok(Some(ev)) => {
                    self.apply_peer_event(ev);
                }
                Ok(None) => {}
                Err(_) => break,
            }
            // The pairing window may have run out since the last tick.
            self.refresh_advertising();
        }
    }

    /// Apply a discovery event; tells the UI when the device list changed.
    pub fn apply_peer_event(&self, ev: PeerEvent) -> bool {
        let changed = self.table.lock().is_ok_and(|mut t| t.apply(ev));
        if changed {
            self.emit(EVENT_DEVICES, ());
        }
        changed
    }

    /// Advertise only while somebody can usefully reach this PC: a device is paired (it may send
    /// at any time) or the pairing dialog is open. Otherwise the service is withdrawn, so a PC
    /// that merely opened the device list is not announced to everyone on the network.
    fn refresh_advertising(&self) {
        if !self.discovery {
            return;
        }
        let want = self.pairs.read().is_ok_and(|p| !p.is_empty()) || self.pairing_open();
        let port = self.port.load(Ordering::SeqCst);
        let Ok(mut slot) = self.advertiser.lock() else {
            return;
        };
        match (want && port != 0, slot.is_some()) {
            (true, false) => {
                *slot = Advertiser::start(&self.identity.id(), &self.name, port).ok();
            }
            (false, true) => *slot = None,
            _ => {}
        }
    }

    /// Whether the service is currently advertised (diagnostics and tests).
    pub fn advertising(&self) -> bool {
        self.advertiser.lock().is_ok_and(|a| a.is_some())
    }

    pub fn devices(&self) -> Vec<DeviceEntry> {
        let pairs = self.pairs.read().map(|p| p.clone()).unwrap_or_default();
        self.table
            .lock()
            .map(|t| t.devices(&pairs))
            .unwrap_or_default()
    }

    // ---- pairing mode -------------------------------------------------------------------------

    /// Open or close the window in which other devices may pair with this PC.
    pub fn set_pairing_open(&self, open: bool) {
        if let Ok(mut g) = self.pairing_open_until.lock() {
            *g = open.then(|| Instant::now() + PAIRING_WINDOW);
        }
        self.refresh_advertising();
    }

    pub fn pairing_open(&self) -> bool {
        self.pairing_open_until
            .lock()
            .is_ok_and(|g| g.is_some_and(|t| Instant::now() < t))
    }

    // ---- inbound ------------------------------------------------------------------------------

    fn accept_loop(self: &Arc<Self>, listener: &TcpListener) {
        for conn in listener.incoming() {
            if self.stopped.load(Ordering::Relaxed) {
                break;
            }
            let Ok(stream) = conn else { continue };
            if self.active_connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONCURRENT_CONNECTIONS
            {
                self.active_connections.fetch_sub(1, Ordering::SeqCst);
                continue; // drop the connection: too many at once
            }
            let me = self.clone();
            std::thread::spawn(move || {
                me.handle(stream);
                me.active_connections.fetch_sub(1, Ordering::SeqCst);
            });
        }
    }

    fn handle(&self, stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        let pairs = self.pairs.read().map(|p| p.clone()).unwrap_or_default();
        let sc = ServeConfig {
            identity: &self.identity,
            local_name: &self.name,
            pairs: &pairs,
            allow_pairing: self.pairing_open(),
            rate_limiter: Some(&self.limiter),
            config: Config::default(),
        };
        match serve(stream, &sc, |offer| self.ask_user(offer)) {
            Ok(Incoming::Pairing(p)) => self.set_pending(*p, PairRole::Responder),
            Ok(Incoming::Received(file)) => self.handle_received(file, &pairs),
            Err(e) => tlog!("quick send connection ended: {:?}", e.code()),
        }
    }

    /// Ask the user about an incoming file and wait for the answer (declines on timeout). The
    /// main window is usually hidden in the tray, so it is brought forward first: otherwise the
    /// prompt would be invisible and the sender would simply time out.
    fn ask_user(&self, offer: &OfferInfo) -> bool {
        let id = self.next_request.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel::<bool>();
        if let Ok(mut m) = self.incoming.lock() {
            m.insert(id, tx);
        }
        self.host.show_window();
        self.emit(
            EVENT_INCOMING,
            IncomingPrompt {
                request_id: id,
                peer_name: offer.peer_name.clone(),
                name: offer.name.clone(),
                mime: offer.mime.clone(),
                size: offer.size,
            },
        );
        let accepted = rx.recv_timeout(INCOMING_DECISION).unwrap_or(false);
        if let Ok(mut m) = self.incoming.lock() {
            m.remove(&id);
        }
        accepted
    }

    /// The user's answer to a `qs:incoming` prompt. Unknown or already answered ids are ignored.
    pub fn respond(&self, request_id: u64, accept: bool) {
        let tx = self
            .incoming
            .lock()
            .ok()
            .and_then(|mut m| m.remove(&request_id));
        if let Some(tx) = tx {
            let _ = tx.send(accept);
        }
    }

    fn handle_received(&self, file: ReceivedFile, pairs: &[PairRecord]) {
        let peer_name = pairs
            .iter()
            .find(|r| r.peer_id == file.peer_id)
            .map(|r| r.peer_name.clone())
            .unwrap_or_default();
        // The bytes come from the network: decode them like any untrusted image.
        let decoded = match imgio::decode_limited(&file.data) {
            Ok(d) => d,
            Err(e) => {
                tlog!("received image rejected: {e}");
                return;
            }
        };
        let meta = self
            .host
            .register_image(decoded.width, decoded.height, decoded.rgba);
        self.host.show_window();
        self.emit(EVENT_RECEIVED, Received { meta, peer_name });
    }

    // ---- pairing ------------------------------------------------------------------------------

    fn set_pending(&self, pairing: PendingPairing<TcpStream>, role: PairRole) {
        let code = PairCode {
            sas: group_sas(pairing.sas()),
            peer_name: pairing.peer_name().to_string(),
            peer_id: pairing.peer_id().to_string(),
            role,
        };
        if let Ok(mut p) = self.pending.lock() {
            *p = Some(Pending {
                pairing,
                created: Instant::now(),
            });
        }
        self.host.show_window();
        self.emit(EVENT_PAIR_CODE, code);
    }

    /// Dial a visible device and start pairing as the initiator. Blocks until the code is known.
    pub fn pair_start(&self, device_id: &str) -> Result<PairCode, String> {
        let (id, addrs) = {
            let pairs = self.pairs.read().map(|p| p.clone()).unwrap_or_default();
            let table = self
                .table
                .lock()
                .map_err(|_| "Quick send is busy.".to_string())?;
            let id = find_device_id(device_id, &pairs, &table)
                .ok_or("That device is not visible on the network.")?;
            let addrs = table
                .addrs(&id)
                .ok_or("That device is not visible on the network.")?;
            (id, addrs)
        };
        let stream = connect(&addrs)?;
        let pairing =
            pair_initiator(stream, &self.identity, &self.name).map_err(|e| e.to_string())?;
        if pairing.peer_id() != id {
            return Err("That device did not match the one you picked.".to_string());
        }
        let code = PairCode {
            sas: group_sas(pairing.sas()),
            peer_name: pairing.peer_name().to_string(),
            peer_id: pairing.peer_id().to_string(),
            role: PairRole::Initiator,
        };
        if let Ok(mut p) = self.pending.lock() {
            *p = Some(Pending {
                pairing,
                created: Instant::now(),
            });
        }
        self.emit(EVENT_PAIR_CODE, code.clone());
        Ok(code)
    }

    /// Finish the pending pairing with the user's answer to "do both screens show this code?".
    pub fn pair_confirm(&self, accepted: bool) -> Result<DeviceEntry, String> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| "Quick send is busy.".to_string())?
            .take()
            .filter(|p| p.created.elapsed() < PENDING_PAIRING_TTL)
            .ok_or("There is no pairing in progress. Start again.")?;
        let record = pending
            .pairing
            .confirm(accepted)
            .map_err(|e| e.to_string())?;
        self.store.save_pair(&record)?;
        let entry = DeviceEntry {
            id: record.peer_id.to_string(),
            name: record.peer_name.clone(),
            paired: true,
            online: true,
        };
        if let Ok(mut pairs) = self.pairs.write() {
            pairs.retain(|r| r.peer_id != record.peer_id);
            pairs.push(record);
        }
        self.set_pairing_open(false);
        self.emit(EVENT_DEVICES, ());
        Ok(entry)
    }

    pub fn forget(&self, device_id: &str) -> Result<(), String> {
        let id = {
            let pairs = self
                .pairs
                .read()
                .map_err(|_| "Quick send is busy.".to_string())?;
            pairs
                .iter()
                .map(|r| r.peer_id)
                .find(|id| id.to_string() == device_id)
                .ok_or("That device is not paired.")?
        };
        self.store.remove_pair(&id)?;
        if let Ok(mut pairs) = self.pairs.write() {
            pairs.retain(|r| r.peer_id != id);
        }
        self.refresh_advertising();
        self.emit(EVENT_DEVICES, ());
        Ok(())
    }

    // ---- outbound -----------------------------------------------------------------------------

    /// Send PNG bytes to a paired device that is currently visible.
    pub fn send_png(&self, device_id: &str, file_name: &str, png: &[u8]) -> Result<(), String> {
        if png.len() as u64 > MAX_FILE_SIZE {
            return Err("That image is too large to send (limit 50 MB).".to_string());
        }
        if !crate::ids::content_matches_ext(png, "png") {
            return Err("Only PNG images can be sent.".to_string());
        }
        let (record, addrs): (PairRecord, _) = {
            let pairs = self
                .pairs
                .read()
                .map_err(|_| "Quick send is busy.".to_string())?;
            let record = pairs
                .iter()
                .find(|r| r.peer_id.to_string() == device_id)
                .cloned()
                .ok_or("That device is not paired.")?;
            let table = self
                .table
                .lock()
                .map_err(|_| "Quick send is busy.".to_string())?;
            let addrs = table
                .addrs(&record.peer_id)
                .ok_or("That device is not on this network right now.")?;
            (record, addrs)
        };
        let stream = connect(&addrs)?;
        send_file(
            stream,
            &self.identity,
            &record,
            &FileMeta::new(file_name, "image/png"),
            png,
        )
        .map_err(|e| e.to_string())
    }
}

fn connect(addrs: &[SocketAddr]) -> Result<TcpStream, String> {
    for addr in addrs {
        if let Ok(s) = TcpStream::connect_timeout(addr, CONNECT_TIMEOUT) {
            let _ = s.set_nodelay(true);
            return Ok(s);
        }
    }
    Err("Could not reach that device. Check that both are on the same Wi-Fi network.".to_string())
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::mpsc::{channel, Receiver};

    use polishot_quicksend::discovery::Peer;

    use super::*;
    use crate::store::Source;

    /// A fake app: records events and registered images.
    struct TestHost {
        events: Mutex<Sender<(String, serde_json::Value)>>,
        shown: AtomicUsize,
        images: Mutex<Vec<(u32, u32)>>,
    }

    impl Host for TestHost {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            let _ = self
                .events
                .lock()
                .unwrap()
                .send((event.to_string(), payload));
        }
        fn show_window(&self) {
            self.shown.fetch_add(1, Ordering::SeqCst);
        }
        fn register_image(&self, width: u32, height: u32, _rgba: Vec<u8>) -> CaptureMeta {
            self.images.lock().unwrap().push((width, height));
            CaptureMeta {
                id: "recv-1".to_string(),
                width,
                height,
                created_at: 1_700_000_000_000,
                source: Source::File,
            }
        }
    }

    struct Node {
        q: Arc<QuickSend>,
        host: Arc<TestHost>,
        events: Receiver<(String, serde_json::Value)>,
        port: u16,
        dir: std::path::PathBuf,
    }

    impl Drop for Node {
        fn drop(&mut self) {
            self.q.shutdown();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn node(name: &str) -> Node {
        let dir = std::env::temp_dir().join(format!("ps-qs-{}", crate::ids::new_id()));
        let (tx, events) = channel();
        let host = Arc::new(TestHost {
            events: Mutex::new(tx),
            shown: AtomicUsize::new(0),
            images: Mutex::new(Vec::new()),
        });
        let q = QuickSend::new(host.clone(), QsStore::new(&dir), name.to_string(), false).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        q.serve_on(listener).unwrap();
        Node {
            q,
            host,
            events,
            port,
            dir,
        }
    }

    /// Make `a` see `b` on the (loopback) network.
    fn introduce(a: &Node, b: &Node) {
        let peer = Peer {
            id: b.q.identity.id(),
            name: "Advertised name".to_string(),
            version: 1,
            port: b.port,
            addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
        };
        assert!(a.q.apply_peer_event(PeerEvent::Found(peer)));
    }

    fn wait_for(n: &Node, event: &str) -> serde_json::Value {
        loop {
            let (name, payload) = n
                .events
                .recv_timeout(Duration::from_secs(20))
                .unwrap_or_else(|_| panic!("timed out waiting for {event}"));
            if name == event {
                return payload;
            }
        }
    }

    fn png() -> Vec<u8> {
        let rgba: Vec<u8> = (0..4 * 4 * 4).map(|i| (i * 3) as u8).collect();
        imgio::encode_png_fast(4, 4, &rgba).unwrap()
    }

    /// Pair `a` (initiator) with `b` (responder) and return the SAS both showed.
    fn pair(a: &Node, b: &Node) -> String {
        introduce(a, b);
        introduce(b, a);
        b.q.set_pairing_open(true);
        let code = a.q.pair_start(&b.q.id_text()).expect("pair_start");
        assert_eq!(code.role, PairRole::Initiator);
        assert_eq!(code.peer_id, b.q.id_text());
        let seen_by_b = wait_for(b, EVENT_PAIR_CODE);
        assert_eq!(seen_by_b["role"], "responder");
        assert_eq!(
            seen_by_b["sas"], code.sas,
            "both screens show the same code"
        );
        assert_eq!(seen_by_b["peerId"], a.q.id_text());
        // Both users confirm; each side waits for the other, so run them together.
        let (qa, qb) = (a.q.clone(), b.q.clone());
        let tb = std::thread::spawn(move || qb.pair_confirm(true));
        let ra = qa.pair_confirm(true).expect("initiator confirm");
        let rb = tb.join().unwrap().expect("responder confirm");
        assert!(ra.paired && rb.paired);
        assert_eq!(ra.id, b.q.id_text());
        assert_eq!(rb.id, a.q.id_text());
        code.sas
    }

    #[test]
    fn device_text_validation() {
        assert_eq!(
            parse_device_text("MFRGGZDFMZTWQ2LK"),
            Ok("MFRGGZDFMZTWQ2LK".to_string())
        );
        // Lower case is accepted and normalised.
        assert_eq!(
            parse_device_text("mfrggzdfmztwq2lk"),
            Ok("MFRGGZDFMZTWQ2LK".to_string())
        );
        for bad in [
            "",
            "MFRGGZDFMZTWQ2L", // 15
            "MFRGGZDFMZTWQ2LKA",
            "MFRGGZDFMZTWQ1LK", // 1 is not base32
            "MFRGGZDFMZTWQ2L!",
            "../../etc/passwd",
            "MFRGGZDFMZTWQ2L\0",
            "ÄFRGGZDFMZTWQ2LK",
        ] {
            assert!(parse_device_text(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn sas_grouping() {
        assert_eq!(group_sas("042917"), "042 917");
        assert_eq!(group_sas("000000"), "000 000");
        assert_eq!(group_sas("12345"), "12345");
        assert_eq!(group_sas("12a456"), "12a456");
    }

    #[test]
    fn a_blank_computer_name_falls_back() {
        assert_eq!(local_name_from(""), "Windows PC");
        assert_eq!(local_name_from("   "), "Windows PC");
        assert_eq!(local_name_from("STUDIO-PC"), "STUDIO-PC");
        assert_eq!(local_name_from("a\u{202e}b"), "ab");
    }

    #[test]
    fn pairing_then_sending_works_end_to_end_with_the_documented_events() {
        let a = node("Phone");
        let b = node("Studio PC");
        let sas = pair(&a, &b);
        assert_eq!(sas.len(), 7, "six digits and a space: {sas}");
        assert_eq!(sas.as_bytes()[3], b' ');

        // Persisted: a fresh store on the same folder sees the new records.
        assert_eq!(QsStore::new(&a.dir).load_pairs().len(), 1);
        assert_eq!(QsStore::new(&b.dir).load_pairs().len(), 1);
        // The pairing window closes once pairing finished.
        assert!(!b.q.pairing_open());
        // The device list now shows the peer as paired and online.
        let list = a.q.devices();
        assert_eq!(list.len(), 1);
        assert!(list[0].paired && list[0].online);
        assert_eq!(list[0].id, b.q.id_text());
        // `qs:devices` fired for the list change.
        wait_for(&a, EVENT_DEVICES);

        // Send: the receiver is asked first.
        let sender = {
            let (qa, id, bytes) = (a.q.clone(), b.q.id_text(), png());
            std::thread::spawn(move || qa.send_png(&id, "my shot.png", &bytes))
        };
        let prompt = wait_for(&b, EVENT_INCOMING);
        assert_eq!(prompt["peerName"], "Phone");
        assert_eq!(prompt["name"], "my shot.png");
        assert_eq!(prompt["mime"], "image/png");
        assert_eq!(prompt["size"], png().len());
        assert!(
            b.host.shown.load(Ordering::SeqCst) > 0,
            "the prompt must be visible"
        );
        let request_id = prompt["requestId"].as_u64().unwrap();
        b.q.respond(request_id, true);
        sender.join().unwrap().expect("send_png");

        let got = wait_for(&b, EVENT_RECEIVED);
        assert_eq!(got["peerName"], "Phone");
        assert_eq!(got["meta"]["id"], "recv-1");
        assert_eq!(got["meta"]["width"], 4);
        assert_eq!(got["meta"]["height"], 4);
        assert_eq!(got["meta"]["source"], "file");
        assert_eq!(*b.host.images.lock().unwrap(), vec![(4, 4)]);

        // A prompt answers once: repeating (or guessing) a request id does nothing.
        b.q.respond(request_id, true);
        b.q.respond(u64::MAX, true);
    }

    #[test]
    fn a_declined_file_is_reported_to_the_sender_and_nothing_is_registered() {
        let a = node("Phone");
        let b = node("Studio PC");
        pair(&a, &b);
        let sender = {
            let (qa, id, bytes) = (a.q.clone(), b.q.id_text(), png());
            std::thread::spawn(move || qa.send_png(&id, "x.png", &bytes))
        };
        let prompt = wait_for(&b, EVENT_INCOMING);
        b.q.respond(prompt["requestId"].as_u64().unwrap(), false);
        let err = sender.join().unwrap().expect_err("declined");
        assert!(!err.is_empty());
        assert!(b.host.images.lock().unwrap().is_empty());
    }

    #[test]
    fn only_png_and_only_up_to_the_limit_may_be_sent() {
        let a = node("Phone");
        assert!(a
            .q
            .send_png("AAAAAAAAAAAAAAAA", "x.png", b"not an image")
            .unwrap_err()
            .contains("PNG"));
        let too_big = vec![0u8; MAX_FILE_SIZE as usize + 1];
        assert!(a
            .q
            .send_png("AAAAAAAAAAAAAAAA", "x.png", &too_big)
            .unwrap_err()
            .contains("50 MB"));
        // Valid PNG, but the device is not paired.
        assert!(a
            .q
            .send_png("AAAAAAAAAAAAAAAA", "x.png", &png())
            .unwrap_err()
            .contains("not paired"));
    }

    #[test]
    fn pairing_is_refused_unless_the_user_opened_it_on_the_responder() {
        let a = node("Phone");
        let b = node("Studio PC");
        introduce(&a, &b);
        assert!(!b.q.pairing_open());
        let err =
            a.q.pair_start(&b.q.id_text())
                .expect_err("pairing is closed");
        assert!(!err.is_empty());
        assert!(a.q.devices().iter().all(|d| !d.paired));
        assert!(b.q.devices().is_empty());
    }

    #[test]
    fn rejecting_the_code_pairs_nobody() {
        let a = node("Phone");
        let b = node("Studio PC");
        introduce(&a, &b);
        b.q.set_pairing_open(true);
        a.q.pair_start(&b.q.id_text()).unwrap();
        wait_for(&b, EVENT_PAIR_CODE);
        let qb = b.q.clone();
        let tb = std::thread::spawn(move || qb.pair_confirm(true));
        // The initiator says the codes do not match.
        assert!(a.q.pair_confirm(false).is_err());
        assert!(tb.join().unwrap().is_err());
        assert!(QsStore::new(&a.dir).load_pairs().is_empty());
        assert!(QsStore::new(&b.dir).load_pairs().is_empty());
    }

    #[test]
    fn confirming_without_a_pairing_in_progress_is_an_error() {
        let a = node("Phone");
        assert!(a.q.pair_confirm(true).is_err());
    }

    #[test]
    fn forgetting_a_device_removes_it_everywhere() {
        let a = node("Phone");
        let b = node("Studio PC");
        pair(&a, &b);
        assert!(a.q.forget("AAAAAAAAAAAAAAAA").is_err(), "unknown device");
        a.q.forget(&b.q.id_text()).unwrap();
        assert!(QsStore::new(&a.dir).load_pairs().is_empty());
        assert!(a.q.devices().iter().all(|d| !d.paired));
        // Sending to a forgotten device fails before touching the network.
        assert!(a
            .q
            .send_png(&b.q.id_text(), "x.png", &png())
            .unwrap_err()
            .contains("not paired"));
        wait_for(&a, EVENT_DEVICES);
    }

    #[test]
    fn a_stranger_cannot_send_to_a_paired_pc() {
        let a = node("Phone");
        let b = node("Studio PC");
        pair(&a, &b);
        // C pairs with someone else entirely, then tries to reach B by id.
        let c = node("Stranger");
        let d = node("Other PC");
        pair(&c, &d);
        introduce(&c, &b);
        // C has no record for B, so it cannot even build a transfer.
        assert!(c
            .q
            .send_png(&b.q.id_text(), "x.png", &png())
            .unwrap_err()
            .contains("not paired"));
        assert!(b.host.images.lock().unwrap().is_empty());
    }

    #[test]
    fn pairing_window_controls_advertising_state_without_discovery() {
        // With discovery off (tests) advertising never starts; the open/close state still works.
        let a = node("Phone");
        assert!(!a.q.advertising());
        a.q.set_pairing_open(true);
        assert!(a.q.pairing_open());
        a.q.set_pairing_open(false);
        assert!(!a.q.pairing_open());
    }
}
