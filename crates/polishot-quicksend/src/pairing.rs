//! First-contact pairing with a short authentication string (spec section 8).
//!
//! Flow: HELLO, PAIR_REQUEST (initiator key + commitment), PAIR_RESPONSE (responder keys),
//! PAIR_REVEAL (initiator ephemeral key), then both users compare the SAS and exchange PAIR_CONFIRM.

use std::time::Duration;

use zeroize::Zeroizing;

use crate::content::validate_device_name;
use crate::crypto::{ct_eq, hkdf, hmac_sha256, sha256, validate_public, KeyPair, PublicKeyBytes};
use crate::error::{Error, Result};
use crate::frame::{put_str8, Conn, Parser};
use crate::hello::{check_reply, negotiate, recv_hello, Hello};
use crate::identity::{DeviceId, Identity, PairRecord};
use crate::proto::{
    frame_type, Config, INTENT_PAIR, I_PAIR, I_SAS, L_COMMIT, L_CONFIRM_I, L_CONFIRM_R, L_PAIR_T,
    PAIR_KEY_LEN, PUBLIC_KEY_LEN,
};
use crate::ratelimit::PairingRateLimiter;
use crate::transport::Transport;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Initiator,
    Responder,
}

/// One side of a pairing whose keys are agreed but not yet trusted: the users must compare the SAS.
///
/// Call [`PendingPairing::confirm`] with the user's answer. Dropping the value closes the connection and
/// abandons the pairing.
pub struct PendingPairing<S: Transport> {
    conn: Conn<S>,
    role: Role,
    sas: String,
    pub(crate) transcript: [u8; 32],
    pub(crate) pair_key: Zeroizing<[u8; PAIR_KEY_LEN]>,
    peer_public: PublicKeyBytes,
    peer_name: String,
}

impl<S: Transport> std::fmt::Debug for PendingPairing<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingPairing")
            .field("peer_name", &self.peer_name)
            .finish_non_exhaustive()
    }
}

/// Everything both sides compute once they hold both ephemeral keys.
pub(crate) struct Derived {
    pub(crate) transcript: [u8; 32],
    pub(crate) sas: String,
    pub(crate) pair_key: Zeroizing<[u8; PAIR_KEY_LEN]>,
}

fn party_bytes(ik: &[u8], eph: &[u8], name: &str) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(2 * PUBLIC_KEY_LEN + 1 + name.len());
    out.extend_from_slice(ik);
    out.extend_from_slice(eph);
    put_str8(&mut out, name)?;
    Ok(out)
}

/// `sha256(L_COMMIT || ver || ik_initiator || eph_initiator)`.
pub(crate) fn commitment(ver: u8, ik: &[u8], eph: &[u8]) -> [u8; 32] {
    sha256(&[L_COMMIT, &[ver], ik, eph])
}

/// The six-digit SAS from the transcript hash.
pub(crate) fn sas_from_transcript(transcript: &[u8; 32]) -> Result<String> {
    let mut okm = [0u8; 8];
    hkdf(&[], transcript, &[I_SAS], &mut okm)?;
    Ok(format!("{:06}", u64::from_be_bytes(okm) % 1_000_000))
}

/// Compute transcript, SAS and pair key (spec section 8.2). Deterministic given the keys.
pub(crate) fn derive(
    ver: u8,
    own_ik: &KeyPair,
    own_eph: &KeyPair,
    own_name: &str,
    peer_ik: &PublicKeyBytes,
    peer_eph: &PublicKeyBytes,
    peer_name: &str,
) -> Result<Derived> {
    let own_id = DeviceId::from_public(own_ik.public());
    let peer_id = DeviceId::from_public(peer_ik);
    let own = party_bytes(own_ik.public(), own_eph.public(), own_name)?;
    let peer = party_bytes(peer_ik, peer_eph, peer_name)?;
    let (lo, hi) = match own_id.cmp(&peer_id) {
        std::cmp::Ordering::Less => (&own, &peer),
        std::cmp::Ordering::Greater => (&peer, &own),
        std::cmp::Ordering::Equal => return Err(Error::SelfPairing),
    };
    let transcript = sha256(&[L_PAIR_T, &[ver], lo, hi]);
    let sas = sas_from_transcript(&transcript)?;

    let z_ee = own_eph.ecdh(peer_eph)?;
    let z_ss = own_ik.ecdh(peer_ik)?;
    let mut ikm = Zeroizing::new([0u8; 64]);
    ikm[..32].copy_from_slice(&z_ee[..]);
    ikm[32..].copy_from_slice(&z_ss[..]);
    let mut pair_key = Zeroizing::new([0u8; PAIR_KEY_LEN]);
    hkdf(&transcript, &ikm[..], &[I_PAIR], &mut pair_key[..])?;
    Ok(Derived {
        transcript,
        sas,
        pair_key,
    })
}

/// Start pairing as the side that opened the connection. Blocks until the SAS is known.
pub fn pair_initiator<S: Transport>(
    stream: S,
    identity: &Identity,
    local_name: &str,
) -> Result<PendingPairing<S>> {
    pair_initiator_with(stream, identity, local_name, &Config::default())
}

/// [`pair_initiator`] with explicit configuration.
pub fn pair_initiator_with<S: Transport>(
    stream: S,
    identity: &Identity,
    local_name: &str,
    cfg: &Config,
) -> Result<PendingPairing<S>> {
    initiator_impl(stream, identity, local_name, cfg, KeyPair::generate()?)
}

pub(crate) fn initiator_impl<S: Transport>(
    stream: S,
    identity: &Identity,
    local_name: &str,
    cfg: &Config,
    eph: KeyPair,
) -> Result<PendingPairing<S>> {
    validate_device_name(local_name)?;
    let mut conn = Conn::new(stream, cfg.clone())?;
    match initiator_run(&mut conn, identity, local_name, &eph) {
        Ok((derived, peer_public, peer_name)) => Ok(PendingPairing {
            conn,
            role: Role::Initiator,
            sas: derived.sas,
            transcript: derived.transcript,
            pair_key: derived.pair_key,
            peer_public,
            peer_name,
        }),
        Err(e) => {
            conn.report(&e);
            Err(e)
        }
    }
}

fn initiator_run<S: Transport>(
    conn: &mut Conn<S>,
    identity: &Identity,
    name: &str,
    eph: &KeyPair,
) -> Result<(Derived, PublicKeyBytes, String)> {
    let t = conn.cfg().timeouts.clone();
    let own_id = identity.id();

    conn.send_plain(
        frame_type::HELLO,
        &Hello::request(INTENT_PAIR, own_id, None).encode(),
    )?;
    let reply = recv_hello(conn, t.handshake)?;
    let ver = check_reply(&reply, INTENT_PAIR)?;
    if reply.id == own_id {
        return Err(Error::SelfPairing);
    }

    let mut req = Vec::with_capacity(2 * PUBLIC_KEY_LEN + 1 + name.len());
    req.extend_from_slice(identity.public());
    req.extend_from_slice(&commitment(ver, identity.public(), eph.public()));
    put_str8(&mut req, name)?;
    conn.send_plain(frame_type::PAIR_REQUEST, &req)?;

    let (ty, body) = conn.recv_plain(t.handshake)?;
    if ty != frame_type::PAIR_RESPONSE {
        return Err(Error::Protocol("expected pair response"));
    }
    let mut p = Parser::new(&body);
    let peer_ik = validate_public(p.take(PUBLIC_KEY_LEN)?)?;
    let peer_eph = validate_public(p.take(PUBLIC_KEY_LEN)?)?;
    let peer_name = p.str8()?.to_string();
    p.finish()?;
    validate_device_name(&peer_name)?;
    if DeviceId::from_public(&peer_ik) != reply.id {
        return Err(Error::Protocol(
            "responder key does not match its device id",
        ));
    }

    conn.send_plain(frame_type::PAIR_REVEAL, eph.public())?;
    let derived = derive(
        ver,
        identity.keypair(),
        eph,
        name,
        &peer_ik,
        &peer_eph,
        &peer_name,
    )?;
    Ok((derived, peer_ik, peer_name))
}

/// Answer a pairing request on a fresh connection. The first frame must be a pair-intent HELLO.
pub fn pair_responder<S: Transport>(
    stream: S,
    identity: &Identity,
    local_name: &str,
) -> Result<PendingPairing<S>> {
    pair_responder_with(stream, identity, local_name, None, &Config::default())
}

/// [`pair_responder`] with an optional attempt limiter and explicit configuration.
pub fn pair_responder_with<S: Transport>(
    stream: S,
    identity: &Identity,
    local_name: &str,
    limiter: Option<&PairingRateLimiter>,
    cfg: &Config,
) -> Result<PendingPairing<S>> {
    pair_responder_impl(
        stream,
        identity,
        local_name,
        limiter,
        cfg,
        KeyPair::generate()?,
    )
}

pub(crate) fn pair_responder_impl<S: Transport>(
    stream: S,
    identity: &Identity,
    local_name: &str,
    limiter: Option<&PairingRateLimiter>,
    cfg: &Config,
    eph: KeyPair,
) -> Result<PendingPairing<S>> {
    validate_device_name(local_name)?;
    let mut conn = Conn::new(stream, cfg.clone())?;
    let hello = match recv_hello(&mut conn, cfg.timeouts.handshake) {
        Ok(h) => h,
        Err(e) => {
            conn.report(&e);
            return Err(e);
        }
    };
    if hello.intent != INTENT_PAIR {
        let e = Error::Protocol("expected a pairing request");
        conn.report(&e);
        return Err(e);
    }
    if let Some(l) = limiter {
        if !l.try_acquire() {
            conn.report(&Error::RateLimited);
            return Err(Error::RateLimited);
        }
    }
    responder_after_hello(conn, hello, identity, local_name, eph)
}

/// Continue a pairing whose HELLO has been read, vetted and rate-limited by the caller.
pub(crate) fn responder_after_hello<S: Transport>(
    mut conn: Conn<S>,
    hello: Hello,
    identity: &Identity,
    name: &str,
    eph: KeyPair,
) -> Result<PendingPairing<S>> {
    match responder_run(&mut conn, &hello, identity, name, &eph) {
        Ok((derived, peer_public, peer_name)) => Ok(PendingPairing {
            conn,
            role: Role::Responder,
            sas: derived.sas,
            transcript: derived.transcript,
            pair_key: derived.pair_key,
            peer_public,
            peer_name,
        }),
        Err(e) => {
            conn.report(&e);
            Err(e)
        }
    }
}

fn responder_run<S: Transport>(
    conn: &mut Conn<S>,
    hello: &Hello,
    identity: &Identity,
    name: &str,
    eph: &KeyPair,
) -> Result<(Derived, PublicKeyBytes, String)> {
    let t = conn.cfg().timeouts.clone();
    let own_id = identity.id();
    let ver = negotiate(hello)?;
    if hello.id == own_id {
        return Err(Error::SelfPairing);
    }
    conn.send_plain(
        frame_type::HELLO,
        &Hello::reply(ver, INTENT_PAIR, own_id, None).encode(),
    )?;

    let (ty, body) = conn.recv_plain(t.handshake)?;
    if ty != frame_type::PAIR_REQUEST {
        return Err(Error::Protocol("expected pair request"));
    }
    let mut p = Parser::new(&body);
    let peer_ik = validate_public(p.take(PUBLIC_KEY_LEN)?)?;
    let commit: [u8; 32] = p.array::<32>()?;
    let peer_name = p.str8()?.to_string();
    p.finish()?;
    validate_device_name(&peer_name)?;
    if DeviceId::from_public(&peer_ik) != hello.id {
        return Err(Error::Protocol(
            "initiator key does not match its device id",
        ));
    }

    let mut resp = Vec::with_capacity(2 * PUBLIC_KEY_LEN + 1 + name.len());
    resp.extend_from_slice(identity.public());
    resp.extend_from_slice(eph.public());
    put_str8(&mut resp, name)?;
    conn.send_plain(frame_type::PAIR_RESPONSE, &resp)?;

    let (ty, body) = conn.recv_plain(t.handshake)?;
    if ty != frame_type::PAIR_REVEAL {
        return Err(Error::Protocol("expected pair reveal"));
    }
    let peer_eph = validate_public(&body)?;
    if !ct_eq(&commitment(ver, &peer_ik, &peer_eph), &commit) {
        return Err(Error::BadCommitment);
    }
    let derived = derive(
        ver,
        identity.keypair(),
        eph,
        name,
        &peer_ik,
        &peer_eph,
        &peer_name,
    )?;
    Ok((derived, peer_ik, peer_name))
}

impl<S: Transport> PendingPairing<S> {
    /// The six-digit code to show the user, for example `"042 917"` after grouping by the UI.
    pub fn sas(&self) -> &str {
        &self.sas
    }

    /// The peer's device id.
    pub fn peer_id(&self) -> DeviceId {
        DeviceId::from_public(&self.peer_public)
    }

    /// The peer's display name (covered by the SAS).
    pub fn peer_name(&self) -> &str {
        &self.peer_name
    }

    /// The peer's long-term public key.
    pub fn peer_public(&self) -> &PublicKeyBytes {
        &self.peer_public
    }

    /// Finish pairing with the user's answer to "do both screens show the same code?".
    ///
    /// Returns the record to persist only if this user confirmed and the peer confirmed with a valid MAC.
    /// `accepted == false` tells the peer and returns [`Error::PairingRejected`].
    pub fn confirm(mut self, accepted: bool) -> Result<PairRecord> {
        let r = self.confirm_inner(accepted);
        if let Err(e) = &r {
            if !matches!(e, Error::PairingRejected) {
                self.conn.report(e);
            }
        }
        r
    }

    fn confirm_inner(&mut self, accepted: bool) -> Result<PairRecord> {
        let (mine, theirs) = match self.role {
            Role::Initiator => (L_CONFIRM_I, L_CONFIRM_R),
            Role::Responder => (L_CONFIRM_R, L_CONFIRM_I),
        };
        if !accepted {
            // Best effort: the outcome is the same whether or not the peer is still listening.
            let _ = self.conn.send_plain(frame_type::PAIR_CONFIRM, &[0u8; 33]);
            return Err(Error::PairingRejected);
        }
        let mut msg = Vec::with_capacity(33);
        msg.push(1);
        msg.extend_from_slice(&hmac_sha256(&self.pair_key[..], &[mine, &self.transcript])?);
        if let Err(e) = self.conn.send_plain(frame_type::PAIR_CONFIRM, &msg) {
            // The peer may have rejected and hung up. Its decision, if it arrived before the close, is still
            // readable, and "rejected" is a more useful answer than "closed".
            if matches!(e, Error::Closed) && self.peer_rejected(Duration::from_secs(2)) {
                return Err(Error::PairingRejected);
            }
            return Err(e);
        }

        let wait = self.conn.cfg().timeouts.pair_confirm;
        let (decision, mac) = self.read_peer_confirm(wait)?;
        match decision {
            0 => return Err(Error::PairingRejected),
            1 => {}
            _ => return Err(Error::Protocol("pair decision must be 0 or 1")),
        }
        let expected = hmac_sha256(&self.pair_key[..], &[theirs, &self.transcript])?;
        if !ct_eq(&expected, &mac) {
            return Err(Error::AuthFailed);
        }
        PairRecord::new(&self.peer_public, *self.pair_key, &self.peer_name)
    }

    fn read_peer_confirm(&mut self, wait: Duration) -> Result<(u8, [u8; 32])> {
        let (ty, body) = self.conn.recv_plain(wait)?;
        if ty != frame_type::PAIR_CONFIRM {
            return Err(Error::Protocol("expected pair confirm"));
        }
        let mut p = Parser::new(&body);
        let decision = p.u8()?;
        let mac: [u8; 32] = p.array::<32>()?;
        p.finish()?;
        Ok((decision, mac))
    }

    fn peer_rejected(&mut self, wait: Duration) -> bool {
        matches!(self.read_peer_confirm(wait), Ok((0, _)))
    }
}
