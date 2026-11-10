package app.polishot.quicksend

import java.io.ByteArrayOutputStream

/** What the sender describes about the file. Size and hash are computed from the bytes. */
class FileMeta(name: String, val mime: String) {
    /** Sanitized file name (spec section 2.2). */
    val name: String = Content.sanitizeFileName(name)
}

/** What the receiving user is asked to accept. */
class OfferInfo(
    /** The authenticated sender. */
    val peerId: DeviceId,
    /** The sender's name from its pair record. */
    val peerName: String,
    /** Sanitized file name. */
    val name: String,
    /** Validated MIME type. */
    val mime: String,
    /** Size in bytes, at most 50 MiB. */
    val size: Long,
)

/** A file that passed every check. The bytes are still untrusted input for the image decoder. */
class ReceivedFile(
    val peerId: DeviceId,
    /** Sanitized file name. Choose your own path; never build one from this alone. */
    val name: String,
    val mime: String,
    val data: ByteArray,
    /** SHA-256 of [data], as promised in the offer and verified. */
    val sha256: ByteArray,
)

/** Everything [QuickSend.serve] needs to handle one inbound connection. */
class ServeConfig(
    val identity: Identity,
    /** Name shown to a pairing peer; pass it through [Content.cleanDeviceName]. */
    val localName: String,
    /** Paired devices allowed to send. */
    val pairs: List<PairRecord>,
    /** True only while the user has the pairing screen open. */
    val allowPairing: Boolean,
    /** Limits pairing attempts across connections. */
    val rateLimiter: PairingRateLimiter? = null,
    val config: Config = Config(),
)

/** What an inbound connection turned out to be. */
sealed class Incoming {
    /** A peer wants to pair: show [PendingPairing.sas] and call [PendingPairing.confirm] or `cancel`. */
    class Pairing(val pending: PendingPairing) : Incoming()

    /** A file was received and verified. */
    class Received(val file: ReceivedFile) : Incoming()
}

/** Progress callback: bytes transferred so far and the total. */
typealias Progress = (done: Long, total: Long) -> Unit

/** Session keys and MACs derived from the handshake (spec section 9.1). */
internal class SessionKeys(
    val transcript: ByteArray,
    val kS2r: ByteArray,
    val kR2s: ByteArray,
    val authS: ByteArray,
    val authR: ByteArray,
)

internal fun deriveSession(
    version: Int,
    idS: DeviceId,
    idR: DeviceId,
    ephS: ByteArray,
    ephR: ByteArray,
    ownEph: EcKeyPair,
    peerEph: ByteArray,
    pairKey: ByteArray,
): SessionKeys {
    val transcript = Crypto.sha256(
        Protocol.L_XFER_T, byteArrayOf(version.toByte()), idS.toBytes(), idR.toBytes(), ephS, ephR,
    )
    val z = ownEph.ecdh(peerEph)
    val okm = Crypto.hkdf(pairKey, z, Protocol.I_SESSION + transcript, 64)
    return SessionKeys(
        transcript = transcript,
        kS2r = okm.copyOfRange(0, 32),
        kR2s = okm.copyOfRange(32, 64),
        authS = Crypto.hmacSha256(pairKey, Protocol.L_AUTH_S, transcript),
        authR = Crypto.hmacSha256(pairKey, Protocol.L_AUTH_R, transcript),
    )
}

/** Milliseconds left until [deadlineNanos]; throws TIMEOUT once it has passed. */
private fun remainingMs(deadlineNanos: Long): Long {
    val left = deadlineNanos - System.nanoTime()
    if (left <= 0L) throw QuickSendException(Failure.TIMEOUT, "transfer took too long")
    return maxOf(1L, left / 1_000_000L)
}

internal fun encodeOffer(size: Long, sha: ByteArray, mime: String, name: String): ByteArray {
    val out = ByteArrayOutputStream()
    out.write(u64Bytes(size))
    out.write(sha)
    putStr8(out, mime)
    putStr8(out, name)
    return out.toByteArray()
}

// ---------------------------------------------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------------------------------------------

internal fun precheckSend(meta: FileMeta, bytes: ByteArray, config: Config): Pair<String, ByteArray> {
    if (bytes.isEmpty()) throw invalidInput("file is empty")
    if (bytes.size.toLong() > config.sizeLimit) throw QuickSendException(Failure.TOO_LARGE, "file too large")
    if (!Content.isAllowedMime(meta.mime)) throw QuickSendException(Failure.UNSUPPORTED_TYPE, "unsupported file type")
    if (!Content.checkMagic(meta.mime, bytes)) {
        throw QuickSendException(Failure.BAD_CONTENT, "file contents do not match the declared type")
    }
    val name = Content.sanitizeFileName(meta.name)
    Content.validateWireFileName(name)
    return Pair(name, Crypto.sha256(bytes))
}

/** Handshake as the sender: HELLO exchange, key derivation, AUTH exchange, switch to sealed frames. */
internal fun senderHandshake(conn: Conn, identity: Identity, pair: PairRecord, eph: EcKeyPair) {
    val t = conn.config.timeouts
    val ownId = identity.id
    conn.sendPlain(
        FrameType.HELLO,
        Hello.request(Protocol.INTENT_TRANSFER, ownId, eph.publicBytes).encode(),
    )
    val reply = recvHello(conn, t.handshakeMs)
    val ver = checkReply(reply, Protocol.INTENT_TRANSFER)
    if (reply.id != pair.peerId) throw QuickSendException(Failure.UNPAIRED, "receiver is not the paired device")
    val peerEph = reply.eph ?: throw protocolError("receiver hello lacks an ephemeral key")
    val keys = deriveSession(ver, ownId, reply.id, eph.publicBytes, peerEph, eph, peerEph, pair.pairKey)

    conn.sendPlain(FrameType.AUTH, keys.authS)
    val auth = conn.recvPlain(t.handshakeMs)
    if (auth.type != FrameType.AUTH) throw protocolError("expected auth")
    if (!Crypto.constantTimeEquals(auth.body, keys.authR)) {
        throw QuickSendException(Failure.AUTH_FAILED, "receiver failed authentication")
    }
    conn.startEncryption(
        Sealer(keys.kS2r, Protocol.DIR_S2R, ver),
        Sealer(keys.kR2s, Protocol.DIR_R2S, ver),
    )
}

internal fun sendFileImpl(
    transport: Transport,
    identity: Identity,
    pair: PairRecord,
    meta: FileMeta,
    bytes: ByteArray,
    config: Config,
    progress: Progress?,
    eph: EcKeyPair,
) {
    val checked = try {
        precheckSend(meta, bytes, config)
    } catch (e: QuickSendException) {
        transport.close()
        throw e
    }
    val conn = Conn(transport, config)
    try {
        senderRun(conn, identity, pair, meta.mime, checked.first, checked.second, bytes, progress, eph)
    } catch (e: QuickSendException) {
        conn.report(e)
        throw e
    } finally {
        conn.close()
    }
}

private fun senderRun(
    conn: Conn,
    identity: Identity,
    pair: PairRecord,
    mime: String,
    name: String,
    digest: ByteArray,
    bytes: ByteArray,
    progress: Progress?,
    eph: EcKeyPair,
) {
    senderHandshake(conn, identity, pair, eph)
    val t = conn.config.timeouts
    val totalDeadline = System.nanoTime() + t.transferTotalMs * 1_000_000L
    val size = bytes.size.toLong()

    conn.sendSealed(FrameType.OFFER, encodeOffer(size, digest, mime, name))
    val answer = conn.recvSealed(minOf(t.decisionMs, remainingMs(totalDeadline)))
    when {
        answer.type == FrameType.ACCEPT && answer.body.isEmpty() -> Unit
        answer.type == FrameType.DECLINE && answer.body.isEmpty() ->
            throw QuickSendException(Failure.DECLINED, "the receiver declined the file")
        else -> throw protocolError("expected accept or decline")
    }

    var sent = 0L
    progress?.invoke(0L, size)
    var off = 0
    while (off < bytes.size) {
        remainingMs(totalDeadline)
        val n = minOf(Protocol.CHUNK_SIZE, bytes.size - off)
        conn.sendSealed(FrameType.CHUNK, bytes.copyOfRange(off, off + n))
        off += n
        sent += n.toLong()
        progress?.invoke(sent, size)
    }
    conn.sendSealed(FrameType.DONE, u64Bytes(size))
    val ack = conn.recvSealed(minOf(t.finishMs, remainingMs(totalDeadline)))
    if (ack.type != FrameType.DONE || ack.body.isNotEmpty()) throw protocolError("expected done acknowledgement")
}

// ---------------------------------------------------------------------------------------------------------------
// Receiver
// ---------------------------------------------------------------------------------------------------------------

/** Receiver handshake: vet the sender, answer HELLO, verify AUTH, switch to sealed frames. Returns its record. */
internal fun receiverHandshake(
    conn: Conn,
    hello: Hello,
    identity: Identity,
    pairs: List<PairRecord>,
    eph: EcKeyPair,
): PairRecord {
    val t = conn.config.timeouts
    if (hello.intent != Protocol.INTENT_TRANSFER) throw protocolError("expected a transfer request")
    val ver = negotiate(hello)
    val pair = pairs.firstOrNull { it.peerId == hello.id }
        ?: throw QuickSendException(Failure.UNPAIRED, "sender is not paired")
    val peerEph = hello.eph ?: throw protocolError("sender hello lacks an ephemeral key")
    val ownId = identity.id

    conn.sendPlain(
        FrameType.HELLO,
        Hello.reply(ver, Protocol.INTENT_TRANSFER, ownId, eph.publicBytes).encode(),
    )
    val keys = deriveSession(ver, hello.id, ownId, peerEph, eph.publicBytes, eph, peerEph, pair.pairKey)

    val auth = conn.recvPlain(t.handshakeMs)
    if (auth.type != FrameType.AUTH) throw protocolError("expected auth")
    if (!Crypto.constantTimeEquals(auth.body, keys.authS)) {
        throw QuickSendException(Failure.AUTH_FAILED, "sender failed authentication")
    }
    conn.sendPlain(FrameType.AUTH, keys.authR)
    conn.startEncryption(
        Sealer(keys.kR2s, Protocol.DIR_R2S, ver),
        Sealer(keys.kS2r, Protocol.DIR_S2R, ver),
    )
    return pair
}

/** Receiver flow after the HELLO has been read. The caller reports errors and closes. */
internal fun receiverRun(
    conn: Conn,
    hello: Hello,
    identity: Identity,
    pairs: List<PairRecord>,
    accept: (OfferInfo) -> Boolean,
    progress: Progress?,
    eph: EcKeyPair,
): ReceivedFile {
    val pair = receiverHandshake(conn, hello, identity, pairs, eph)
    val t = conn.config.timeouts
    val limit = conn.config.sizeLimit
    val totalDeadline = System.nanoTime() + t.transferTotalMs * 1_000_000L

    val offerFrame = conn.recvSealed(t.handshakeMs)
    if (offerFrame.type != FrameType.OFFER) throw protocolError("expected offer")
    val p = Parser(offerFrame.body)
    val size = p.u64()
    val digest = p.take(32)
    val mime = p.str8()
    val wireName = p.str8()
    p.finish()
    // a size with the top bit set reads as negative; it is larger than any limit
    if (size < 0L || size > limit) throw QuickSendException(Failure.TOO_LARGE, "file too large")
    if (size == 0L) throw protocolError("offer size must be positive")
    if (!Content.isAllowedMime(mime)) throw QuickSendException(Failure.UNSUPPORTED_TYPE, "unsupported file type")
    Content.validateWireFileName(wireName)
    val name = Content.sanitizeFileName(wireName)

    if (!accept(OfferInfo(pair.peerId, pair.peerName, name, mime, size))) {
        conn.sendSealed(FrameType.DECLINE, ByteArray(0))
        throw QuickSendException(Failure.DECLINED, "declined by the user")
    }
    conn.sendSealed(FrameType.ACCEPT, ByteArray(0))

    val total = size.toInt()
    val data = try {
        ByteArray(total)
    } catch (e: OutOfMemoryError) {
        // the user accepted, but this device cannot hold the file; tell the sender instead of crashing
        throw QuickSendException(Failure.TOO_LARGE, "not enough memory for the file")
    }
    var have = 0
    progress?.invoke(0L, size)
    while (have < total) {
        val want = minOf(Protocol.CHUNK_SIZE, total - have)
        val chunk = conn.recvSealed(minOf(t.chunkMs, remainingMs(totalDeadline)))
        if (chunk.type != FrameType.CHUNK) throw protocolError("expected chunk")
        if (chunk.body.size != want) throw protocolError("chunk has the wrong length")
        System.arraycopy(chunk.body, 0, data, have, want)
        have += want
        progress?.invoke(have.toLong(), size)
    }
    val done = conn.recvSealed(minOf(t.chunkMs, remainingMs(totalDeadline)))
    if (done.type != FrameType.DONE) throw protocolError("expected done")
    val dp = Parser(done.body)
    val announced = dp.u64()
    dp.finish()
    if (announced != size) throw QuickSendException(Failure.BAD_CONTENT, "length mismatch")
    val actual = Crypto.sha256(data)
    if (!Crypto.constantTimeEquals(actual, digest)) throw QuickSendException(Failure.BAD_CONTENT, "hash mismatch")
    if (!Content.checkMagic(mime, data)) {
        throw QuickSendException(Failure.BAD_CONTENT, "file contents do not match the declared type")
    }
    conn.sendSealed(FrameType.DONE, ByteArray(0))
    return ReceivedFile(pair.peerId, name, mime, data, actual)
}

internal fun receiveImpl(
    transport: Transport,
    identity: Identity,
    pairs: List<PairRecord>,
    config: Config,
    accept: (OfferInfo) -> Boolean,
    progress: Progress?,
    eph: EcKeyPair,
): ReceivedFile {
    val conn = Conn(transport, config)
    try {
        val hello = recvHello(conn, config.timeouts.handshakeMs)
        return receiverRun(conn, hello, identity, pairs, accept, progress, eph)
    } catch (e: QuickSendException) {
        conn.report(e)
        throw e
    } finally {
        conn.close()
    }
}

internal fun serveImpl(
    transport: Transport,
    sc: ServeConfig,
    accept: (OfferInfo) -> Boolean,
    progress: Progress?,
): Incoming {
    closeOnFailure(transport) { Content.validateDeviceName(sc.localName) }
    val conn = Conn(transport, sc.config)
    var keepOpen = false
    try {
        val hello = recvHello(conn, sc.config.timeouts.handshakeMs)
        val result: Incoming = when (hello.intent) {
            Protocol.INTENT_PAIR -> {
                if (!sc.allowPairing) {
                    throw QuickSendException(Failure.PAIRING_DISABLED, "pairing mode is off")
                }
                val limiter = sc.rateLimiter
                if (limiter != null && !limiter.tryAcquire()) {
                    throw QuickSendException(Failure.RATE_LIMITED, "too many pairing attempts")
                }
                val pending = responderRun(conn, hello, sc.identity, sc.localName, Crypto.generateKeyPair())
                keepOpen = true
                Incoming.Pairing(pending)
            }
            Protocol.INTENT_TRANSFER -> {
                val file = receiverRun(
                    conn, hello, sc.identity, sc.pairs, accept, progress, Crypto.generateKeyPair(),
                )
                Incoming.Received(file)
            }
            else -> throw protocolError("unknown intent")
        }
        return result
    } catch (e: QuickSendException) {
        conn.report(e)
        throw e
    } finally {
        if (!keepOpen) conn.close()
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------------------------------------------

/**
 * The quick-send API. Every call blocks, so run it on a worker thread (`Dispatchers.IO`). The library closes
 * the [Transport] when a call ends; a returned [PendingPairing] owns it until `confirm` or `cancel`.
 * Failures are [QuickSendException]s with a [Failure] kind.
 */
object QuickSend {

    /** Start pairing as the side that opened the connection. Blocks until the SAS is known. */
    fun pairInitiator(
        transport: Transport,
        identity: Identity,
        localName: String,
        config: Config = Config(),
    ): PendingPairing = pairInitiatorImpl(transport, identity, localName, config, Crypto.generateKeyPair())

    /** Answer a pairing request on a fresh connection; the first frame must be a pair-intent HELLO. */
    fun pairResponder(
        transport: Transport,
        identity: Identity,
        localName: String,
        limiter: PairingRateLimiter? = null,
        config: Config = Config(),
    ): PendingPairing = pairResponderImpl(transport, identity, localName, limiter, config, Crypto.generateKeyPair())

    /** Send [bytes] to the paired device at the other end of [transport]. Blocks until the receiver confirms. */
    fun sendFile(
        transport: Transport,
        identity: Identity,
        pair: PairRecord,
        meta: FileMeta,
        bytes: ByteArray,
        config: Config = Config(),
        progress: Progress? = null,
    ) = sendFileImpl(transport, identity, pair, meta, bytes, config, progress, Crypto.generateKeyPair())

    /**
     * Receive one file from a device in [pairs]. [accept] is called once with the offer; nothing is buffered
     * before it returns true. Throws [Failure.DECLINED] when it returns false.
     */
    fun receive(
        transport: Transport,
        identity: Identity,
        pairs: List<PairRecord>,
        config: Config = Config(),
        progress: Progress? = null,
        accept: (OfferInfo) -> Boolean,
    ): ReceivedFile = receiveImpl(transport, identity, pairs, config, accept, progress, Crypto.generateKeyPair())

    /** Handle one accepted connection: read the HELLO, then run pairing or a transfer. */
    fun serve(
        transport: Transport,
        serveConfig: ServeConfig,
        progress: Progress? = null,
        accept: (OfferInfo) -> Boolean,
    ): Incoming = serveImpl(transport, serveConfig, accept, progress)
}
