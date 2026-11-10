package app.polishot.quicksend

import java.io.ByteArrayOutputStream

/** HELLO message and version negotiation (spec sections 6 and 7). */
internal class Hello(
    val verMin: Int,
    val verMax: Int,
    val intent: Int,
    val id: DeviceId,
    /** Ephemeral public key, present exactly when [intent] is transfer. */
    val eph: ByteArray?,
) {
    fun encode(): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(verMin)
        out.write(verMax)
        out.write(intent)
        out.write(id.toBytes())
        if (eph != null) {
            out.write(Protocol.PUBLIC_KEY_LEN)
            out.write(eph)
        } else {
            out.write(0)
        }
        return out.toByteArray()
    }

    companion object {
        /** The initiator's opening HELLO: the full range of versions this build speaks. */
        fun request(intent: Int, id: DeviceId, eph: ByteArray?): Hello =
            Hello(Protocol.PROTOCOL_MIN, Protocol.PROTOCOL_MAX, intent, id, eph)

        /** The responder's HELLO: both bounds equal the chosen version. */
        fun reply(version: Int, intent: Int, id: DeviceId, eph: ByteArray?): Hello =
            Hello(version, version, intent, id, eph)

        fun parse(body: ByteArray): Hello {
            val p = Parser(body)
            val verMin = p.u8()
            val verMax = p.u8()
            if (verMin > verMax) throw protocolError("hello version range is empty")
            val intent = p.u8()
            val id = DeviceId.fromBytes(p.take(Protocol.DEVICE_ID_LEN))
            val ephLen = p.u8()
            val eph: ByteArray? = when {
                intent == Protocol.INTENT_PAIR && ephLen == 0 -> null
                intent == Protocol.INTENT_TRANSFER && ephLen == Protocol.PUBLIC_KEY_LEN -> {
                    val key = p.take(ephLen)
                    Crypto.decodePublic(key)
                    key
                }
                intent == Protocol.INTENT_PAIR || intent == Protocol.INTENT_TRANSFER ->
                    throw protocolError("hello ephemeral key length does not fit the intent")
                else -> throw protocolError("unknown hello intent")
            }
            p.finish()
            return Hello(verMin, verMax, intent, id, eph)
        }
    }
}

internal fun recvHello(conn: Conn, timeoutMs: Long): Hello {
    val f = conn.recvPlain(timeoutMs)
    if (f.type != FrameType.HELLO) throw protocolError("expected hello")
    return Hello.parse(f.body)
}

/** Responder side: pick the version for an initiator's HELLO. */
internal fun negotiate(initiator: Hello): Int {
    val chosen = minOf(initiator.verMax, Protocol.PROTOCOL_MAX)
    if (chosen >= maxOf(initiator.verMin, Protocol.PROTOCOL_MIN)) return chosen
    throw QuickSendException(Failure.UNSUPPORTED_VERSION, "no common protocol version")
}

/** Initiator side: validate the responder's reply and return the chosen version. */
internal fun checkReply(reply: Hello, intent: Int): Int {
    if (reply.verMin != reply.verMax) throw protocolError("hello reply must name exactly one version")
    val v = reply.verMax
    if (v < Protocol.PROTOCOL_MIN || v > Protocol.PROTOCOL_MAX) {
        throw QuickSendException(Failure.UNSUPPORTED_VERSION, "no common protocol version")
    }
    if (reply.intent != intent) throw protocolError("hello reply has a different intent")
    return v
}
