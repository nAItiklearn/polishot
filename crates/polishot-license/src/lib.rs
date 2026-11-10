//! Offline Ed25519 licence keys for Polishot (see `docs/CONTRACTS.md` section 3).
//!
//! A key is `PSHOT-` plus the Crockford base32 text of `payload || signature` (30 + 64 bytes),
//! grouped in sixes and joined by `-`. The payload layout is:
//!
//! | bytes | field |
//! |---|---|
//! | 0 | version = 1 |
//! | 1 | edition: 1 = personal, 2 = team |
//! | 2-5 | issued-at, days since the Unix epoch, `u32` big-endian |
//! | 6-13 | key id (8 random bytes) |
//! | 14-29 | licensee hash (first 16 bytes of SHA-256 of the lower-cased, trimmed email) |
//!
//! Parsing is deliberately forgiving about presentation and strict about content. Checks run in
//! this order and the first failure wins (the TypeScript and Kotlin implementations match):
//!
//! 1. more than 300 bytes of input -> [`LicenseError::Length`]
//! 2. trim ASCII whitespace, drop a leading `PSHOT-` (any case), ignore ASCII whitespace and `-`
//! 3. any other character that is not Crockford base32 (`U` included) -> [`LicenseError::Format`]
//! 4. decoded size is not 94 bytes -> [`LicenseError::Length`]
//! 5. strict Ed25519 verification of the payload fails -> [`LicenseError::Signature`]
//! 6. version is not 1, or edition is not 1 or 2 -> [`LicenseError::Version`]
//!
//! Decoding is case-insensitive and maps `O -> 0` and `I`/`L -> 1`. Leftover padding bits after the
//! last full byte are ignored.

use core::fmt;

use ed25519_dalek::{Signature, VerifyingKey};

/// Production public key (64 hex characters), shared with the TypeScript package.
const PROD_PUBLIC_KEY_HEX: &str = include_str!("../../../packages/license/public-key.hex");

const PAYLOAD_LEN: usize = 30;
const SIGNATURE_LEN: usize = 64;
const KEY_BYTES: usize = PAYLOAD_LEN + SIGNATURE_LEN;
const MAX_INPUT_LEN: usize = 300;
const PREFIX: &[u8; 6] = b"PSHOT-";

/// A key covers every app build dated no later than `issued_days + UPDATE_WINDOW_DAYS`
/// (CONTRACTS section 5b).
pub const UPDATE_WINDOW_DAYS: u32 = 365;

/// Licence edition encoded in byte 1 of the payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Edition {
    Personal,
    Team,
}

impl Edition {
    /// `"personal"` or `"team"`, matching the TypeScript `Edition` type.
    pub fn as_str(self) -> &'static str {
        match self {
            Edition::Personal => "personal",
            Edition::Team => "team",
        }
    }
}

/// The decoded, signature-checked contents of a licence key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicenseInfo {
    pub version: u8,
    pub edition: Edition,
    /// Days since the Unix epoch (UTC).
    pub issued_days: u32,
    pub key_id: [u8; 8],
    pub licensee_hash: [u8; 16],
}

impl LicenseInfo {
    /// Lower-case hex of [`key_id`](Self::key_id), as the TypeScript `keyId`.
    pub fn key_id_hex(&self) -> String {
        to_hex(&self.key_id)
    }

    /// Lower-case hex of [`licensee_hash`](Self::licensee_hash), as the TypeScript `licenseeHash`.
    pub fn licensee_hash_hex(&self) -> String {
        to_hex(&self.licensee_hash)
    }

    /// Issue time as Unix seconds (midnight UTC of the issue day).
    pub fn issued_at_unix_secs(&self) -> u64 {
        u64::from(self.issued_days) * 86_400
    }

    /// The last build day (days since the Unix epoch) this key covers: `issued_days + 365`,
    /// saturating at `u32::MAX` instead of overflowing (a test vector is issued on day 4294967295).
    pub fn updates_until_days(&self) -> u32 {
        self.issued_days.saturating_add(UPDATE_WINDOW_DAYS)
    }

    /// Whether an app build made on `build_days` (days since the Unix epoch, UTC) is inside the
    /// update window. The boundary day is included. Builds older than the key are covered too.
    pub fn covers_build(&self, build_days: u32) -> bool {
        build_days <= self.updates_until_days()
    }
}

/// Why a key was rejected. The variants map one-to-one to the `reason` codes in the shared vectors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LicenseError {
    /// Illegal characters (or an unreadable public key).
    Format,
    /// Wrong number of bytes, or the input is too long.
    Length,
    /// The signature is valid but the version or edition is unknown.
    Version,
    /// The signature does not verify.
    Signature,
}

impl LicenseError {
    /// The lower-case reason code used by the shared test vectors.
    pub fn code(self) -> &'static str {
        match self {
            LicenseError::Format => "format",
            LicenseError::Length => "length",
            LicenseError::Version => "version",
            LicenseError::Signature => "signature",
        }
    }
}

impl fmt::Display for LicenseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            LicenseError::Format => "licence key contains invalid characters",
            LicenseError::Length => "licence key has the wrong length",
            LicenseError::Version => "licence key was made for a newer version of the app",
            LicenseError::Signature => "licence key signature is not valid",
        })
    }
}

impl std::error::Error for LicenseError {}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(char::from(DIGITS[usize::from(b >> 4)]));
        out.push(char::from(DIGITS[usize::from(b & 15)]));
    }
    out
}

/// Space, `\t`, `\n`, `\v`, `\f`, `\r` (the ASCII set the other implementations use).
fn is_space(b: u8) -> bool {
    b == b' ' || (0x09..=0x0d).contains(&b)
}

/// Crockford base32 value of an ASCII byte, accepting lower case and the O/I/L aliases.
fn base32_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'O' | b'o' => Some(0),
        b'I' | b'i' | b'L' | b'l' => Some(1),
        b'A'..=b'H' | b'a'..=b'h' => Some((b | 0x20) - b'a' + 10),
        b'J' | b'j' | b'K' | b'k' => Some((b | 0x20) - b'j' + 18),
        b'M' | b'm' | b'N' | b'n' => Some((b | 0x20) - b'm' + 20),
        b'P'..=b'T' | b'p'..=b't' => Some((b | 0x20) - b'p' + 22),
        b'V'..=b'Z' | b'v'..=b'z' => Some((b | 0x20) - b'v' + 27),
        _ => None,
    }
}

/// Splits key text into payload and signature bytes (no signature check).
fn decode(key: &str) -> Result<([u8; PAYLOAD_LEN], [u8; SIGNATURE_LEN]), LicenseError> {
    let mut text = key.as_bytes();
    if text.len() > MAX_INPUT_LEN {
        return Err(LicenseError::Length);
    }
    while let Some((&first, rest)) = text.split_first() {
        if !is_space(first) {
            break;
        }
        text = rest;
    }
    while let Some((&last, rest)) = text.split_last() {
        if !is_space(last) {
            break;
        }
        text = rest;
    }
    if text.len() >= PREFIX.len() && text[..PREFIX.len()].eq_ignore_ascii_case(PREFIX) {
        text = &text[PREFIX.len()..];
    }

    let mut bytes = [0u8; KEY_BYTES];
    let mut count = 0usize;
    let mut acc = 0u32;
    let mut bits = 0u32;
    for &b in text {
        if is_space(b) || b == b'-' {
            continue;
        }
        let value = base32_value(b).ok_or(LicenseError::Format)?;
        acc = ((acc << 5) | u32::from(value)) & 0xfff;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if let Some(slot) = bytes.get_mut(count) {
                // Truncation to the low byte is the point: `acc` holds at most 12 bits.
                *slot = ((acc >> bits) & 0xff) as u8;
            }
            count += 1;
        }
    }
    if count != KEY_BYTES {
        return Err(LicenseError::Length);
    }

    let mut payload = [0u8; PAYLOAD_LEN];
    let mut signature = [0u8; SIGNATURE_LEN];
    payload.copy_from_slice(&bytes[..PAYLOAD_LEN]);
    signature.copy_from_slice(&bytes[PAYLOAD_LEN..]);
    Ok((payload, signature))
}

/// Parses 64 hex characters (either case, surrounding whitespace allowed) into a public key.
pub fn public_key_from_hex(hex: &str) -> Result<[u8; 32], LicenseError> {
    let text = hex.trim().as_bytes();
    if text.len() != 64 {
        return Err(LicenseError::Length);
    }
    let mut out = [0u8; 32];
    for (slot, pair) in out.iter_mut().zip(text.chunks_exact(2)) {
        let hi = hex_digit(pair[0]).ok_or(LicenseError::Format)?;
        let lo = hex_digit(pair[1]).ok_or(LicenseError::Format)?;
        *slot = (hi << 4) | lo;
    }
    Ok(out)
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Verifies `key` against `public_key` and returns its contents.
pub fn verify(key: &str, public_key: &[u8; 32]) -> Result<LicenseInfo, LicenseError> {
    let (payload, signature) = decode(key)?;

    let verifying_key =
        VerifyingKey::from_bytes(public_key).map_err(|_| LicenseError::Signature)?;
    verifying_key
        .verify_strict(&payload, &Signature::from_bytes(&signature))
        .map_err(|_| LicenseError::Signature)?;

    if payload[0] != 1 {
        return Err(LicenseError::Version);
    }
    let edition = match payload[1] {
        1 => Edition::Personal,
        2 => Edition::Team,
        _ => return Err(LicenseError::Version),
    };
    let mut issued = [0u8; 4];
    issued.copy_from_slice(&payload[2..6]);
    let mut key_id = [0u8; 8];
    key_id.copy_from_slice(&payload[6..14]);
    let mut licensee_hash = [0u8; 16];
    licensee_hash.copy_from_slice(&payload[14..30]);

    Ok(LicenseInfo {
        version: payload[0],
        edition,
        issued_days: u32::from_be_bytes(issued),
        key_id,
        licensee_hash,
    })
}

/// Verifies `key` against the production public key embedded at build time.
pub fn verify_prod(key: &str) -> Result<LicenseInfo, LicenseError> {
    verify(key, &public_key_from_hex(PROD_PUBLIC_KEY_HEX)?)
}

/// `Entitlement::reason` when no key is activated.
pub const REASON_NO_KEY: &str = "no-key";
/// `Entitlement::reason` when the key text does not verify.
pub const REASON_INVALID: &str = "invalid";
/// `Entitlement::reason` when the key is genuine but this build is newer than its update window.
pub const REASON_UPDATES_EXPIRED: &str = "updates-expired";

/// What the app may do (CONTRACTS section 5b); the Rust twin of the TypeScript `entitlement()`.
/// `pro` is the editor's `licensed` flag. `reason` is set exactly when `pro` is false, and is one of
/// [`REASON_NO_KEY`], [`REASON_INVALID`], [`REASON_UPDATES_EXPIRED`]. `updates_until_days` is set
/// whenever a genuine key was checked, so the UI can say "updates until <date>" for expired builds too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Entitlement {
    pub pro: bool,
    pub reason: Option<&'static str>,
    pub updates_until_days: Option<u32>,
}

impl Entitlement {
    /// Nothing activated.
    pub const NO_KEY: Entitlement = Entitlement {
        pro: false,
        reason: Some(REASON_NO_KEY),
        updates_until_days: None,
    };

    /// A key that failed verification.
    pub const INVALID: Entitlement = Entitlement {
        pro: false,
        reason: Some(REASON_INVALID),
        updates_until_days: None,
    };

    /// Entitlement for a key that already verified.
    pub fn for_info(info: &LicenseInfo, build_days: u32) -> Entitlement {
        let covered = info.covers_build(build_days);
        Entitlement {
            pro: covered,
            reason: (!covered).then_some(REASON_UPDATES_EXPIRED),
            updates_until_days: Some(info.updates_until_days()),
        }
    }
}

/// Entitlement for `key` checked against `public_key`. `None` or a blank string means no key is
/// activated. Fails closed: anything that does not verify is [`Entitlement::INVALID`].
pub fn entitlement_with_key(
    key: Option<&str>,
    public_key: &[u8; 32],
    build_days: u32,
) -> Entitlement {
    match key {
        None => Entitlement::NO_KEY,
        Some(text) if text.trim().is_empty() => Entitlement::NO_KEY,
        Some(text) => match verify(text, public_key) {
            Ok(info) => Entitlement::for_info(&info, build_days),
            Err(_) => Entitlement::INVALID,
        },
    }
}

/// Entitlement for `key` against the production public key; `build_days` is the app's embedded
/// build date in days since the Unix epoch (see the README for how to produce it).
pub fn entitlement(key: Option<&str>, build_days: u32) -> Entitlement {
    match public_key_from_hex(PROD_PUBLIC_KEY_HEX) {
        Ok(public_key) => entitlement_with_key(key, &public_key, build_days),
        Err(_) => match key {
            Some(text) if !text.trim().is_empty() => Entitlement::INVALID,
            _ => Entitlement::NO_KEY,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_production_key_parses() {
        let key = public_key_from_hex(PROD_PUBLIC_KEY_HEX).expect("public-key.hex is valid");
        assert!(VerifyingKey::from_bytes(&key).is_ok());
    }

    #[test]
    fn base32_alphabet_matches_the_contract() {
        let alphabet = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        for (i, &c) in alphabet.iter().enumerate() {
            assert_eq!(base32_value(c), Some(i as u8), "{}", c as char);
            assert_eq!(base32_value(c.to_ascii_lowercase()), Some(i as u8));
        }
        assert_eq!(base32_value(b'O'), Some(0));
        assert_eq!(base32_value(b'I'), Some(1));
        assert_eq!(base32_value(b'L'), Some(1));
        for bad in [b'U', b'u', b'!', b'_', b'=', b'+', 0u8, 0x80, 0xff] {
            assert_eq!(base32_value(bad), None, "{bad:#x}");
        }
        // 10 digits, 22 letters in two cases, plus the six O/o, I/i, L/l aliases; nothing else.
        let accepted = (0..=255u8).filter(|&b| base32_value(b).is_some()).count();
        assert_eq!(accepted, 10 + 22 * 2 + 6);
    }

    #[test]
    fn hex_parsing_is_strict() {
        let ok = "00112233445566778899aabbccddeeff00112233445566778899AABBCCDDEEFF";
        assert!(public_key_from_hex(ok).is_ok());
        assert!(public_key_from_hex(&format!("  {ok}\n")).is_ok());
        assert_eq!(public_key_from_hex(""), Err(LicenseError::Length));
        assert_eq!(public_key_from_hex(&ok[1..]), Err(LicenseError::Length));
        assert_eq!(
            public_key_from_hex(&ok.replace('0', "g")),
            Err(LicenseError::Format)
        );
    }

    fn info_issued(issued_days: u32) -> LicenseInfo {
        LicenseInfo {
            version: 1,
            edition: Edition::Personal,
            issued_days,
            key_id: [0; 8],
            licensee_hash: [0; 16],
        }
    }

    #[test]
    fn update_window_is_issue_day_plus_365_with_an_inclusive_boundary() {
        let info = info_issued(20_000);
        assert_eq!(info.updates_until_days(), 20_365);
        assert!(info.covers_build(0));
        assert!(info.covers_build(20_000));
        assert!(info.covers_build(20_364));
        assert!(info.covers_build(20_365), "boundary day is covered");
        assert!(!info.covers_build(20_366), "one day later is not");
        assert!(!info.covers_build(u32::MAX));
    }

    #[test]
    fn update_window_saturates_instead_of_overflowing() {
        for issued in [u32::MAX, u32::MAX - 1, u32::MAX - 364, u32::MAX - 365] {
            let info = info_issued(issued);
            assert_eq!(info.updates_until_days(), u32::MAX, "{issued}");
            // A wrapping add would give a tiny number and call an ordinary build expired.
            assert!(info.covers_build(20_000), "{issued}");
            assert!(info.covers_build(u32::MAX), "{issued}");
        }
        assert_eq!(
            info_issued(u32::MAX - 366).updates_until_days(),
            u32::MAX - 1
        );
        assert!(!info_issued(u32::MAX - 366).covers_build(u32::MAX));
        assert_eq!(info_issued(0).updates_until_days(), 365);
    }

    #[test]
    fn entitlement_without_a_usable_key_is_never_pro() {
        let public_key = [7u8; 32];
        for key in [None, Some(""), Some("   "), Some(" \t\r\n")] {
            assert_eq!(
                entitlement_with_key(key, &public_key, 20_000),
                Entitlement::NO_KEY
            );
            assert_eq!(entitlement(key, 20_000), Entitlement::NO_KEY);
        }
        for key in ["x", "PSHOT-", "PSHOT-0000", "not a key at all", "日本語"] {
            assert_eq!(
                entitlement_with_key(Some(key), &public_key, 20_000),
                Entitlement::INVALID
            );
            assert_eq!(entitlement(Some(key), 20_000), Entitlement::INVALID);
        }
        for e in [Entitlement::NO_KEY, Entitlement::INVALID] {
            assert!(!e.pro);
            assert_eq!(e.updates_until_days, None);
        }
        assert_eq!(Entitlement::NO_KEY.reason, Some("no-key"));
        assert_eq!(Entitlement::INVALID.reason, Some("invalid"));
    }

    #[test]
    fn entitlement_for_a_verified_key_follows_the_window() {
        let info = info_issued(20_468);
        assert_eq!(
            Entitlement::for_info(&info, 20_833),
            Entitlement {
                pro: true,
                reason: None,
                updates_until_days: Some(20_833),
            }
        );
        assert_eq!(
            Entitlement::for_info(&info, 20_834),
            Entitlement {
                pro: false,
                reason: Some(REASON_UPDATES_EXPIRED),
                updates_until_days: Some(20_833),
            }
        );
        assert_eq!(REASON_UPDATES_EXPIRED, "updates-expired");
    }

    #[test]
    fn error_display_and_codes() {
        for err in [
            LicenseError::Format,
            LicenseError::Length,
            LicenseError::Version,
            LicenseError::Signature,
        ] {
            assert!(!err.to_string().is_empty());
            assert_eq!(err.code(), err.code().to_lowercase());
            let boxed: Box<dyn std::error::Error> = Box::new(err);
            assert_eq!(boxed.to_string(), err.to_string());
        }
    }
}
