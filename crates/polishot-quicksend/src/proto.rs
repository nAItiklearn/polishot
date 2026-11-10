//! Protocol constants (see `docs/QUICKSEND.md`). Nothing here performs I/O.

use std::time::Duration;

/// Lowest protocol version this build speaks.
pub const PROTOCOL_MIN: u8 = 1;
/// Highest protocol version this build speaks.
pub const PROTOCOL_MAX: u8 = 1;

/// DNS-SD service type.
pub const SERVICE_TYPE: &str = "_polishot._tcp.local.";

/// Largest frame (`len` field: type byte + body) in bytes.
pub const MAX_FRAME: usize = 1 << 20;
/// Largest frame accepted before the session is authenticated.
pub const MAX_PLAIN_FRAME: usize = 1024;
/// AES-GCM tag length.
pub const TAG_LEN: usize = 16;
/// Largest file in bytes (50 MiB).
pub const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;
/// Every chunk except the last carries exactly this many bytes.
pub const CHUNK_SIZE: usize = 64 * 1024;
/// Device names are 1..=32 Unicode scalar values.
pub const MAX_DEVICE_NAME_CHARS: usize = 32;
/// File names are 1..=128 UTF-8 bytes on the wire.
pub const MAX_FILE_NAME_BYTES: usize = 128;
/// SEC1 uncompressed P-256 public key length.
pub const PUBLIC_KEY_LEN: usize = 65;
/// Device id length in bytes (10 bytes = 16 base32 characters).
pub const DEVICE_ID_LEN: usize = 10;
/// Pair key length.
pub const PAIR_KEY_LEN: usize = 32;
/// Accepted MIME types.
pub const ALLOWED_MIME: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];

pub(crate) const L_COMMIT: &[u8] = b"polishot-qs-commit-v1";
pub(crate) const L_PAIR_T: &[u8] = b"polishot-qs-pair-transcript-v1";
pub(crate) const L_XFER_T: &[u8] = b"polishot-qs-transfer-transcript-v1";
pub(crate) const I_SAS: &[u8] = b"polishot-sas";
pub(crate) const I_PAIR: &[u8] = b"polishot-pair-v1";
pub(crate) const I_SESSION: &[u8] = b"polishot-session-v1";
pub(crate) const L_CONFIRM_I: &[u8] = b"polishot-pair-confirm-i";
pub(crate) const L_CONFIRM_R: &[u8] = b"polishot-pair-confirm-r";
pub(crate) const L_AUTH_S: &[u8] = b"polishot-auth-s";
pub(crate) const L_AUTH_R: &[u8] = b"polishot-auth-r";

/// Direction tag in the AEAD nonce for sender-to-receiver frames.
pub(crate) const DIR_S2R: [u8; 4] = [0, 0, 0, 1];
/// Direction tag in the AEAD nonce for receiver-to-sender frames.
pub(crate) const DIR_R2S: [u8; 4] = [0, 0, 0, 2];

/// Frame type codes.
pub mod frame_type {
    /// Version, intent, id and (for transfers) ephemeral key.
    pub const HELLO: u8 = 0x01;
    /// Pairing: initiator long-term key and commitment.
    pub const PAIR_REQUEST: u8 = 0x02;
    /// Pairing: responder long-term and ephemeral keys.
    pub const PAIR_RESPONSE: u8 = 0x03;
    /// Pairing: initiator ephemeral key (opens the commitment).
    pub const PAIR_REVEAL: u8 = 0x04;
    /// Pairing: user decision and key confirmation MAC.
    pub const PAIR_CONFIRM: u8 = 0x05;
    /// Transfer: HMAC under the pair key over the transcript.
    pub const AUTH: u8 = 0x10;
    /// Transfer: file metadata.
    pub const OFFER: u8 = 0x11;
    /// Transfer: receiver accepts.
    pub const ACCEPT: u8 = 0x12;
    /// Transfer: receiver declines.
    pub const DECLINE: u8 = 0x13;
    /// Transfer: file bytes.
    pub const CHUNK: u8 = 0x14;
    /// Transfer: end of file (sender) / acknowledgement (receiver).
    pub const DONE: u8 = 0x15;
    /// Error code.
    pub const ERROR: u8 = 0x7F;
}

/// `intent` byte of HELLO.
pub(crate) const INTENT_PAIR: u8 = 1;
pub(crate) const INTENT_TRANSFER: u8 = 2;

/// Wire error codes (`ERROR` frames).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u16)]
pub enum ErrorCode {
    /// No common protocol version.
    UnsupportedVersion = 1,
    /// The receiver has no pair record for the sender.
    Unpaired = 2,
    /// The user has not opened pairing mode.
    PairingDisabled = 3,
    /// Too many pairing attempts.
    RateLimited = 4,
    /// Malformed, unexpected or out-of-order message.
    Protocol = 5,
    /// AUTH MAC mismatch (wrong pair key).
    AuthFailed = 6,
    /// Offer exceeds the size limit.
    TooLarge = 7,
    /// MIME type not on the allowlist.
    UnsupportedType = 8,
    /// Magic bytes, hash or length mismatch.
    BadContent = 9,
    /// The receiver is busy.
    Busy = 10,
    /// The peer stopped answering.
    Timeout = 11,
    /// Local failure (also used for unknown codes).
    Internal = 12,
    /// A user rejected the SAS.
    PairingRejected = 13,
}

impl ErrorCode {
    /// The `u16` sent on the wire.
    pub fn to_u16(self) -> u16 {
        self as u16
    }

    /// Parse a wire code; unknown codes map to [`ErrorCode::Internal`].
    pub fn from_u16(v: u16) -> ErrorCode {
        match v {
            1 => ErrorCode::UnsupportedVersion,
            2 => ErrorCode::Unpaired,
            3 => ErrorCode::PairingDisabled,
            4 => ErrorCode::RateLimited,
            5 => ErrorCode::Protocol,
            6 => ErrorCode::AuthFailed,
            7 => ErrorCode::TooLarge,
            8 => ErrorCode::UnsupportedType,
            9 => ErrorCode::BadContent,
            10 => ErrorCode::Busy,
            11 => ErrorCode::Timeout,
            13 => ErrorCode::PairingRejected,
            _ => ErrorCode::Internal,
        }
    }
}

/// Per-phase time limits (section 10 of the spec).
#[derive(Clone, Debug)]
pub struct Timeouts {
    /// Each pre-authentication frame, and the wait for OFFER after AUTH.
    pub handshake: Duration,
    /// Sender waits this long for ACCEPT/DECLINE.
    pub decision: Duration,
    /// Each chunk frame.
    pub chunk: Duration,
    /// Sender waits this long for the final DONE.
    pub finish: Duration,
    /// Waiting for the peer user's pairing decision.
    pub pair_confirm: Duration,
    /// Wall-clock cap from AUTH to the end of the transfer.
    pub transfer_total: Duration,
    /// Per `write` call, where the transport supports it.
    pub write: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts {
            handshake: Duration::from_secs(10),
            decision: Duration::from_secs(60),
            chunk: Duration::from_secs(15),
            finish: Duration::from_secs(15),
            pair_confirm: Duration::from_secs(120),
            transfer_total: Duration::from_secs(600),
            write: Duration::from_secs(30),
        }
    }
}

/// Runtime configuration shared by every entry point.
#[derive(Clone, Debug)]
pub struct Config {
    /// Time limits.
    pub timeouts: Timeouts,
    /// Largest file accepted or sent; clamped to [`MAX_FILE_SIZE`].
    pub max_file_size: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            timeouts: Timeouts::default(),
            max_file_size: MAX_FILE_SIZE,
        }
    }
}

impl Config {
    pub(crate) fn size_limit(&self) -> u64 {
        self.max_file_size.min(MAX_FILE_SIZE)
    }
}
