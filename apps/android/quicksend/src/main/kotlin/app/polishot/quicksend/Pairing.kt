package app.polishot.quicksend

import java.io.ByteArrayOutputStream
import java.math.BigInteger

internal enum class Role { INITIATOR, RESPONDER }

/** Everything both sides compute once they hold both ephemeral keys (spec section 8.2). */
internal class Derived(val transcript: ByteArray, val sas: String, val pairKey: ByteArray)

/** `sha256(L_COMMIT || ver || ik_initiator || eph_initiator)`. */
internal fun commitment(version: Int, ik: ByteArray, eph: ByteArray): ByteArray =
    Crypto.sha256(Protocol.L_COMMIT, byteArrayOf(version.toByte()), ik, eph)

/** The six-digit SAS: HKDF(transcript, "polishot-sas", 8 bytes) as an unsigned 64-bit value mod 10^6. */
internal fun sasFromTranscript(transcript: ByteArray): String {
    val okm = Crypto.hkdf(ByteArray(0), transcript, Protocol.I_SAS, 8)
    val value = BigInteger(1, okm).mod(BigInteger.valueOf(1_000_000L)).toInt()
    return value.toString().padStart(6, '0')
}

private fun partyBytes(ik: ByteArray, eph: ByteArray, name: String): ByteArray {
    val out = ByteArrayOutputStream()
    out.write(ik)
    out.write(eph)
    putStr8(out, name)
    return out.toByteArray()
}

/** Compute transcript, SAS and pair key. Deterministic given the keys. */
internal fun derivePairing(
    version: Int,
    ownIk: EcKeyPair,
    ownEph: EcKeyPair,
    ownName: String,
    peerIk: ByteArray,
    peerEph: ByteArray,
    peerName: String,
): Derived {
    val ownId = DeviceId.fromPublic(ownIk.publicBytes)
    val peerId = DeviceId.fromPublic(peerIk)
    val own = partyBytes(ownIk.publicBytes, ownEph.publicBytes, ownName)
    val peer = partyBytes(peerIk, peerEph, peerName)
    val order = ownId.compareTo(peerId)
    if (order == 0) throw QuickSendException(Failure.SELF_PAIRING, "cannot pair a device with itself")
    val lo = if (order < 0) own else peer
    val hi = if (order < 0) peer else own
    val transcript = Crypto.sha256(Protocol.L_PAIR_T, byteArrayOf(version.toByte()), lo, hi)
    val sas = sasFromTranscript(transcript)

    val zEe = ownEph.ecdh(peerEph)
    val zSs = ownIk.ecdh(peerIk)
    val pairKey = Crypto.hkdf(transcript, zEe + zSs, Protocol.I_PAIR, Protocol.PAIR_KEY_LEN)
    return Derived(transcript, sas, pairKey)
}

/**
 * One side of a pairing whose keys are agreed but not yet trusted: the users must compare [sas].
 * Call [confirm] with the user's answer, or [cancel] to abandon the pairing. The transport stays open until then.
 */
class PendingPairing internal constructor(
    private val conn: Conn,
    private val role: Role,
    /** The six-digit code to show the user; group it as "123 456" for display. */
    val sas: String,
    internal val transcript: ByteArray,
    internal val pairKey: ByteArray,
    private val peerPublic: ByteArray,
    /** The peer's display name (covered by the SAS). */
    val peerName: String,
) {
    /** The peer's device id. */
    val peerId: DeviceId get() = DeviceId.fromPublic(peerPublic)

    /** A copy of the peer's long-term public key. */
    fun peerPublicKey(): ByteArray = peerPublic.copyOf()

    /** Abandon the pairing and close the connection. */
    fun cancel() {
        conn.close()
    }

    /**
     * Finish pairing with the user's answer to "do both screens show the same code?". Returns the record to
     * persist only if this user confirmed and the peer confirmed with a valid MAC. With `accepted == false` the
     * peer is told and [Failure.PAIRING_REJECTED] is thrown. The transport is closed either way.
     */
    fun confirm(accepted: Boolean): PairRecord {
        try {
            return confirmInner(accepted)
        } catch (e: QuickSendException) {
            if (e.failure != Failure.PAIRING_REJECTED) conn.report(e)
            throw e
        } finally {
            conn.close()
        }
    }

    private fun confirmInner(accepted: Boolean): PairRecord {
        val mine = if (role == Role.INITIATOR) Protocol.L_CONFIRM_I else Protocol.L_CONFIRM_R
        val theirs = if (role == Role.INITIATOR) Protocol.L_CONFIRM_R else Protocol.L_CONFIRM_I
        if (!accepted) {
            // Best effort: the outcome is the same whether or not the peer is still listening.
            try {
                conn.sendPlain(FrameType.PAIR_CONFIRM, ByteArray(33))
            } catch (e: QuickSendException) {
                // ignored on purpose
            }
            throw QuickSendException(Failure.PAIRING_REJECTED, "pairing rejected locally")
        }
        val msg = ByteArray(33)
        msg[0] = 1
        System.arraycopy(Crypto.hmacSha256(pairKey, mine, transcript), 0, msg, 1, 32)
        try {
            conn.sendPlain(FrameType.PAIR_CONFIRM, msg)
        } catch (e: QuickSendException) {
            // The peer may have rejected and hung up. Its decision, if it arrived before the close, is still
            // readable, and "rejected" is a more useful answer than "closed".
            if (e.failure == Failure.CLOSED && peerRejected(2_000L)) {
                throw QuickSendException(Failure.PAIRING_REJECTED, "pairing rejected by the peer")
            }
            throw e
        }

        val peer = readPeerConfirm(conn.config.timeouts.pairConfirmMs)
        when (peer.decision) {
            0 -> throw QuickSendException(Failure.PAIRING_REJECTED, "pairing rejected by the peer")
            1 -> Unit
            else -> throw protocolError("pair decision must be 0 or 1")
        }
        val expected = Crypto.hmacSha256(pairKey, theirs, transcript)
        if (!Crypto.constantTimeEquals(expected, peer.mac)) {
            throw QuickSendException(Failure.AUTH_FAILED, "pairing confirmation MAC mismatch")
        }
        return PairRecord(peerPublic, pairKey, peerName)
    }

    private class PeerConfirm(val decision: Int, val mac: ByteArray)

    private fun readPeerConfirm(timeoutMs: Long): PeerConfirm {
        val f = conn.recvPlain(timeoutMs)
        if (f.type != FrameType.PAIR_CONFIRM) throw protocolError("expected pair confirm")
        val p = Parser(f.body)
        val decision = p.u8()
        val mac = p.take(32)
        p.finish()
        return PeerConfirm(decision, mac)
    }

    private fun peerRejected(timeoutMs: Long): Boolean =
        try {
            readPeerConfirm(timeoutMs).decision == 0
        } catch (e: QuickSendException) {
            false
        }
}

internal fun pairInitiatorImpl(
    transport: Transport,
    identity: Identity,
    localName: String,
    config: Config,
    eph: EcKeyPair,
): PendingPairing {
    closeOnFailure(transport) { Content.validateDeviceName(localName) }
    val conn = Conn(transport, config)
    var handedOver = false
    try {
        val t = config.timeouts
        val ownId = identity.id
        conn.sendPlain(FrameType.HELLO, Hello.request(Protocol.INTENT_PAIR, ownId, null).encode())
        val reply = recvHello(conn, t.handshakeMs)
        val ver = checkReply(reply, Protocol.INTENT_PAIR)
        if (reply.id == ownId) throw QuickSendException(Failure.SELF_PAIRING, "cannot pair a device with itself")

        val req = ByteArrayOutputStream()
        req.write(identity.key.publicBytes)
        req.write(commitment(ver, identity.key.publicBytes, eph.publicBytes))
        putStr8(req, localName)
        conn.sendPlain(FrameType.PAIR_REQUEST, req.toByteArray())

        val resp = conn.recvPlain(t.handshakeMs)
        if (resp.type != FrameType.PAIR_RESPONSE) throw protocolError("expected pair response")
        val p = Parser(resp.body)
        val peerIk = p.take(Protocol.PUBLIC_KEY_LEN)
        Crypto.decodePublic(peerIk)
        val peerEph = p.take(Protocol.PUBLIC_KEY_LEN)
        Crypto.decodePublic(peerEph)
        val peerName = p.str8()
        p.finish()
        Content.validateDeviceName(peerName)
        if (DeviceId.fromPublic(peerIk) != reply.id) throw protocolError("responder key does not match its device id")

        conn.sendPlain(FrameType.PAIR_REVEAL, eph.publicBytes)
        val d = derivePairing(ver, identity.key, eph, localName, peerIk, peerEph, peerName)
        val pending = PendingPairing(conn, Role.INITIATOR, d.sas, d.transcript, d.pairKey, peerIk, peerName)
        handedOver = true
        return pending
    } catch (e: QuickSendException) {
        conn.report(e)
        throw e
    } finally {
        if (!handedOver) conn.close()
    }
}

/** Responder flow after the HELLO has been read, vetted and rate-limited. The caller reports errors and closes. */
internal fun responderRun(
    conn: Conn,
    hello: Hello,
    identity: Identity,
    name: String,
    eph: EcKeyPair,
): PendingPairing {
    val t = conn.config.timeouts
    val ownId = identity.id
    val ver = negotiate(hello)
    if (hello.id == ownId) throw QuickSendException(Failure.SELF_PAIRING, "cannot pair a device with itself")
    conn.sendPlain(FrameType.HELLO, Hello.reply(ver, Protocol.INTENT_PAIR, ownId, null).encode())

    val req = conn.recvPlain(t.handshakeMs)
    if (req.type != FrameType.PAIR_REQUEST) throw protocolError("expected pair request")
    val p = Parser(req.body)
    val peerIk = p.take(Protocol.PUBLIC_KEY_LEN)
    Crypto.decodePublic(peerIk)
    val commit = p.take(32)
    val peerName = p.str8()
    p.finish()
    Content.validateDeviceName(peerName)
    if (DeviceId.fromPublic(peerIk) != hello.id) throw protocolError("initiator key does not match its device id")

    val resp = ByteArrayOutputStream()
    resp.write(identity.key.publicBytes)
    resp.write(eph.publicBytes)
    putStr8(resp, name)
    conn.sendPlain(FrameType.PAIR_RESPONSE, resp.toByteArray())

    val reveal = conn.recvPlain(t.handshakeMs)
    if (reveal.type != FrameType.PAIR_REVEAL) throw protocolError("expected pair reveal")
    val peerEph = reveal.body
    Crypto.decodePublic(peerEph)
    if (!Crypto.constantTimeEquals(commitment(ver, peerIk, peerEph), commit)) {
        throw QuickSendException(Failure.BAD_COMMITMENT, "pairing commitment mismatch")
    }
    val d = derivePairing(ver, identity.key, eph, name, peerIk, peerEph, peerName)
    return PendingPairing(conn, Role.RESPONDER, d.sas, d.transcript, d.pairKey, peerIk, peerName)
}

internal fun pairResponderImpl(
    transport: Transport,
    identity: Identity,
    localName: String,
    limiter: PairingRateLimiter?,
    config: Config,
    eph: EcKeyPair,
): PendingPairing {
    closeOnFailure(transport) { Content.validateDeviceName(localName) }
    val conn = Conn(transport, config)
    var handedOver = false
    try {
        val hello = recvHello(conn, config.timeouts.handshakeMs)
        if (hello.intent != Protocol.INTENT_PAIR) throw protocolError("expected a pairing request")
        if (limiter != null && !limiter.tryAcquire()) {
            throw QuickSendException(Failure.RATE_LIMITED, "too many pairing attempts")
        }
        val pending = responderRun(conn, hello, identity, localName, eph)
        handedOver = true
        return pending
    } catch (e: QuickSendException) {
        conn.report(e)
        throw e
    } finally {
        if (!handedOver) conn.close()
    }
}
