//! Polishot quick send: pair two devices once by comparing a six-digit code, then send images over the local
//! network with mutual authentication, forward secrecy and end-to-end encryption.
//!
//! The protocol is specified in `docs/QUICKSEND.md`; the Android implementation lives in
//! `apps/android/quicksend` and shares test vectors with this crate.
//!
//! The core is blocking and works over any [`Transport`] (a `TcpStream`, or [`duplex`] for tests), so run each
//! call on a worker thread. Typical use:
//!
//! ```no_run
//! use polishot_quicksend::{serve, Config, Identity, Incoming, ServeConfig};
//! # fn run(listener: std::net::TcpListener, identity: Identity) -> polishot_quicksend::Result<()> {
//! let (stream, _addr) = listener.accept()?;
//! let sc = ServeConfig {
//!     identity: &identity,
//!     local_name: "Studio PC",
//!     pairs: &[],
//!     allow_pairing: true,
//!     rate_limiter: None,
//!     config: Config::default(),
//! };
//! match serve(stream, &sc, |offer| offer.size < 10_000_000)? {
//!     Incoming::Pairing(p) => println!("compare code {}", p.sas()),
//!     Incoming::Received(f) => println!("got {} bytes", f.data.len()),
//! }
//! # Ok(())
//! # }
//! ```

mod content;
mod crypto;
mod error;
mod frame;
mod hello;
mod identity;
mod pairing;
mod proto;
mod ratelimit;
mod transfer;
mod transport;

#[cfg(feature = "discovery")]
pub mod discovery;

#[cfg(test)]
mod attack_tests;
#[cfg(test)]
mod vectors;

pub use content::{
    check_magic, clean_device_name, is_allowed_mime, sanitize_file_name, validate_device_name,
};
pub use crypto::PublicKeyBytes;
pub use error::{Error, Result};
pub use identity::{DeviceId, Identity, PairRecord};
pub use pairing::{
    pair_initiator, pair_initiator_with, pair_responder, pair_responder_with, PendingPairing,
};
pub use proto::{
    frame_type, Config, ErrorCode, Timeouts, ALLOWED_MIME, CHUNK_SIZE, DEVICE_ID_LEN,
    MAX_DEVICE_NAME_CHARS, MAX_FILE_NAME_BYTES, MAX_FILE_SIZE, MAX_FRAME, MAX_PLAIN_FRAME,
    PAIR_KEY_LEN, PROTOCOL_MAX, PROTOCOL_MIN, PUBLIC_KEY_LEN, SERVICE_TYPE,
};
pub use ratelimit::PairingRateLimiter;
pub use transfer::{
    receive, receive_with, send_file, send_file_with, serve, serve_with_progress, FileMeta,
    Incoming, OfferInfo, ReceivedFile, ServeConfig,
};
pub use transport::{duplex, MemoryStream, Transport};
