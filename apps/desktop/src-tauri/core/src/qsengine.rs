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
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
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

/// Connections served at once, and per remote address. A phone needs one (two while a retry
/// overlaps a pairing screen); a LAN host holding sockets open must not starve it.
const MAX_CONNECTIONS: usize = 4;
const MAX_CONNECTIONS_PER_IP: usize = 2;
/// A peer that connects and then says nothing is dropped after this long (the protocol's own
/// handshake timeouts only start once the first byte has arrived).
const PRE_HELLO_TIMEOUT: Duration = Duration::from_secs(3);
/// The device list is announced to the UI at most this often, however busy mDNS is.
const DEVICE_EVENT_INTERVAL: Duration = Duration::from_millis(250);
/// Wait before looking for devices again after the mDNS browser stopped.
const BROWSE_RESTART_DELAY: Duration = Duration::from_secs(5);
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
    /// A non-fatal problem the user should read (shown with the other startup warnings).
    fn warn(&self, message: &str);
}

/// Whether a discovered address may be dialled. mDNS answers come from anyone on the network, so
/// an advertisement must not be able to point this PC at the internet or at some other internal
/// host: only private IPv4 ranges (10/8, 172.16/12, 192.168/16), link-local 169.254/16 and IPv6
/// unique-local fc00::/7 qualify. Loopback is allowed only when `allow_loopback` is set (tests).
pub fn is_lan_addr(ip: IpAddr, allow_loopback: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_private() || (o[0] == 169 && o[1] == 254) || (allow_loopback && v4.is_loopback())
        }
        IpAddr::V6(v6) => {
            // An IPv4-mapped address is judged as the IPv4 address it wraps.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_lan_addr(IpAddr::V4(v4), allow_loopback);
            }
            (v6.segments()[0] & 0xfe00) == 0xfc00 || (allow_loopback && v6.is_loopback())
        }
    }
}

/// True when `ip` lies inside `net`/`prefix` (same address family).
pub fn in_subnet(ip: IpAddr, net: IpAddr, prefix: u8) -> bool {
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(b)) => {
            let prefix = u32::from(prefix.min(32));
            let mask = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };
            u32::from(a) & mask == u32::from(b) & mask
        }
        (IpAddr::V6(a), IpAddr::V6(b)) => {
            let prefix = u32::from(prefix.min(128));
            let mask = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            u128::from(a) & mask == u128::from(b) & mask
        }
        _ => false,
    }
}

/// The addresses worth dialling: LAN-range addresses that are on one of this PC's own subnets
/// (`local` lists `(address, prefix length)` per network adapter). When the adapter list is
/// unknown (empty) only the range check applies.
pub fn dialable(
    addrs: &[SocketAddr],
    local: &[(IpAddr, u8)],
    allow_loopback: bool,
) -> Vec<SocketAddr> {
    addrs
        .iter()
        .copied()
        .filter(|a| is_lan_addr(a.ip(), allow_loopback))
        .filter(|a| {
            local.is_empty()
                || (allow_loopback && a.ip().is_loopback())
                || local
                    .iter()
                    .any(|(net, prefix)| in_subnet(a.ip(), *net, *prefix))
        })
        .collect()
}

/// Limits simultaneous connections, in total and per remote address.
pub struct ConnLimiter {
    max_total: usize,
    max_per_ip: usize,
    state: Mutex<(usize, HashMap<IpAddr, usize>)>,
}

/// Holds one connection slot; the slot is returned when this is dropped.
pub struct ConnPermit {
    limiter: Arc<ConnLimiter>,
    ip: IpAddr,
}

impl ConnLimiter {
    pub fn new(max_total: usize, max_per_ip: usize) -> Arc<Self> {
        Arc::new(Self {
            max_total,
            max_per_ip,
            state: Mutex::new((0, HashMap::new())),
        })
    }

    /// A slot for a connection from `ip`, or `None` when a limit is reached.
    pub fn acquire(self: &Arc<Self>, ip: IpAddr) -> Option<ConnPermit> {
        let mut g = self.state.lock().ok()?;
        let mine = g.1.get(&ip).copied().unwrap_or(0);
        if g.0 >= self.max_total || mine >= self.max_per_ip {
            return None;
        }
        g.0 += 1;
        g.1.insert(ip, mine + 1);
        Some(ConnPermit {
            limiter: self.clone(),
            ip,
        })
    }

    pub fn active(&self) -> usize {
        self.state.lock().map_or(0, |g| g.0)
    }
}

impl Drop for ConnPermit {
    fn drop(&mut self) {
        if let Ok(mut g) = self.limiter.state.lock() {
            g.0 = g.0.saturating_sub(1);
            if let Some(n) = g.1.get_mut(&self.ip) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    g.1.remove(&self.ip);
                }
            }
        }
    }
}

/// Addresses and prefix lengths of this PC's network adapters (empty if they cannot be read).
pub fn local_subnets() -> Vec<(IpAddr, u8)> {
    crate::winutil::local_subnets()
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
    conns: Arc<ConnLimiter>,
    /// Set once the pairing prompt has brought the window forward during this pairing window.
    window_shown: AtomicBool,
    stopped: AtomicBool,
    /// Port of the listener once it runs (0 before).
    port: AtomicU16,
    /// Whether mDNS advertising is wanted at all (off in tests). Production mode (this set) also
    /// restricts dialling to LAN addresses on this PC's own subnets.
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
        let (identity, notice) = store.load_or_create_identity_noted()?;
        if let Some(notice) = notice {
            host.warn(&notice);
        }
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
            conns: ConnLimiter::new(MAX_CONNECTIONS, MAX_CONNECTIONS_PER_IP),
            window_shown: AtomicBool::new(false),
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
        std::thread::spawn(move || browse.browse_loop(browser));
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

    /// Follow mDNS for the life of the engine: events update the device table, the UI hears about
    /// changes at most every 250 ms, and a browser that stops (network change, sleep/resume) is
    /// started again instead of leaving the device list frozen.
    fn browse_loop(&self, first: Browser) {
        let mut browser = Some(first);
        let mut dirty = false;
        let mut last_emit = Instant::now() - DEVICE_EVENT_INTERVAL;
        while !self.stopped.load(Ordering::Relaxed) {
            match browser.as_ref() {
                Some(b) => match b.next_event(Duration::from_millis(500)) {
                    Ok(Some(ev)) => dirty |= self.apply_peer_event(ev),
                    Ok(None) => {}
                    Err(_) => {
                        tlog!("quick send discovery stopped; restarting it");
                        browser = None;
                    }
                },
                None => {
                    std::thread::sleep(BROWSE_RESTART_DELAY);
                    browser = Browser::start(self.identity.id()).ok();
                }
            }
            if dirty && last_emit.elapsed() >= DEVICE_EVENT_INTERVAL {
                dirty = false;
                last_emit = Instant::now();
                self.emit(EVENT_DEVICES, ());
            }
            // The pairing window may have run out since the last tick.
            self.refresh_advertising();
        }
    }

    /// Apply a discovery event to the device table. Returns whether the list changed; the caller
    /// decides when to tell the UI (see `browse_loop`).
    pub fn apply_peer_event(&self, ev: PeerEvent) -> bool {
        self.table.lock().is_ok_and(|mut t| t.apply(ev))
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
        self.window_shown.store(false, Ordering::SeqCst);
        if !open {
            // Closing the dialog abandons a pairing nobody answered (dropping it closes the
            // connection), so a later attempt is not blocked by it.
            if let Ok(mut p) = self.pending.lock() {
                *p = None;
            }
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
        let mut failures = 0u32;
        for conn in listener.incoming() {
            if self.stopped.load(Ordering::Relaxed) {
                break;
            }
            let stream = match conn {
                Ok(s) => {
                    failures = 0;
                    s
                }
                Err(_) => {
                    // Out of handles or a dying adapter: do not spin on the error.
                    failures = failures.saturating_add(1);
                    std::thread::sleep(Duration::from_millis(50 << failures.min(5)));
                    continue;
                }
            };
            let Ok(peer) = stream.peer_addr() else {
                continue;
            };
            // Too many at once, or too many from one address: drop the connection unread.
            let Some(permit) = self.conns.acquire(peer.ip()) else {
                continue;
            };
            let me = self.clone();
            std::thread::spawn(move || {
                me.handle(stream);
                drop(permit);
            });
        }
    }

    fn handle(&self, stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        // A connection that never sends its HELLO is dropped quickly; once the first byte is in,
        // the protocol's own per-frame deadlines take over.
        let _ = stream.set_read_timeout(Some(PRE_HELLO_TIMEOUT));
        let mut first = [0u8; 1];
        if !matches!(stream.peek(&mut first), Ok(n) if n > 0) {
            return;
        }
        let _ = stream.set_read_timeout(None);
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

    /// Is a pairing waiting for the user's answer that has not yet expired?
    fn pending_is_fresh(slot: &Option<Pending>) -> bool {
        slot.as_ref()
            .is_some_and(|p| p.created.elapsed() < PENDING_PAIRING_TTL)
    }

    /// An inbound pairing reached the point where the user must compare codes. Only one pairing
    /// can wait at a time: while a fresh one is waiting, a newcomer is dropped (its connection
    /// closes, so the other phone sees a failure) and the code on screen stays valid. Otherwise
    /// a second phone could replace the pairing under the user's finger between reading the
    /// code and pressing Yes.
    fn set_pending(&self, pairing: PendingPairing<TcpStream>, role: PairRole) {
        let code = PairCode {
            sas: group_sas(pairing.sas()),
            peer_name: pairing.peer_name().to_string(),
            peer_id: pairing.peer_id().to_string(),
            role,
        };
        {
            let Ok(mut slot) = self.pending.lock() else {
                return;
            };
            if Self::pending_is_fresh(&slot) {
                tlog!("quick send: pairing refused, another one is waiting for an answer");
                return;
            }
            *slot = Some(Pending {
                pairing,
                created: Instant::now(),
            });
        }
        // Bring the window forward once per pairing window, not once per attempt.
        if !self.window_shown.swap(true, Ordering::SeqCst) {
            self.host.show_window();
        }
        self.emit(EVENT_PAIR_CODE, code);
    }

    /// Dial a visible device and start pairing as the initiator. Blocks until the code is known.
    pub fn pair_start(&self, device_id: &str) -> Result<PairCode, String> {
        if self
            .pending
            .lock()
            .is_ok_and(|slot| Self::pending_is_fresh(&slot))
        {
            return Err(
                "A pairing is already waiting for your answer. Finish it or close the dialog first."
                    .to_string(),
            );
        }
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
        let stream = self.connect(&addrs)?;
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
        {
            let mut slot = self
                .pending
                .lock()
                .map_err(|_| "Quick send is busy.".to_string())?;
            if Self::pending_is_fresh(&slot) {
                // An inbound pairing took the slot while we were dialling.
                return Err("Another pairing started at the same time. Try again.".to_string());
            }
            *slot = Some(Pending {
                pairing,
                created: Instant::now(),
            });
        }
        self.emit(EVENT_PAIR_CODE, code.clone());
        Ok(code)
    }

    /// Finish the pending pairing with the user's answer to "do both screens show this code?".
    ///
    /// The answer is bound to the pairing the user was looking at: `peer_id` and `sas` must be the
    /// ones shown in the dialog (`qs:pair-code`). If another pairing has replaced it, or the answer came
    /// from a stale or forged request, nothing is confirmed and the pending pairing is untouched.
    pub fn pair_confirm(
        &self,
        peer_id: &str,
        sas: &str,
        accepted: bool,
    ) -> Result<DeviceEntry, String> {
        let pending = {
            let mut slot = self
                .pending
                .lock()
                .map_err(|_| "Quick send is busy.".to_string())?;
            let Some(p) = slot
                .as_ref()
                .filter(|p| p.created.elapsed() < PENDING_PAIRING_TTL)
            else {
                *slot = None;
                return Err("There is no pairing in progress. Start again.".to_string());
            };
            let same_peer = p.pairing.peer_id().to_string() == peer_id.to_ascii_uppercase();
            let same_code = compact_sas(&group_sas(p.pairing.sas())) == compact_sas(sas);
            if !same_peer || !same_code {
                return Err(
                    "That is not the pairing on screen any more. Close the dialog and start again."
                        .to_string(),
                );
            }
            slot.take()
        }
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
        let stream = self.connect(&addrs)?;
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

impl QuickSend {
    /// Dial the first reachable address. Only LAN addresses on this PC's own subnets are tried in
    /// production (see `dialable`); discovery data is not trusted to pick the target.
    fn connect(&self, addrs: &[SocketAddr]) -> Result<TcpStream, String> {
        let local = if self.discovery {
            local_subnets()
        } else {
            Vec::new()
        };
        let candidates = dialable(addrs, &local, !self.discovery);
        for addr in &candidates {
            if let Ok(s) = TcpStream::connect_timeout(addr, CONNECT_TIMEOUT) {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
        }
        Err(
            "Could not reach that device. Check that both are on the same Wi-Fi network."
                .to_string(),
        )
    }
}

/// `"042 917"` and `"042917"` compare equal.
fn compact_sas(sas: &str) -> String {
    sas.chars().filter(|c| !c.is_whitespace()).collect()
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc::{channel, Receiver};

    use polishot_quicksend::discovery::Peer;

    use super::*;
    use crate::store::Source;

    /// A fake app: records events and registered images.
    struct TestHost {
        events: Mutex<Sender<(String, serde_json::Value)>>,
        shown: AtomicUsize,
        images: Mutex<Vec<(u32, u32)>>,
        warnings: Mutex<Vec<String>>,
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
        fn warn(&self, message: &str) {
            self.warnings.lock().unwrap().push(message.to_string());
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
            warnings: Mutex::new(Vec::new()),
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
        let (b_sees_peer, b_sees_sas) = (
            seen_by_b["peerId"].as_str().unwrap().to_string(),
            seen_by_b["sas"].as_str().unwrap().to_string(),
        );
        let tb = std::thread::spawn(move || qb.pair_confirm(&b_sees_peer, &b_sees_sas, true));
        let ra = qa
            .pair_confirm(&code.peer_id, &code.sas, true)
            .expect("initiator confirm");
        let rb = tb.join().unwrap().expect("responder confirm");
        assert!(ra.paired && rb.paired);
        assert_eq!(ra.id, b.q.id_text());
        assert_eq!(rb.id, a.q.id_text());
        code.sas
    }

    /// The peer id and code the pending pairing on `n` shows.
    fn wait_pending(n: &Node) -> (String, String) {
        let t = Instant::now();
        loop {
            if let Some(p) = n.q.pending.lock().unwrap().as_ref() {
                return (p.pairing.peer_id().to_string(), group_sas(p.pairing.sas()));
            }
            assert!(t.elapsed() < Duration::from_secs(10), "no pending pairing");
            std::thread::sleep(Duration::from_millis(5));
        }
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
        let code = a.q.pair_start(&b.q.id_text()).unwrap();
        wait_for(&b, EVENT_PAIR_CODE);
        let qb = b.q.clone();
        let seen = wait_pending(&b);
        let tb = std::thread::spawn(move || qb.pair_confirm(&seen.0, &seen.1, true));
        // The initiator says the codes do not match.
        assert!(a.q.pair_confirm(&code.peer_id, &code.sas, false).is_err());
        assert!(tb.join().unwrap().is_err());
        assert!(QsStore::new(&a.dir).load_pairs().is_empty());
        assert!(QsStore::new(&b.dir).load_pairs().is_empty());
    }

    #[test]
    fn confirming_without_a_pairing_in_progress_is_an_error() {
        let a = node("Phone");
        assert!(a
            .q
            .pair_confirm("AAAAAAAAAAAAAAAA", "000 000", true)
            .is_err());
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
    #[test]
    fn a_confirmation_must_name_the_pairing_on_screen() {
        let a = node("Phone");
        let b = node("Studio PC");
        introduce(&a, &b);
        b.q.set_pairing_open(true);
        let code = a.q.pair_start(&b.q.id_text()).unwrap();
        let seen = wait_pending(&b);
        // Wrong peer, wrong code, and both wrong: refused, and the pairing stays pending.
        let other = Identity::generate().id().to_string();
        for (peer, sas) in [
            (other.as_str(), seen.1.as_str()),
            (seen.0.as_str(), "000 000"),
            (other.as_str(), "000 000"),
        ] {
            let e = b.q.pair_confirm(peer, sas, true).unwrap_err();
            assert!(e.contains("not the pairing on screen"), "{e}");
        }
        assert!(
            b.q.pending.lock().unwrap().is_some(),
            "still waiting for the right answer"
        );
        // The right answer (any spelling of the code, any case of the id) pairs.
        let qb = b.q.clone();
        let (peer_lower, compact) = (seen.0.to_ascii_lowercase(), seen.1.replace(' ', ""));
        let tb = std::thread::spawn(move || qb.pair_confirm(&peer_lower, &compact, true));
        a.q.pair_confirm(&code.peer_id, &code.sas, true).unwrap();
        tb.join().unwrap().unwrap();
        assert_eq!(QsStore::new(&b.dir).load_pairs().len(), 1);
    }

    #[test]
    fn a_second_pairing_cannot_replace_one_waiting_for_an_answer() {
        let a = node("Phone");
        let c = node("Other phone");
        let b = node("Studio PC");
        introduce(&a, &b);
        introduce(&c, &b);
        b.q.set_pairing_open(true);
        let first = a.q.pair_start(&b.q.id_text()).unwrap();
        let shown = wait_pending(&b);
        assert_eq!(shown.1, first.sas);
        let shown_before = b.host.shown.load(Ordering::SeqCst);

        // A second phone tries while the first code is on screen: its dial succeeds at the
        // protocol level, but it never gets to replace the pending pairing.
        let _ = c.q.pair_start(&b.q.id_text());
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(wait_pending(&b), shown, "the code on screen did not change");
        assert_eq!(
            b.host.shown.load(Ordering::SeqCst),
            shown_before,
            "no second window pop-up"
        );
        // And this PC refuses to start a pairing of its own over a waiting one.
        introduce(&b, &c);
        let e = b.q.pair_start(&c.q.id_text()).unwrap_err();
        assert!(e.contains("already waiting"), "{e}");
        // The first pairing still completes.
        let qb = b.q.clone();
        let tb = std::thread::spawn(move || qb.pair_confirm(&shown.0, &shown.1, true));
        a.q.pair_confirm(&first.peer_id, &first.sas, true).unwrap();
        tb.join().unwrap().unwrap();
    }

    #[test]
    fn closing_the_pairing_dialog_abandons_a_waiting_pairing() {
        let a = node("Phone");
        let b = node("Studio PC");
        introduce(&a, &b);
        b.q.set_pairing_open(true);
        let code = a.q.pair_start(&b.q.id_text()).unwrap();
        wait_pending(&b);
        b.q.set_pairing_open(false);
        assert!(b.q.pending.lock().unwrap().is_none());
        assert!(b.q.pair_confirm(&code.peer_id, &code.sas, true).is_err());
    }

    #[test]
    fn the_window_comes_forward_once_per_pairing_window() {
        let a = node("Phone");
        let b = node("Studio PC");
        introduce(&a, &b);
        b.q.set_pairing_open(true);
        a.q.pair_start(&b.q.id_text()).unwrap();
        wait_pending(&b);
        assert_eq!(b.host.shown.load(Ordering::SeqCst), 1);
        b.q.set_pairing_open(false);
        b.q.set_pairing_open(true);
        let c = node("Other phone");
        introduce(&c, &b);
        c.q.pair_start(&b.q.id_text()).unwrap();
        wait_pending(&b);
        assert_eq!(
            b.host.shown.load(Ordering::SeqCst),
            2,
            "a new pairing window may show it again"
        );
    }

    #[test]
    fn an_unreadable_identity_is_reported_to_the_user() {
        let dir = std::env::temp_dir().join(format!("ps-qs-{}", crate::ids::new_id()));
        let (tx, _events) = channel();
        let host = Arc::new(TestHost {
            events: Mutex::new(tx),
            shown: AtomicUsize::new(0),
            images: Mutex::new(Vec::new()),
            warnings: Mutex::new(Vec::new()),
        });
        QuickSend::new(host.clone(), QsStore::new(&dir), "PC".into(), false).unwrap();
        assert!(
            host.warnings.lock().unwrap().is_empty(),
            "a first run is silent"
        );
        std::fs::write(dir.join("identity.bin"), b"not from this account").unwrap();
        QuickSend::new(host.clone(), QsStore::new(&dir), "PC".into(), false).unwrap();
        let w = host.warnings.lock().unwrap().clone();
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("Pair your phones again"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_silent_connection_is_dropped_quickly_and_its_slot_returned() {
        let b = node("Studio PC");
        let mut idle = TcpStream::connect(("127.0.0.1", b.port)).unwrap();
        idle.set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let t = Instant::now();
        let mut buf = [0u8; 8];
        // The server closes without sending anything: a clean EOF (or a reset), not our timeout.
        let n = idle.read(&mut buf).unwrap_or(0);
        assert_eq!(n, 0);
        assert!(
            t.elapsed() < Duration::from_secs(8),
            "dropped after {:?}",
            t.elapsed()
        );
        assert!(
            t.elapsed() >= Duration::from_secs(2),
            "not before the pre-HELLO timeout"
        );
        let t = Instant::now();
        while b.q.conns.active() > 0 {
            assert!(t.elapsed() < Duration::from_secs(5), "slot never returned");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn one_address_cannot_hold_more_than_its_share_of_connections() {
        let l = ConnLimiter::new(4, 2);
        let a: IpAddr = Ipv4Addr::new(192, 168, 1, 10).into();
        let b: IpAddr = Ipv4Addr::new(192, 168, 1, 11).into();
        let c: IpAddr = Ipv4Addr::new(192, 168, 1, 12).into();
        let a1 = l.acquire(a).unwrap();
        let a2 = l.acquire(a).unwrap();
        assert!(l.acquire(a).is_none(), "third from the same address");
        let b1 = l.acquire(b).unwrap();
        let b2 = l.acquire(b).unwrap();
        assert!(l.acquire(c).is_none(), "total limit");
        assert_eq!(l.active(), 4);
        drop(a1);
        assert_eq!(l.active(), 3);
        let c1 = l.acquire(c).expect("a freed slot is usable");
        assert!(l.acquire(a).is_none(), "the total limit is back at 4");
        drop((a2, b1, b2, c1));
        assert_eq!(l.active(), 0);
        assert!(
            l.state.lock().unwrap().1.is_empty(),
            "no per-address residue"
        );
    }

    #[test]
    fn only_lan_addresses_may_be_dialled() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        for ok in [
            "10.0.0.5",
            "10.255.255.254",
            "172.16.0.1",
            "172.31.255.1",
            "192.168.1.20",
            "169.254.10.10",
            "fd12:3456:789a::1",
            "fc00::1",
            "::ffff:192.168.1.20",
        ] {
            assert!(is_lan_addr(ip(ok), false), "{ok}");
        }
        for bad in [
            "8.8.8.8",
            "1.1.1.1",
            "172.15.255.255",
            "172.32.0.1",
            "192.169.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "0.0.0.0",
            "224.0.0.251",
            "255.255.255.255",
            "::1",
            "2001:4860:4860::8888",
            "fe80::1",
            "::ffff:8.8.8.8",
            "::",
        ] {
            assert!(!is_lan_addr(ip(bad), false), "{bad}");
        }
        assert!(is_lan_addr(ip("127.0.0.1"), true));
        assert!(is_lan_addr(ip("::1"), true));
        assert!(
            !is_lan_addr(ip("8.8.8.8"), true),
            "tests may use loopback, never the internet"
        );
    }

    #[test]
    fn subnet_membership() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(in_subnet(ip("192.168.1.77"), ip("192.168.1.20"), 24));
        assert!(!in_subnet(ip("192.168.2.77"), ip("192.168.1.20"), 24));
        assert!(in_subnet(ip("192.168.2.77"), ip("192.168.1.20"), 16));
        assert!(in_subnet(ip("10.9.9.9"), ip("10.0.0.1"), 8));
        assert!(in_subnet(ip("1.2.3.4"), ip("9.9.9.9"), 0));
        assert!(in_subnet(ip("192.168.1.20"), ip("192.168.1.20"), 32));
        assert!(!in_subnet(ip("192.168.1.21"), ip("192.168.1.20"), 32));
        assert!(in_subnet(ip("fd12::5"), ip("fd12::1"), 64));
        assert!(!in_subnet(ip("fd13::5"), ip("fd12::1"), 64));
        assert!(
            !in_subnet(ip("192.168.1.1"), ip("fd12::1"), 8),
            "families never mix"
        );
        // A silly prefix is clamped to the address length instead of overflowing the shift.
        assert!(in_subnet(ip("192.168.1.2"), ip("192.168.1.2"), 200));
        assert!(!in_subnet(ip("192.168.1.1"), ip("192.168.1.2"), 200));
    }

    #[test]
    fn dialling_is_limited_to_lan_addresses_on_a_local_subnet() {
        let sock = |s: &str| SocketAddr::new(s.parse().unwrap(), 4000);
        let local = [
            ("192.168.1.20".parse::<IpAddr>().unwrap(), 24u8),
            ("fd12::20".parse::<IpAddr>().unwrap(), 64u8),
        ];
        let offered = [
            sock("8.8.8.8"),      // the internet
            sock("10.0.0.7"),     // private, but another network
            sock("192.168.1.55"), // on our subnet
            sock("fd12::99"),     // on our IPv6 subnet
            sock("169.254.1.1"),  // link-local, not on a subnet we are on
            sock("127.0.0.1"),    // this PC
        ];
        assert_eq!(
            dialable(&offered, &local, false),
            [sock("192.168.1.55"), sock("fd12::99")]
        );
        // If the adapter list could not be read, the range check alone applies.
        assert_eq!(
            dialable(&offered, &[], false),
            [
                sock("10.0.0.7"),
                sock("192.168.1.55"),
                sock("fd12::99"),
                sock("169.254.1.1")
            ]
        );
        assert_eq!(dialable(&[sock("8.8.8.8")], &local, true), []);
        assert_eq!(
            dialable(&[sock("127.0.0.1")], &local, true),
            [sock("127.0.0.1")]
        );
        let _ = Ipv6Addr::LOCALHOST;
    }

    #[test]
    fn this_pcs_adapter_list_can_be_read() {
        // Whatever the machine's network looks like, reading it must not crash, and every prefix
        // must be a valid length for its address family.
        for (ip, prefix) in local_subnets() {
            let max = if ip.is_ipv4() { 32 } else { 128 };
            assert!(prefix <= max, "{ip}/{prefix}");
        }
    }
}
