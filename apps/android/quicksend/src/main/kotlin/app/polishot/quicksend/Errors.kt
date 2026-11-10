package app.polishot.quicksend

/** Wire error codes carried by ERROR frames (spec section 11). */
enum class ErrorCode(val wire: Int) {
    UNSUPPORTED_VERSION(1),
    UNPAIRED(2),
    PAIRING_DISABLED(3),
    RATE_LIMITED(4),
    PROTOCOL(5),
    AUTH_FAILED(6),
    TOO_LARGE(7),
    UNSUPPORTED_TYPE(8),
    BAD_CONTENT(9),
    BUSY(10),
    TIMEOUT(11),
    INTERNAL(12),
    PAIRING_REJECTED(13);

    companion object {
        /** Unknown codes map to [INTERNAL]. */
        fun fromWire(value: Int): ErrorCode = entries.firstOrNull { it.wire == value } ?: INTERNAL
    }
}

/** What went wrong, locally or reported by the peer. */
enum class Failure {
    /** Transport failure other than timeout or close. */
    IO,

    /** A read deadline expired. */
    TIMEOUT,

    /** The peer closed the connection. */
    CLOSED,

    /** Malformed, unexpected or out-of-order message. */
    PROTOCOL,
    UNSUPPORTED_VERSION,

    /** A frame header announced more bytes than allowed. */
    FRAME_TOO_LARGE,

    /** AEAD authentication failed: tampered, replayed, dropped or reordered frame. */
    CRYPTO,

    /** The pair-key MAC did not verify. */
    AUTH_FAILED,

    /** The sender is not in the receiver's pair list (or vice versa). */
    UNPAIRED,
    PAIRING_DISABLED,
    RATE_LIMITED,

    /** The peer has our own device id. */
    SELF_PAIRING,

    /** The initiator's reveal does not match its commitment. */
    BAD_COMMITMENT,

    /** Pairing was rejected by the local or the remote user. */
    PAIRING_REJECTED,

    /** The receiving user declined the file. */
    DECLINED,
    TOO_LARGE,
    UNSUPPORTED_TYPE,

    /** Magic bytes, hash or length mismatch. */
    BAD_CONTENT,

    /** A local argument was invalid. */
    INVALID_INPUT,

    /** The peer reported an error; see [QuickSendException.remoteCode]. */
    REMOTE,
}

/** The only exception type this library throws for protocol, peer and input problems. */
class QuickSendException(
    val failure: Failure,
    message: String,
    /** The peer's code when [failure] is [Failure.REMOTE]. */
    val remoteCode: ErrorCode? = null,
    cause: Throwable? = null,
) : Exception("$failure: $message", cause) {

    /** The wire code to report to the peer for this error. */
    fun wireCode(): ErrorCode = when (failure) {
        Failure.TIMEOUT -> ErrorCode.TIMEOUT
        Failure.UNSUPPORTED_VERSION -> ErrorCode.UNSUPPORTED_VERSION
        Failure.AUTH_FAILED -> ErrorCode.AUTH_FAILED
        Failure.UNPAIRED -> ErrorCode.UNPAIRED
        Failure.PAIRING_DISABLED -> ErrorCode.PAIRING_DISABLED
        Failure.RATE_LIMITED -> ErrorCode.RATE_LIMITED
        Failure.PAIRING_REJECTED -> ErrorCode.PAIRING_REJECTED
        Failure.TOO_LARGE -> ErrorCode.TOO_LARGE
        Failure.UNSUPPORTED_TYPE -> ErrorCode.UNSUPPORTED_TYPE
        Failure.BAD_CONTENT -> ErrorCode.BAD_CONTENT
        Failure.REMOTE -> remoteCode ?: ErrorCode.INTERNAL
        Failure.PROTOCOL,
        Failure.FRAME_TOO_LARGE,
        Failure.CRYPTO,
        Failure.SELF_PAIRING,
        Failure.BAD_COMMITMENT -> ErrorCode.PROTOCOL
        Failure.IO,
        Failure.CLOSED,
        Failure.DECLINED,
        Failure.INVALID_INPUT -> ErrorCode.INTERNAL
    }
}

internal fun protocolError(message: String): QuickSendException = QuickSendException(Failure.PROTOCOL, message)

internal fun invalidInput(message: String): QuickSendException = QuickSendException(Failure.INVALID_INPUT, message)
