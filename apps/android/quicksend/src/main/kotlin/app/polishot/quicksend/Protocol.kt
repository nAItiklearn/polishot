package app.polishot.quicksend

/**
 * Protocol constants. The normative description is docs/QUICKSEND.md; the Rust crate
 * `crates/polishot-quicksend` implements the same values and the two are tied together by
 * packages/quicksend-vectors/vectors.json.
 */
object Protocol {
    const val PROTOCOL_MIN: Int = 1
    const val PROTOCOL_MAX: Int = 1

    /** DNS-SD service type as written in the spec. */
    const val SERVICE_TYPE: String = "_polishot._tcp.local."

    /** The same service type in the form `NsdManager` expects. */
    const val NSD_SERVICE_TYPE: String = "_polishot._tcp."

    /** Largest frame (`len` field: type byte plus body). */
    const val MAX_FRAME: Int = 1 shl 20

    /** Largest frame accepted before the session is authenticated. */
    const val MAX_PLAIN_FRAME: Int = 1024
    const val TAG_LEN: Int = 16

    /** 50 MiB. */
    const val MAX_FILE_SIZE: Long = 50L * 1024L * 1024L

    /** Every chunk except the last carries exactly this many bytes. */
    const val CHUNK_SIZE: Int = 64 * 1024
    const val MAX_DEVICE_NAME_CHARS: Int = 32
    const val MAX_FILE_NAME_BYTES: Int = 128
    const val PUBLIC_KEY_LEN: Int = 65
    const val DEVICE_ID_LEN: Int = 10
    const val PAIR_KEY_LEN: Int = 32

    val ALLOWED_MIME: List<String> = listOf("image/png", "image/jpeg", "image/webp")

    internal const val INTENT_PAIR: Int = 1
    internal const val INTENT_TRANSFER: Int = 2

    internal val L_COMMIT: ByteArray = ascii("polishot-qs-commit-v1")
    internal val L_PAIR_T: ByteArray = ascii("polishot-qs-pair-transcript-v1")
    internal val L_XFER_T: ByteArray = ascii("polishot-qs-transfer-transcript-v1")
    internal val I_SAS: ByteArray = ascii("polishot-sas")
    internal val I_PAIR: ByteArray = ascii("polishot-pair-v1")
    internal val I_SESSION: ByteArray = ascii("polishot-session-v1")
    internal val L_CONFIRM_I: ByteArray = ascii("polishot-pair-confirm-i")
    internal val L_CONFIRM_R: ByteArray = ascii("polishot-pair-confirm-r")
    internal val L_AUTH_S: ByteArray = ascii("polishot-auth-s")
    internal val L_AUTH_R: ByteArray = ascii("polishot-auth-r")

    /** Direction tag in the AEAD nonce for sender-to-receiver frames. */
    internal val DIR_S2R: ByteArray = byteArrayOf(0, 0, 0, 1)

    /** Direction tag in the AEAD nonce for receiver-to-sender frames. */
    internal val DIR_R2S: ByteArray = byteArrayOf(0, 0, 0, 2)
}

internal fun ascii(s: String): ByteArray = s.toByteArray(Charsets.US_ASCII)

/** Frame type codes (the byte after the length). */
object FrameType {
    const val HELLO: Int = 0x01
    const val PAIR_REQUEST: Int = 0x02
    const val PAIR_RESPONSE: Int = 0x03
    const val PAIR_REVEAL: Int = 0x04
    const val PAIR_CONFIRM: Int = 0x05
    const val AUTH: Int = 0x10
    const val OFFER: Int = 0x11
    const val ACCEPT: Int = 0x12
    const val DECLINE: Int = 0x13
    const val CHUNK: Int = 0x14
    const val DONE: Int = 0x15
    const val ERROR: Int = 0x7F
}

/** Per-phase time limits in milliseconds (spec section 10). */
data class Timeouts(
    /** Each pre-authentication frame, and the wait for OFFER after AUTH. */
    val handshakeMs: Long = 10_000,
    /** The sender waits this long for ACCEPT or DECLINE. */
    val decisionMs: Long = 60_000,
    /** Each chunk frame. */
    val chunkMs: Long = 15_000,
    /** The sender waits this long for the final DONE. */
    val finishMs: Long = 15_000,
    /** Waiting for the peer user's pairing decision. */
    val pairConfirmMs: Long = 120_000,
    /** Wall-clock cap from AUTH to the end of the transfer. */
    val transferTotalMs: Long = 600_000,
)

/** Runtime configuration shared by every entry point. */
data class Config(
    val timeouts: Timeouts = Timeouts(),
    /** Largest file accepted or sent; clamped to [Protocol.MAX_FILE_SIZE]. */
    val maxFileSize: Long = Protocol.MAX_FILE_SIZE,
) {
    internal val sizeLimit: Long get() = minOf(maxFileSize, Protocol.MAX_FILE_SIZE)
}
