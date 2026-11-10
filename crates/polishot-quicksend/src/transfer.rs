//! Authenticated, encrypted file transfer between paired devices (spec section 9), and the listener entry
//! point [`serve`] that dispatches a new connection to pairing or transfer.

use std::time::{Duration, Instant};

use zeroize::Zeroizing;

use crate::content::{
    check_magic, is_allowed_mime, sanitize_file_name, validate_device_name, validate_wire_file_name,
};
use crate::crypto::{ct_eq, hkdf, hmac_sha256, sha256, KeyPair, PublicKeyBytes, Sealer};
use crate::error::{Error, Result};
use crate::frame::{put_str8, Conn, Parser};
use crate::hello::{check_reply, negotiate, recv_hello, Hello};
use crate::identity::{DeviceId, Identity, PairRecord};
use crate::pairing::{responder_after_hello, PendingPairing};
use crate::proto::{
    frame_type, Config, CHUNK_SIZE, DIR_R2S, DIR_S2R, INTENT_PAIR, INTENT_TRANSFER, I_SESSION,
    L_AUTH_R, L_AUTH_S, L_XFER_T,
};
use crate::ratelimit::PairingRateLimiter;
use crate::transport::Transport;

/// What the sender describes about the file. Size and hash are computed from the bytes.
#[derive(Clone, Debug)]
pub struct FileMeta {
    /// File name; sanitized by [`FileMeta::new`].
    pub name: String,
    /// One of `image/png`, `image/jpeg`, `image/webp`.
    pub mime: String,
}

impl FileMeta {
    /// Build metadata, sanitizing the name (spec section 2.2).
    pub fn new(name: &str, mime: &str) -> FileMeta {
        FileMeta {
            name: sanitize_file_name(name),
            mime: mime.to_string(),
        }
    }
}

/// What the receiving user is asked to accept.
#[derive(Clone, Debug)]
pub struct OfferInfo {
    /// The authenticated sender.
    pub peer_id: DeviceId,
    /// The sender's name from its pair record.
    pub peer_name: String,
    /// Sanitized file name.
    pub name: String,
    /// Validated MIME type.
    pub mime: String,
    /// Size in bytes, at most 50 MiB.
    pub size: u64,
}

/// A file that passed every check. The bytes are still untrusted input for the image decoder.
#[derive(Clone, Debug)]
pub struct ReceivedFile {
    /// The authenticated sender.
    pub peer_id: DeviceId,
    /// Sanitized file name. Choose your own path; never build one from this alone.
    pub name: String,
    /// Validated MIME type.
    pub mime: String,
    /// The file contents.
    pub data: Vec<u8>,
    /// SHA-256 of `data`, as promised in the offer and verified.
    pub sha256: [u8; 32],
}

/// Session keys and MACs derived from the handshake (spec section 9.1).
pub(crate) struct SessionKeys {
    /// Read by the interop vectors; the protocol itself only needs the keys and MACs.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) transcript: [u8; 32],
    pub(crate) k_s2r: Zeroizing<[u8; 32]>,
    pub(crate) k_r2s: Zeroizing<[u8; 32]>,
    pub(crate) auth_s: [u8; 32],
    pub(crate) auth_r: [u8; 32],
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn derive_session(
    ver: u8,
    id_s: &DeviceId,
    id_r: &DeviceId,
    e_s: &PublicKeyBytes,
    e_r: &PublicKeyBytes,
    own_eph: &KeyPair,
    peer_eph: &PublicKeyBytes,
    pair_key: &[u8; 32],
) -> Result<SessionKeys> {
    let transcript = sha256(&[L_XFER_T, &[ver], id_s.as_bytes(), id_r.as_bytes(), e_s, e_r]);
    let z = own_eph.ecdh(peer_eph)?;
    let mut okm = Zeroizing::new([0u8; 64]);
    hkdf(pair_key, &z[..], &[I_SESSION, &transcript], &mut okm[..])?;
    let mut k_s2r = Zeroizing::new([0u8; 32]);
    let mut k_r2s = Zeroizing::new([0u8; 32]);
    k_s2r.copy_from_slice(&okm[..32]);
    k_r2s.copy_from_slice(&okm[32..]);
    Ok(SessionKeys {
        transcript,
        k_s2r,
        k_r2s,
        auth_s: hmac_sha256(pair_key, &[L_AUTH_S, &transcript])?,
        auth_r: hmac_sha256(pair_key, &[L_AUTH_R, &transcript])?,
    })
}

fn remaining(deadline: Instant) -> Result<Duration> {
    let now = Instant::now();
    if now >= deadline {
        Err(Error::Timeout)
    } else {
        Ok(deadline - now)
    }
}

pub(crate) fn encode_offer(size: u64, sha: &[u8; 32], mime: &str, name: &str) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(8 + 32 + 2 + mime.len() + name.len());
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(sha);
    put_str8(&mut out, mime)?;
    put_str8(&mut out, name)?;
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------------------------------------------

/// Send `bytes` to the paired device at the other end of `stream`. Blocks until the receiver confirms.
pub fn send_file<S: Transport>(
    stream: S,
    identity: &Identity,
    pair: &PairRecord,
    meta: &FileMeta,
    bytes: &[u8],
) -> Result<()> {
    send_file_with(
        stream,
        identity,
        pair,
        meta,
        bytes,
        &Config::default(),
        &mut |_, _| {},
    )
}

/// [`send_file`] with explicit configuration and a progress callback `(bytes_sent, total)`.
pub fn send_file_with<S: Transport>(
    stream: S,
    identity: &Identity,
    pair: &PairRecord,
    meta: &FileMeta,
    bytes: &[u8],
    cfg: &Config,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<()> {
    send_file_impl(
        stream,
        identity,
        pair,
        meta,
        bytes,
        cfg,
        progress,
        KeyPair::generate()?,
    )
}

pub(crate) fn precheck_send(
    meta: &FileMeta,
    bytes: &[u8],
    cfg: &Config,
) -> Result<(String, [u8; 32])> {
    if bytes.is_empty() {
        return Err(Error::InvalidInput("file is empty"));
    }
    if bytes.len() as u64 > cfg.size_limit() {
        return Err(Error::TooLarge);
    }
    if !is_allowed_mime(&meta.mime) {
        return Err(Error::UnsupportedType);
    }
    if !check_magic(&meta.mime, bytes) {
        return Err(Error::BadContent(
            "file contents do not match the declared type",
        ));
    }
    let name = sanitize_file_name(&meta.name);
    validate_wire_file_name(&name)?;
    Ok((name, sha256(&[bytes])))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn send_file_impl<S: Transport>(
    stream: S,
    identity: &Identity,
    pair: &PairRecord,
    meta: &FileMeta,
    bytes: &[u8],
    cfg: &Config,
    progress: &mut dyn FnMut(u64, u64),
    eph: KeyPair,
) -> Result<()> {
    let (name, digest) = precheck_send(meta, bytes, cfg)?;
    let mut conn = Conn::new(stream, cfg.clone())?;
    let r = sender_run(
        &mut conn, identity, pair, &meta.mime, &name, &digest, bytes, progress, &eph,
    );
    if let Err(e) = &r {
        conn.report(e);
    }
    r
}

/// Handshake as the sender: HELLO exchange, key derivation, AUTH exchange, switch to sealed frames.
pub(crate) fn sender_handshake<S: Transport>(
    conn: &mut Conn<S>,
    identity: &Identity,
    pair: &PairRecord,
    eph: &KeyPair,
) -> Result<()> {
    let t = conn.cfg().timeouts.clone();
    let own_id = identity.id();
    conn.send_plain(
        crate::proto::frame_type::HELLO,
        &Hello::request(INTENT_TRANSFER, own_id, Some(eph.public())).encode(),
    )?;
    let reply = recv_hello(conn, t.handshake)?;
    let ver = check_reply(&reply, INTENT_TRANSFER)?;
    if reply.id != pair.peer_id {
        return Err(Error::Unpaired);
    }
    let peer_eph = reply
        .eph
        .ok_or(Error::Protocol("receiver hello lacks an ephemeral key"))?;
    let keys = derive_session(
        ver,
        &own_id,
        &reply.id,
        eph.public(),
        &peer_eph,
        eph,
        &peer_eph,
        &pair.pair_key,
    )?;

    conn.send_plain(frame_type::AUTH, &keys.auth_s)?;
    let (ty, body) = conn.recv_plain(t.handshake)?;
    if ty != frame_type::AUTH {
        return Err(Error::Protocol("expected auth"));
    }
    if !ct_eq(&body, &keys.auth_r) {
        return Err(Error::AuthFailed);
    }
    conn.start_encryption(
        Sealer::new(&keys.k_s2r, DIR_S2R, ver)?,
        Sealer::new(&keys.k_r2s, DIR_R2S, ver)?,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn sender_run<S: Transport>(
    conn: &mut Conn<S>,
    identity: &Identity,
    pair: &PairRecord,
    mime: &str,
    name: &str,
    digest: &[u8; 32],
    bytes: &[u8],
    progress: &mut dyn FnMut(u64, u64),
    eph: &KeyPair,
) -> Result<()> {
    sender_handshake(conn, identity, pair, eph)?;
    let t = conn.cfg().timeouts.clone();
    let total_deadline = Instant::now() + t.transfer_total;
    let size = bytes.len() as u64;

    conn.send_sealed(frame_type::OFFER, &encode_offer(size, digest, mime, name)?)?;
    let (ty, body) = conn.recv_sealed(t.decision.min(remaining(total_deadline)?))?;
    match ty {
        frame_type::ACCEPT if body.is_empty() => {}
        frame_type::DECLINE if body.is_empty() => return Err(Error::Declined),
        _ => return Err(Error::Protocol("expected accept or decline")),
    }

    let mut sent = 0u64;
    progress(0, size);
    for chunk in bytes.chunks(CHUNK_SIZE) {
        remaining(total_deadline)?;
        conn.send_sealed(frame_type::CHUNK, chunk)?;
        sent += chunk.len() as u64;
        progress(sent, size);
    }
    conn.send_sealed(frame_type::DONE, &size.to_be_bytes())?;
    let (ty, body) = conn.recv_sealed(t.finish.min(remaining(total_deadline)?))?;
    if ty != frame_type::DONE || !body.is_empty() {
        return Err(Error::Protocol("expected done acknowledgement"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Receiver
// ---------------------------------------------------------------------------------------------------------------

/// Receive one file. The first frame must be a transfer-intent HELLO from a device in `pairs`.
///
/// `accept` is called once with the offer and decides whether the transfer proceeds; nothing is buffered
/// before it returns `true`.
pub fn receive<S: Transport>(
    stream: S,
    identity: &Identity,
    pairs: &[PairRecord],
    accept: impl FnOnce(&OfferInfo) -> bool,
) -> Result<ReceivedFile> {
    receive_with(
        stream,
        identity,
        pairs,
        &Config::default(),
        accept,
        &mut |_, _| {},
    )
}

/// [`receive`] with explicit configuration and a progress callback `(bytes_received, total)`.
pub fn receive_with<S: Transport>(
    stream: S,
    identity: &Identity,
    pairs: &[PairRecord],
    cfg: &Config,
    accept: impl FnOnce(&OfferInfo) -> bool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<ReceivedFile> {
    receive_impl(
        stream,
        identity,
        pairs,
        cfg,
        accept,
        progress,
        KeyPair::generate()?,
    )
}

pub(crate) fn receive_impl<S: Transport>(
    stream: S,
    identity: &Identity,
    pairs: &[PairRecord],
    cfg: &Config,
    accept: impl FnOnce(&OfferInfo) -> bool,
    progress: &mut dyn FnMut(u64, u64),
    eph: KeyPair,
) -> Result<ReceivedFile> {
    let mut conn = Conn::new(stream, cfg.clone())?;
    let hello = match recv_hello(&mut conn, cfg.timeouts.handshake) {
        Ok(h) => h,
        Err(e) => {
            conn.report(&e);
            return Err(e);
        }
    };
    receive_after_hello(&mut conn, &hello, identity, pairs, accept, progress, eph)
}

/// Receiver handshake: vet the sender, answer HELLO, verify AUTH, switch to sealed frames.
/// Returns the sender's pair record.
pub(crate) fn receiver_handshake<'p, S: Transport>(
    conn: &mut Conn<S>,
    hello: &Hello,
    identity: &Identity,
    pairs: &'p [PairRecord],
    eph: &KeyPair,
) -> Result<&'p PairRecord> {
    let t = conn.cfg().timeouts.clone();
    if hello.intent != INTENT_TRANSFER {
        return Err(Error::Protocol("expected a transfer request"));
    }
    let ver = negotiate(hello)?;
    let pair = pairs
        .iter()
        .find(|p| p.peer_id == hello.id)
        .ok_or(Error::Unpaired)?;
    let peer_eph = hello
        .eph
        .ok_or(Error::Protocol("sender hello lacks an ephemeral key"))?;
    let own_id = identity.id();

    conn.send_plain(
        frame_type::HELLO,
        &Hello::reply(ver, INTENT_TRANSFER, own_id, Some(eph.public())).encode(),
    )?;
    let keys = derive_session(
        ver,
        &hello.id,
        &own_id,
        &peer_eph,
        eph.public(),
        eph,
        &peer_eph,
        &pair.pair_key,
    )?;

    let (ty, body) = conn.recv_plain(t.handshake)?;
    if ty != frame_type::AUTH {
        return Err(Error::Protocol("expected auth"));
    }
    if !ct_eq(&body, &keys.auth_s) {
        return Err(Error::AuthFailed);
    }
    conn.send_plain(frame_type::AUTH, &keys.auth_r)?;
    conn.start_encryption(
        Sealer::new(&keys.k_r2s, DIR_R2S, ver)?,
        Sealer::new(&keys.k_s2r, DIR_S2R, ver)?,
    );
    Ok(pair)
}

pub(crate) fn receive_after_hello<S: Transport>(
    conn: &mut Conn<S>,
    hello: &Hello,
    identity: &Identity,
    pairs: &[PairRecord],
    accept: impl FnOnce(&OfferInfo) -> bool,
    progress: &mut dyn FnMut(u64, u64),
    eph: KeyPair,
) -> Result<ReceivedFile> {
    let r = receiver_run(conn, hello, identity, pairs, accept, progress, &eph);
    if let Err(e) = &r {
        conn.report(e);
    }
    r
}

fn receiver_run<S: Transport>(
    conn: &mut Conn<S>,
    hello: &Hello,
    identity: &Identity,
    pairs: &[PairRecord],
    accept: impl FnOnce(&OfferInfo) -> bool,
    progress: &mut dyn FnMut(u64, u64),
    eph: &KeyPair,
) -> Result<ReceivedFile> {
    let pair = receiver_handshake(conn, hello, identity, pairs, eph)?;
    let t = conn.cfg().timeouts.clone();
    let limit = conn.cfg().size_limit();
    let total_deadline = Instant::now() + t.transfer_total;

    let (ty, body) = conn.recv_sealed(t.handshake)?;
    if ty != frame_type::OFFER {
        return Err(Error::Protocol("expected offer"));
    }
    let mut p = Parser::new(&body);
    let size = p.u64()?;
    let digest: [u8; 32] = p.array::<32>()?;
    let mime = p.str8()?.to_string();
    let wire_name = p.str8()?.to_string();
    p.finish()?;
    if size > limit {
        return Err(Error::TooLarge);
    }
    if size == 0 {
        return Err(Error::Protocol("offer size must be positive"));
    }
    if !is_allowed_mime(&mime) {
        return Err(Error::UnsupportedType);
    }
    validate_wire_file_name(&wire_name)?;
    let name = sanitize_file_name(&wire_name);

    let info = OfferInfo {
        peer_id: pair.peer_id,
        peer_name: pair.peer_name.clone(),
        name: name.clone(),
        mime: mime.clone(),
        size,
    };
    if !accept(&info) {
        conn.send_sealed(frame_type::DECLINE, &[])?;
        return Err(Error::Declined);
    }
    conn.send_sealed(frame_type::ACCEPT, &[])?;

    let capacity = usize::try_from(size).map_err(|_| Error::TooLarge)?;
    let mut data: Vec<u8> = Vec::with_capacity(capacity);
    progress(0, size);
    while (data.len() as u64) < size {
        let want = CHUNK_SIZE.min(capacity - data.len());
        let (ty, body) = conn.recv_sealed(t.chunk.min(remaining(total_deadline)?))?;
        if ty != frame_type::CHUNK {
            return Err(Error::Protocol("expected chunk"));
        }
        if body.len() != want {
            return Err(Error::Protocol("chunk has the wrong length"));
        }
        data.extend_from_slice(&body);
        progress(data.len() as u64, size);
    }
    let (ty, body) = conn.recv_sealed(t.chunk.min(remaining(total_deadline)?))?;
    if ty != frame_type::DONE {
        return Err(Error::Protocol("expected done"));
    }
    let mut p = Parser::new(&body);
    let total = p.u64()?;
    p.finish()?;
    if total != size || data.len() as u64 != size {
        return Err(Error::BadContent("length mismatch"));
    }
    let actual = sha256(&[&data]);
    if !ct_eq(&actual, &digest) {
        return Err(Error::BadContent("hash mismatch"));
    }
    if !check_magic(&mime, &data) {
        return Err(Error::BadContent(
            "file contents do not match the declared type",
        ));
    }
    conn.send_sealed(frame_type::DONE, &[])?;
    Ok(ReceivedFile {
        peer_id: pair.peer_id,
        name,
        mime,
        data,
        sha256: actual,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Listener entry point
// ---------------------------------------------------------------------------------------------------------------

/// Everything `serve` needs to handle one inbound connection.
pub struct ServeConfig<'a> {
    /// This device's identity.
    pub identity: &'a Identity,
    /// Name shown to a pairing peer (validated; use [`clean_device_name`](crate::clean_device_name)).
    pub local_name: &'a str,
    /// Paired devices allowed to send.
    pub pairs: &'a [PairRecord],
    /// True only while the user has the pairing screen open.
    pub allow_pairing: bool,
    /// Limits pairing attempts across connections.
    pub rate_limiter: Option<&'a PairingRateLimiter>,
    /// Protocol configuration.
    pub config: Config,
}

/// What an inbound connection turned out to be.
#[derive(Debug)]
pub enum Incoming<S: Transport> {
    /// A peer wants to pair: show [`PendingPairing::sas`] and call [`PendingPairing::confirm`].
    Pairing(Box<PendingPairing<S>>),
    /// A file was received and verified.
    Received(ReceivedFile),
}

/// Handle one accepted connection: read the HELLO, then run pairing or a transfer.
pub fn serve<S: Transport>(
    stream: S,
    sc: &ServeConfig<'_>,
    accept: impl FnOnce(&OfferInfo) -> bool,
) -> Result<Incoming<S>> {
    serve_with_progress(stream, sc, accept, &mut |_, _| {})
}

/// [`serve`] with a progress callback `(bytes_received, total)`.
pub fn serve_with_progress<S: Transport>(
    stream: S,
    sc: &ServeConfig<'_>,
    accept: impl FnOnce(&OfferInfo) -> bool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Incoming<S>> {
    validate_device_name(sc.local_name)?;
    let mut conn = Conn::new(stream, sc.config.clone())?;
    let hello = match recv_hello(&mut conn, sc.config.timeouts.handshake) {
        Ok(h) => h,
        Err(e) => {
            conn.report(&e);
            return Err(e);
        }
    };
    match hello.intent {
        INTENT_PAIR => {
            let gate = if !sc.allow_pairing {
                Err(Error::PairingDisabled)
            } else if sc.rate_limiter.is_some_and(|l| !l.try_acquire()) {
                Err(Error::RateLimited)
            } else {
                Ok(())
            };
            if let Err(e) = gate {
                conn.report(&e);
                return Err(e);
            }
            responder_after_hello(
                conn,
                hello,
                sc.identity,
                sc.local_name,
                KeyPair::generate()?,
            )
            .map(|p| Incoming::Pairing(Box::new(p)))
        }
        INTENT_TRANSFER => receive_after_hello(
            &mut conn,
            &hello,
            sc.identity,
            sc.pairs,
            accept,
            progress,
            KeyPair::generate()?,
        )
        .map(Incoming::Received),
        _ => {
            let e = Error::Protocol("unknown intent");
            conn.report(&e);
            Err(e)
        }
    }
}
