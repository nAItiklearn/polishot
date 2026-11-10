//! Error type for the whole crate.

use std::fmt;
use std::io;

use crate::proto::ErrorCode;

/// Everything that can go wrong. No variant carries user data or secrets.
#[derive(Debug)]
pub enum Error {
    /// Transport failure other than timeout/close.
    Io(io::Error),
    /// A read or write deadline expired.
    Timeout,
    /// The peer closed the connection.
    Closed,
    /// Malformed, unexpected or out-of-order message.
    Protocol(&'static str),
    /// No common protocol version.
    UnsupportedVersion,
    /// A frame header announced more bytes than allowed.
    FrameTooLarge(usize),
    /// AEAD authentication failed: tampered, replayed, dropped or reordered frame.
    Crypto,
    /// The pair-key MAC did not verify.
    AuthFailed,
    /// The sender is not in the receiver's pair list (or vice versa).
    Unpaired,
    /// The responder is not in pairing mode.
    PairingDisabled,
    /// Too many pairing attempts.
    RateLimited,
    /// The peer has our own device id.
    SelfPairing,
    /// The initiator's reveal does not match its commitment.
    BadCommitment,
    /// Pairing was rejected by the local or the remote user.
    PairingRejected,
    /// The receiving user declined the file.
    Declined,
    /// The file is larger than the limit.
    TooLarge,
    /// The MIME type is not allowed.
    UnsupportedType,
    /// Magic bytes, hash or length mismatch.
    BadContent(&'static str),
    /// A local argument was invalid (name, key bytes, ...).
    InvalidInput(&'static str),
    /// The peer reported an error.
    Remote(ErrorCode),
    /// mDNS advertise/browse failed.
    Discovery(String),
}

/// Result alias.
pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// The wire code to report to the peer for this error.
    pub fn code(&self) -> ErrorCode {
        match self {
            Error::Timeout => ErrorCode::Timeout,
            Error::UnsupportedVersion => ErrorCode::UnsupportedVersion,
            Error::AuthFailed => ErrorCode::AuthFailed,
            Error::Unpaired => ErrorCode::Unpaired,
            Error::PairingDisabled => ErrorCode::PairingDisabled,
            Error::RateLimited => ErrorCode::RateLimited,
            Error::PairingRejected => ErrorCode::PairingRejected,
            Error::TooLarge => ErrorCode::TooLarge,
            Error::UnsupportedType => ErrorCode::UnsupportedType,
            Error::BadContent(_) => ErrorCode::BadContent,
            Error::Remote(c) => *c,
            Error::Protocol(_)
            | Error::FrameTooLarge(_)
            | Error::Crypto
            | Error::SelfPairing
            | Error::BadCommitment => ErrorCode::Protocol,
            Error::Io(_)
            | Error::Closed
            | Error::Declined
            | Error::InvalidInput(_)
            | Error::Discovery(_) => ErrorCode::Internal,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(e) => write!(f, "i/o error: {e}"),
            Error::Timeout => f.write_str("timed out"),
            Error::Closed => f.write_str("connection closed"),
            Error::Protocol(m) => write!(f, "protocol error: {m}"),
            Error::UnsupportedVersion => f.write_str("no common protocol version"),
            Error::FrameTooLarge(n) => write!(f, "frame of {n} bytes exceeds the limit"),
            Error::Crypto => f.write_str("frame authentication failed"),
            Error::AuthFailed => f.write_str("peer authentication failed"),
            Error::Unpaired => f.write_str("peer is not paired"),
            Error::PairingDisabled => f.write_str("pairing mode is off"),
            Error::RateLimited => f.write_str("too many pairing attempts"),
            Error::SelfPairing => f.write_str("cannot pair a device with itself"),
            Error::BadCommitment => f.write_str("pairing commitment mismatch"),
            Error::PairingRejected => f.write_str("pairing rejected"),
            Error::Declined => f.write_str("the receiver declined the file"),
            Error::TooLarge => f.write_str("file too large"),
            Error::UnsupportedType => f.write_str("unsupported file type"),
            Error::BadContent(m) => write!(f, "bad content: {m}"),
            Error::InvalidInput(m) => write!(f, "invalid input: {m}"),
            Error::Remote(c) => write!(f, "peer reported error {c:?}"),
            Error::Discovery(m) => write!(f, "discovery error: {m}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        match e.kind() {
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => Error::Timeout,
            io::ErrorKind::UnexpectedEof
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::NotConnected => Error::Closed,
            _ => Error::Io(e),
        }
    }
}
