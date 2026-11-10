//! Quick send: pair a phone once (compare a six-digit code), then send images over the local
//! network, end to end encrypted. The protocol lives in `polishot-quicksend`; this module owns
//! the listener, discovery, persistence, and the events the UI reacts to.
//!
//! Nothing starts until the feature is used (a paired device exists, or the user opens the
//! device list or pairing dialog), so people who never use it never see a firewall prompt.
//!
//! Events (to the preview window): `qs:devices`, `qs:pair-code`, `qs:incoming`, `qs:received`.

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use polishot_quicksend::discovery::{Advertiser, Browser};
use polishot_quicksend::{
    clean_device_name, pair_initiator, send_file, serve, Config, FileMeta, Identity, Incoming,
    OfferInfo, PairRecord, PairingRateLimiter, PendingPairing, ReceivedFile, ServeConfig,
    MAX_FILE_SIZE,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::imgio;
use crate::qspeers::{find_device_id, DeviceEntry, PeerTable};
use crate::qsstore::QsStore;
use crate::state::{register_capture, state};
use crate::store::{CaptureMeta, Source};
use crate::{tlog, winmgr};

const MAX_CONCURRENT_CONNECTIONS: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a sender waits for us (the protocol's own limit is 60 s); answer before that.
const INCOMING_DECISION: Duration = Duration::from_secs(55);
/// A pairing screen that is forgotten about closes itself.
const PAIRING_WINDOW: Duration = Duration::from_secs(300);
const PENDING_PAIRING_TTL: Duration = Duration::from_secs(90);

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
    app: AppHandle,
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
    // Dropping the advertiser unregisters the mDNS service.
    _advertiser: Mutex<Option<Advertiser>>,
}

/// Display name of this PC, as other devices see it.
fn local_name() -> String {
    let raw = std::env::var("COMPUTERNAME").unwrap_or_default();
    let cleaned = clean_device_name(&raw);
    if cleaned.trim().is_empty() {
        "Windows PC".to_string()
    } else {
        cleaned
    }
}

/// `"042917"` -> `"042 917"`.
pub fn group_sas(sas: &str) -> String {
    if sas.len() == 6 && sas.bytes().all(|b| b.is_ascii_digit()) {
        format!("{} {}", &sas[..3], &sas[3..])
    } else {
        sas.to_string()
    }
}

/// Start quick send on first use. Cheap on later calls.
pub fn ensure(app: &AppHandle) -> Result<Arc<QuickSend>, String> {
    let st = state(app);
    let mut slot = st
        .quicksend
        .lock()
        .map_err(|_| "Quick send is unavailable.".to_string())?;
    if let Some(q) = slot.as_ref() {
        return Ok(q.clone());
    }
    let q = QuickSend::start(app)?;
    *slot = Some(q.clone());
    Ok(q)
}

/// At app start: bring quick send up only when a device is already paired.
pub fn start_if_paired(app: &AppHandle) {
    let dir = state(app).paths.quicksend_dir();
    if QsStore::new(&dir).load_pairs().is_empty() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = ensure(&app) {
            tlog!("quick send start failed: {e}");
        }
    });
}

impl QuickSend {
    fn start(app: &AppHandle) -> Result<Arc<QuickSend>, String> {
        let store = QsStore::new(&state(app).paths.quicksend_dir());
        let identity = store.load_or_create_identity()?;
        let pairs = store.load_pairs();
        let name = local_name();

        // Binding the listener is what triggers the Windows Firewall prompt on first use.
        let listener = TcpListener::bind(("0.0.0.0", 0))
            .map_err(|_| "Quick send could not open a network port.".to_string())?;
        let port = listener
            .local_addr()
            .map_err(|_| "Quick send could not open a network port.".to_string())?
            .port();
        let advertiser = Advertiser::start(&identity.id(), &name, port)
            .map_err(|_| "Quick send could not announce this PC on the network.".to_string())?;
        let browser = Browser::start(identity.id())
            .map_err(|_| "Quick send could not look for devices.".to_string())?;

        let q = Arc::new(QuickSend {
            app: app.clone(),
            store,
            identity,
            name,
            pairs: RwLock::new(pairs),
            table: Mutex::new(PeerTable::default()),
            pairing_open_until: Mutex::new(None),
            limiter: PairingRateLimiter::new(5, Duration::from_secs(60)),
            pending: Mutex::new(None),
            incoming: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(1),
            active_connections: AtomicUsize::new(0),
            stopped: AtomicBool::new(false),
            _advertiser: Mutex::new(Some(advertiser)),
        });

        let browse = q.clone();
        std::thread::spawn(move || browse.browse_loop(&browser));
        let accept = q.clone();
        std::thread::spawn(move || accept.accept_loop(&listener));
        tlog!("quick send listening");
        Ok(q)
    }

    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        let _ = self.app.emit_to(winmgr::PREVIEW, event, payload);
    }

    // ---- discovery ----------------------------------------------------------------------------

    fn browse_loop(&self, browser: &Browser) {
        while !self.stopped.load(Ordering::Relaxed) {
            match browser.next_event(Duration::from_secs(1)) {
                Ok(Some(ev)) => {
                    let changed = self.table.lock().is_ok_and(|mut t| t.apply(ev));
                    if changed {
                        self.emit("qs:devices", ());
                    }
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
    }

    pub fn devices(&self) -> Vec<DeviceEntry> {
        let pairs = self.pairs.read().map(|p| p.clone()).unwrap_or_default();
        self.table
            .lock()
            .map(|t| t.devices(&pairs))
            .unwrap_or_default()
    }

    // ---- pairing mode -------------------------------------------------------------------------

    pub fn set_pairing_open(&self, open: bool) {
        if let Ok(mut g) = self.pairing_open_until.lock() {
            *g = open.then(|| Instant::now() + PAIRING_WINDOW);
        }
    }

    fn pairing_open(&self) -> bool {
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

    /// Ask the user about an incoming file and wait for the answer (declines on timeout).
    fn ask_user(&self, offer: &OfferInfo) -> bool {
        let id = self.next_request.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel::<bool>();
        if let Ok(mut m) = self.incoming.lock() {
            m.insert(id, tx);
        }
        self.emit(
            "qs:incoming",
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

    /// The user's answer to a `qs:incoming` prompt.
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
        let meta = register_capture(
            &self.app,
            decoded.width,
            decoded.height,
            decoded.rgba,
            Source::File,
        );
        winmgr::show_preview(&self.app);
        self.emit("qs:received", Received { meta, peer_name });
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
        self.emit("qs:pair-code", code);
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
        self.emit("qs:pair-code", code.clone());
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
        self.emit("qs:devices", ());
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
        self.emit("qs:devices", ());
        Ok(())
    }

    // ---- outbound -----------------------------------------------------------------------------

    /// Send PNG bytes to a paired device that is currently visible.
    pub fn send_png(&self, device_id: &str, file_name: &str, png: &[u8]) -> Result<(), String> {
        if !crate::ids::content_matches_ext(png, "png") {
            return Err("Only PNG images can be sent.".to_string());
        }
        if png.len() as u64 > MAX_FILE_SIZE {
            return Err("That image is too large to send (limit 50 MB).".to_string());
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

fn connect(addrs: &[std::net::SocketAddr]) -> Result<TcpStream, String> {
    for addr in addrs {
        if let Ok(s) = TcpStream::connect_timeout(addr, CONNECT_TIMEOUT) {
            let _ = s.set_nodelay(true);
            return Ok(s);
        }
    }
    Err("Could not reach that device. Check that both are on the same Wi-Fi network.".to_string())
}

/// Validate the shape of a device id received over IPC (16 base32 characters).
pub fn parse_device_text(text: &str) -> Result<&str, String> {
    if text.len() == 16
        && text
            .bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
    {
        Ok(text)
    } else {
        Err("Invalid device id.".to_string())
    }
}
