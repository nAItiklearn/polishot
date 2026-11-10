//! Thin, audited-primitive wrappers: SHA-256, HMAC, HKDF, P-256 ECDH, AES-256-GCM framing keys.
//!
//! Nothing here touches the network. Every secret lives in a type that zeroizes on drop.

use aes_gcm::aead::{Aead, Nonce, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use p256::elliptic_curve::Generate;
use p256::{PublicKey, SecretKey};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::proto::{PUBLIC_KEY_LEN, TAG_LEN};

/// SEC1 uncompressed P-256 public key.
pub type PublicKeyBytes = [u8; PUBLIC_KEY_LEN];

/// SHA-256 over the concatenation of `parts`.
pub(crate) fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// HMAC-SHA256 over the concatenation of `parts`.
pub(crate) fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> Result<[u8; 32]> {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(key)
        .map_err(|_| Error::InvalidInput("bad MAC key length"))?;
    for p in parts {
        m.update(p);
    }
    Ok(m.finalize().into_bytes().into())
}

/// Constant-time equality. Unequal lengths compare false (lengths are public).
pub(crate) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// HKDF-SHA256 extract-then-expand. An empty `salt` is the RFC 5869 "no salt" case.
pub(crate) fn hkdf(salt: &[u8], ikm: &[u8], info: &[&[u8]], out: &mut [u8]) -> Result<()> {
    let h = Hkdf::<Sha256>::new(Some(salt), ikm);
    h.expand_multi_info(info, out)
        .map_err(|_| Error::InvalidInput("hkdf output too long"))
}

/// Check that `bytes` is a valid uncompressed P-256 point and return it as an array.
pub(crate) fn validate_public(bytes: &[u8]) -> Result<PublicKeyBytes> {
    if bytes.len() != PUBLIC_KEY_LEN || bytes[0] != 0x04 {
        return Err(Error::Protocol(
            "public key must be 65-byte uncompressed SEC1",
        ));
    }
    PublicKey::from_sec1_bytes(bytes)
        .map_err(|_| Error::Protocol("public key is not on the curve"))?;
    let mut out = [0u8; PUBLIC_KEY_LEN];
    out.copy_from_slice(bytes);
    Ok(out)
}

fn parse_public(bytes: &[u8]) -> Result<PublicKey> {
    PublicKey::from_sec1_bytes(bytes).map_err(|_| Error::Protocol("public key is not on the curve"))
}

/// A P-256 key pair (long-term identity or ephemeral).
pub(crate) struct KeyPair {
    secret: SecretKey,
    public: PublicKeyBytes,
}

impl KeyPair {
    pub(crate) fn generate() -> Result<KeyPair> {
        let secret = SecretKey::try_generate()
            .map_err(|_| Error::InvalidInput("operating system random source failed"))?;
        KeyPair::from_secret(secret)
    }

    pub(crate) fn from_secret_bytes(bytes: &[u8]) -> Result<KeyPair> {
        if bytes.len() != 32 {
            return Err(Error::InvalidInput("private key must be 32 bytes"));
        }
        let secret = SecretKey::from_slice(bytes)
            .map_err(|_| Error::InvalidInput("private key is not a valid P-256 scalar"))?;
        KeyPair::from_secret(secret)
    }

    fn from_secret(secret: SecretKey) -> Result<KeyPair> {
        let enc = secret.public_key().to_sec1_bytes();
        let public = validate_public(&enc)?;
        Ok(KeyPair { secret, public })
    }

    pub(crate) fn public(&self) -> &PublicKeyBytes {
        &self.public
    }

    pub(crate) fn secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(self.secret.to_bytes().as_slice());
        out
    }

    /// ECDH with a peer public key; returns the 32-byte X coordinate.
    pub(crate) fn ecdh(&self, peer: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
        let peer = parse_public(peer)?;
        let shared = self.secret.diffie_hellman(&peer);
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(shared.raw_secret_bytes().as_slice());
        Ok(out)
    }
}

/// One direction of the AES-256-GCM record layer.
///
/// Nonce = 4-byte direction tag || u64 big-endian counter; the counter is implicit and incremented only on
/// success, so a replayed, dropped, duplicated or reordered frame fails to authenticate.
pub(crate) struct Sealer {
    cipher: Aes256Gcm,
    tag: [u8; 4],
    counter: u64,
    ver: u8,
}

impl Sealer {
    pub(crate) fn new(key: &[u8; 32], tag: [u8; 4], ver: u8) -> Result<Sealer> {
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| Error::Crypto)?;
        Ok(Sealer {
            cipher,
            tag,
            counter: 0,
            ver,
        })
    }

    fn nonce(&self) -> Result<Nonce<Aes256Gcm>> {
        if self.counter == u64::MAX {
            return Err(Error::Protocol("frame counter exhausted"));
        }
        let mut n = [0u8; 12];
        n[..4].copy_from_slice(&self.tag);
        n[4..].copy_from_slice(&self.counter.to_be_bytes());
        Nonce::<Aes256Gcm>::try_from(&n[..]).map_err(|_| Error::Crypto)
    }

    /// Encrypt `plaintext`; `ty` is authenticated as associated data.
    pub(crate) fn seal(&mut self, ty: u8, plaintext: &[u8]) -> Result<Vec<u8>> {
        let nonce = self.nonce()?;
        let aad = [self.ver, ty];
        let out = self
            .cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| Error::Crypto)?;
        self.counter += 1;
        Ok(out)
    }

    /// Decrypt and authenticate `ciphertext` (including the tag).
    pub(crate) fn open(&mut self, ty: u8, ciphertext: &[u8]) -> Result<Vec<u8>> {
        if ciphertext.len() < TAG_LEN {
            return Err(Error::Crypto);
        }
        let nonce = self.nonce()?;
        let aad = [self.ver, ty];
        let out = self
            .cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| Error::Crypto)?;
        self.counter += 1;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hkdf_rfc5869_case_1() {
        // RFC 5869 appendix A.1
        let ikm = [0x0bu8; 22];
        let salt: Vec<u8> = (0x00..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();
        let mut okm = [0u8; 42];
        hkdf(&salt, &ikm, &[&info], &mut okm).unwrap();
        let expect =
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";
        assert_eq!(hex(&okm), expect);
    }

    #[test]
    fn hmac_rfc4231_case_2() {
        let mac = hmac_sha256(b"Jefe", &[b"what do ya want ", b"for nothing?"]).unwrap();
        assert_eq!(
            hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn sha256_abc() {
        assert_eq!(
            hex(&sha256(&[b"a", b"bc"])),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn ecdh_agrees_and_rejects_bad_points() {
        let a = KeyPair::generate().unwrap();
        let b = KeyPair::generate().unwrap();
        assert_eq!(*a.ecdh(b.public()).unwrap(), *b.ecdh(a.public()).unwrap());
        let mut bad = *b.public();
        bad[64] ^= 1;
        assert!(a.ecdh(&bad).is_err());
        assert!(validate_public(&[0u8; 65]).is_err());
        assert!(validate_public(&b.public()[..64]).is_err());
    }

    #[test]
    fn sealer_detects_replay_reorder_and_type_change() {
        let key = [7u8; 32];
        let mut tx = Sealer::new(&key, [0, 0, 0, 1], 1).unwrap();
        let mut rx = Sealer::new(&key, [0, 0, 0, 1], 1).unwrap();
        let c0 = tx.seal(0x14, b"zero").unwrap();
        let c1 = tx.seal(0x14, b"one").unwrap();
        // reordered: c1 first fails, and a failure does not advance the counter
        assert!(rx.open(0x14, &c1).is_err());
        assert_eq!(rx.open(0x14, &c0).unwrap(), b"zero");
        assert_eq!(rx.open(0x14, &c1).unwrap(), b"one");
        // replay of c1 fails
        assert!(rx.open(0x14, &c1).is_err());
        // wrong frame type fails
        let c2 = tx.seal(0x14, b"two").unwrap();
        assert!(rx.open(0x15, &c2).is_err());
        assert_eq!(rx.open(0x14, &c2).unwrap(), b"two");
        // flipped bit fails
        let mut c3 = tx.seal(0x14, b"three").unwrap();
        c3[0] ^= 1;
        assert!(rx.open(0x14, &c3).is_err());
    }

    pub(crate) fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
