//! Long-term identity, device ids and persisted pair records.

use std::fmt;
use std::str::FromStr;

use zeroize::{Zeroize, Zeroizing};

use crate::content::validate_device_name;
use crate::crypto::{sha256, validate_public, KeyPair, PublicKeyBytes};
use crate::error::{Error, Result};
use crate::proto::{DEVICE_ID_LEN, PAIR_KEY_LEN, PUBLIC_KEY_LEN};

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// First 10 bytes of SHA-256 of the 65-byte long-term public key.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DeviceId([u8; DEVICE_ID_LEN]);

impl DeviceId {
    /// Derive the id of a public key.
    pub fn from_public(public: &PublicKeyBytes) -> DeviceId {
        let h = sha256(&[public]);
        let mut id = [0u8; DEVICE_ID_LEN];
        id.copy_from_slice(&h[..DEVICE_ID_LEN]);
        DeviceId(id)
    }

    /// Wrap raw id bytes.
    pub fn from_bytes(bytes: [u8; DEVICE_ID_LEN]) -> DeviceId {
        DeviceId(bytes)
    }

    /// The raw 10 bytes.
    pub fn as_bytes(&self) -> &[u8; DEVICE_ID_LEN] {
        &self.0
    }
}

impl fmt::Display for DeviceId {
    /// RFC 4648 base32, upper case, no padding: 16 characters.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut acc: u32 = 0;
        let mut bits = 0u32;
        for &b in &self.0 {
            acc = (acc << 8) | u32::from(b);
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                let idx = ((acc >> bits) & 31) as usize;
                write!(f, "{}", char::from(B32[idx]))?;
            }
        }
        // 80 bits is a multiple of 5, nothing is left over.
        debug_assert_eq!(bits, 0);
        Ok(())
    }
}

impl fmt::Debug for DeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DeviceId({self})")
    }
}

impl FromStr for DeviceId {
    type Err = Error;

    /// Parse a 16-character base32 id, case-insensitively.
    fn from_str(s: &str) -> Result<DeviceId> {
        if s.len() != 16 {
            return Err(Error::InvalidInput(
                "device id must be 16 base32 characters",
            ));
        }
        let mut out = [0u8; DEVICE_ID_LEN];
        let mut acc: u32 = 0;
        let mut bits = 0u32;
        let mut n = 0usize;
        for c in s.bytes() {
            let v = match c.to_ascii_uppercase() {
                u @ b'A'..=b'Z' => u - b'A',
                d @ b'2'..=b'7' => d - b'2' + 26,
                _ => return Err(Error::InvalidInput("device id has a non-base32 character")),
            };
            acc = (acc << 5) | u32::from(v);
            bits += 5;
            if bits >= 8 {
                bits -= 8;
                out[n] = ((acc >> bits) & 0xFF) as u8;
                n += 1;
            }
        }
        debug_assert_eq!(n, DEVICE_ID_LEN);
        Ok(DeviceId(out))
    }
}

/// This device's long-term P-256 key pair.
pub struct Identity {
    key: KeyPair,
    id: DeviceId,
}

impl Identity {
    /// Generate a fresh identity. Panics only if the operating system random source fails.
    pub fn generate() -> Identity {
        Identity::try_generate().expect("operating system random source failed")
    }

    /// Fallible variant of [`Identity::generate`].
    pub fn try_generate() -> Result<Identity> {
        Identity::from_keypair(KeyPair::generate()?)
    }

    /// Restore an identity from its 32-byte private scalar (see [`Identity::to_bytes`]).
    pub fn from_bytes(secret: &[u8]) -> Result<Identity> {
        Identity::from_keypair(KeyPair::from_secret_bytes(secret)?)
    }

    fn from_keypair(key: KeyPair) -> Result<Identity> {
        let id = DeviceId::from_public(key.public());
        Ok(Identity { key, id })
    }

    /// The 32-byte private scalar. Store it in the OS credential store; it is zeroized on drop.
    pub fn to_bytes(&self) -> Zeroizing<[u8; 32]> {
        self.key.secret_bytes()
    }

    /// The 65-byte SEC1 uncompressed public key.
    pub fn public(&self) -> &PublicKeyBytes {
        self.key.public()
    }

    /// The device id derived from the public key.
    pub fn id(&self) -> DeviceId {
        self.id
    }

    pub(crate) fn keypair(&self) -> &KeyPair {
        &self.key
    }
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// What a device persists after a successful pairing.
#[derive(Clone)]
pub struct PairRecord {
    /// The peer's device id (derived from `peer_public`).
    pub peer_id: DeviceId,
    /// The peer's long-term public key.
    pub peer_public: PublicKeyBytes,
    /// The 256-bit pair key. Secret.
    pub pair_key: [u8; PAIR_KEY_LEN],
    /// The peer's display name as confirmed during pairing.
    pub peer_name: String,
}

impl PairRecord {
    /// Build a record; validates the key and the name and derives the id.
    pub fn new(
        peer_public: &[u8],
        pair_key: [u8; PAIR_KEY_LEN],
        peer_name: &str,
    ) -> Result<PairRecord> {
        let peer_public = validate_public(peer_public)?;
        validate_device_name(peer_name)?;
        Ok(PairRecord {
            peer_id: DeviceId::from_public(&peer_public),
            peer_public,
            pair_key,
            peer_name: peer_name.to_string(),
        })
    }

    /// Serialize: `format(1) || peer_public(65) || pair_key(32) || len(1) || name`. Contains a secret.
    pub fn to_bytes(&self) -> Zeroizing<Vec<u8>> {
        let name = self.peer_name.as_bytes();
        let mut out = Zeroizing::new(Vec::with_capacity(
            1 + PUBLIC_KEY_LEN + PAIR_KEY_LEN + 1 + name.len(),
        ));
        out.push(1);
        out.extend_from_slice(&self.peer_public);
        out.extend_from_slice(&self.pair_key);
        // name is at most 32 characters of at most 4 bytes
        out.push(name.len() as u8);
        out.extend_from_slice(name);
        out
    }

    /// Parse the output of [`PairRecord::to_bytes`].
    pub fn from_bytes(bytes: &[u8]) -> Result<PairRecord> {
        if bytes.len() < 1 + PUBLIC_KEY_LEN + PAIR_KEY_LEN + 1 || bytes[0] != 1 {
            return Err(Error::InvalidInput("unrecognised pair record"));
        }
        let public = &bytes[1..1 + PUBLIC_KEY_LEN];
        let mut key = [0u8; PAIR_KEY_LEN];
        key.copy_from_slice(&bytes[1 + PUBLIC_KEY_LEN..1 + PUBLIC_KEY_LEN + PAIR_KEY_LEN]);
        let rest = &bytes[1 + PUBLIC_KEY_LEN + PAIR_KEY_LEN..];
        let n = usize::from(rest[0]);
        if rest.len() != 1 + n {
            return Err(Error::InvalidInput(
                "pair record has trailing or missing bytes",
            ));
        }
        let name = std::str::from_utf8(&rest[1..])
            .map_err(|_| Error::InvalidInput("pair record name is not UTF-8"))?;
        PairRecord::new(public, key, name)
    }
}

impl Drop for PairRecord {
    fn drop(&mut self) {
        self.pair_key.zeroize();
    }
}

impl fmt::Debug for PairRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairRecord")
            .field("peer_id", &self.peer_id)
            .field("peer_name", &self.peer_name)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_round_trip_and_known_value() {
        // RFC 4648: "foobar" -> MZXW6YTBOI======; the first 10 bytes "foobarbazq" -> MZXW6YTBOJRGC6TR
        let id = DeviceId::from_bytes(*b"foobarbazq");
        assert_eq!(id.to_string(), "MZXW6YTBOJRGC6TR");
        assert_eq!("mzxw6ytbojrgc6tr".parse::<DeviceId>().unwrap(), id);
        assert!("MZXW6YTBMJQXUZ3".parse::<DeviceId>().is_err());
        assert!("MZXW6YTBMJQXUZ31".parse::<DeviceId>().is_err());
    }

    #[test]
    fn identity_round_trip() {
        let a = Identity::generate();
        let b = Identity::from_bytes(&a.to_bytes()[..]).unwrap();
        assert_eq!(a.public(), b.public());
        assert_eq!(a.id(), b.id());
        assert_eq!(a.id(), DeviceId::from_public(a.public()));
        assert!(Identity::from_bytes(&[0u8; 32]).is_err());
        assert!(Identity::from_bytes(&[1u8; 31]).is_err());
    }

    #[test]
    fn pair_record_round_trip() {
        let peer = Identity::generate();
        let rec = PairRecord::new(peer.public(), [9u8; 32], "Pixel 9").unwrap();
        let back = PairRecord::from_bytes(&rec.to_bytes()).unwrap();
        assert_eq!(back.peer_id, peer.id());
        assert_eq!(back.pair_key, [9u8; 32]);
        assert_eq!(back.peer_name, "Pixel 9");
        let mut bytes = rec.to_bytes().to_vec();
        bytes.push(0);
        assert!(PairRecord::from_bytes(&bytes).is_err());
        assert!(PairRecord::from_bytes(&bytes[..10]).is_err());
        assert!(!format!("{rec:?}").contains("pair_key"));
    }
}
