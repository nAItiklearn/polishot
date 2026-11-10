package app.polishot.quicksend

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketException

internal class Frame(val type: Int, val body: ByteArray)

/** Run a local pre-check; if it throws, close [transport] first (the library owns it from the call on). */
internal inline fun closeOnFailure(transport: Transport, block: () -> Unit) {
    try {
        block()
    } catch (e: Throwable) {
        transport.close()
        throw e
    }
}

/** A transport plus the record-layer state of one session (mirrors the Rust `Conn`). */
internal class Conn(val transport: Transport, val config: Config) {
    private var sendSealer: Sealer? = null
    private var recvSealer: Sealer? = null

    val isSealed: Boolean get() = sendSealer != null

    fun startEncryption(send: Sealer, recv: Sealer) {
        sendSealer = send
        recvSealer = recv
    }

    fun close() = transport.close()

    private fun writeFrame(type: Int, body: ByteArray) {
        val len = 1 + body.size
        if (len > Protocol.MAX_FRAME) throw QuickSendException(Failure.FRAME_TOO_LARGE, "frame of $len bytes")
        val buf = ByteArray(4 + len)
        buf[0] = (len ushr 24).toByte()
        buf[1] = (len ushr 16).toByte()
        buf[2] = (len ushr 8).toByte()
        buf[3] = len.toByte()
        buf[4] = type.toByte()
        System.arraycopy(body, 0, buf, 5, body.size)
        try {
            transport.output.write(buf)
            transport.output.flush()
        } catch (e: IOException) {
            throw ioFailure(e)
        }
    }

    fun sendPlain(type: Int, body: ByteArray) {
        if (1 + body.size > Protocol.MAX_PLAIN_FRAME) {
            throw QuickSendException(Failure.FRAME_TOO_LARGE, "plain frame of ${1 + body.size} bytes")
        }
        writeFrame(type, body)
    }

    fun sendSealed(type: Int, body: ByteArray) {
        val sealer = sendSealer ?: throw protocolError("sealed frame before keys")
        writeFrame(type, sealer.seal(type, body))
    }

    /** Best effort: tell the peer why we are hanging up. Never throws. */
    fun sendError(code: ErrorCode) {
        val body = byteArrayOf((code.wire ushr 8).toByte(), code.wire.toByte())
        try {
            if (isSealed) sendSealed(FrameType.ERROR, body) else sendPlain(FrameType.ERROR, body)
        } catch (e: QuickSendException) {
            // the connection is already unusable
        }
    }

    /** Report a fatal local error to the peer when that is useful. */
    fun report(e: QuickSendException) {
        when (e.failure) {
            Failure.CLOSED, Failure.IO, Failure.REMOTE, Failure.DECLINED -> Unit
            else -> sendError(e.wireCode())
        }
    }

    private fun ioFailure(e: IOException): QuickSendException = when (e) {
        is java.net.SocketTimeoutException -> QuickSendException(Failure.TIMEOUT, "timed out", cause = e)
        is InterruptedIOException -> QuickSendException(Failure.TIMEOUT, "timed out", cause = e)
        is SocketException -> QuickSendException(Failure.CLOSED, "connection closed", cause = e)
        is java.io.EOFException -> QuickSendException(Failure.CLOSED, "connection closed", cause = e)
        else -> QuickSendException(Failure.IO, e.message ?: "i/o error", cause = e)
    }

    private fun readExact(buf: ByteArray, deadlineNanos: Long) {
        var filled = 0
        while (filled < buf.size) {
            val leftNanos = deadlineNanos - System.nanoTime()
            if (leftNanos <= 0L) throw QuickSendException(Failure.TIMEOUT, "timed out")
            val leftMs = (leftNanos / 1_000_000L).coerceIn(1L, Int.MAX_VALUE.toLong()).toInt()
            try {
                transport.setReadTimeout(leftMs)
            } catch (e: IOException) {
                throw ioFailure(e)
            }
            val n = try {
                transport.input.read(buf, filled, buf.size - filled)
            } catch (e: IOException) {
                throw ioFailure(e)
            }
            if (n < 0) throw QuickSendException(Failure.CLOSED, "connection closed")
            filled += n
        }
    }

    /** Read one raw frame, enforcing [maxLen] before the body is allocated. */
    private fun readFrame(timeoutMs: Long, maxLen: Int): Frame {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        val hdr = ByteArray(4)
        readExact(hdr, deadline)
        val len = ((hdr[0].toLong() and 0xFF) shl 24) or
            ((hdr[1].toLong() and 0xFF) shl 16) or
            ((hdr[2].toLong() and 0xFF) shl 8) or
            (hdr[3].toLong() and 0xFF)
        if (len == 0L) throw protocolError("empty frame")
        if (len > maxLen.toLong()) throw QuickSendException(Failure.FRAME_TOO_LARGE, "frame of $len bytes")
        val typeByte = ByteArray(1)
        readExact(typeByte, deadline)
        val body = ByteArray(len.toInt() - 1)
        readExact(body, deadline)
        return Frame(typeByte[0].toInt() and 0xFF, body)
    }

    private fun peerError(body: ByteArray): QuickSendException {
        if (body.size != 2) return protocolError("malformed error frame")
        val code = ((body[0].toInt() and 0xFF) shl 8) or (body[1].toInt() and 0xFF)
        val remote = ErrorCode.fromWire(code)
        return QuickSendException(Failure.REMOTE, "peer reported $remote", remoteCode = remote)
    }

    /** Read a plain (pre-authentication) frame. A peer ERROR becomes a REMOTE exception. */
    fun recvPlain(timeoutMs: Long): Frame {
        val f = readFrame(timeoutMs, Protocol.MAX_PLAIN_FRAME)
        if (f.type == FrameType.ERROR) throw peerError(f.body)
        return f
    }

    /** Read and open a sealed frame. A peer ERROR becomes a REMOTE exception. */
    fun recvSealed(timeoutMs: Long): Frame {
        val f = readFrame(timeoutMs, Protocol.MAX_FRAME)
        if (f.body.size < Protocol.TAG_LEN) throw QuickSendException(Failure.CRYPTO, "sealed frame too short")
        val sealer = recvSealer ?: throw protocolError("sealed frame before keys")
        val body = sealer.open(f.type, f.body)
        if (f.type == FrameType.ERROR) throw peerError(body)
        return Frame(f.type, body)
    }
}

/** Bounds-checked reader over a message body. Every accessor throws a protocol error instead of overrunning. */
internal class Parser(private val buf: ByteArray) {
    private var pos = 0

    fun take(n: Int): ByteArray {
        if (n < 0 || buf.size - pos < n) throw protocolError("message too short")
        val out = buf.copyOfRange(pos, pos + n)
        pos += n
        return out
    }

    fun u8(): Int = take(1)[0].toInt() and 0xFF

    /** An unsigned 64-bit value; callers must treat a negative result as "larger than any limit". */
    fun u64(): Long {
        val b = take(8)
        var v = 0L
        for (i in 0 until 8) v = (v shl 8) or (b[i].toLong() and 0xFF)
        return v
    }

    /** `str8`: one length byte, then that many UTF-8 bytes, strictly decoded. */
    fun str8(): String {
        val n = u8()
        return decodeUtf8Strict(take(n))
    }

    fun finish() {
        if (pos != buf.size) throw protocolError("trailing bytes in message")
    }
}

/** Append a `str8` field. */
internal fun putStr8(out: ByteArrayOutputStream, s: String) {
    val bytes = s.toByteArray(Charsets.UTF_8)
    if (bytes.size > 255) throw invalidInput("string longer than 255 bytes")
    out.write(bytes.size)
    out.write(bytes)
}

internal fun u64Bytes(v: Long): ByteArray {
    val out = ByteArray(8)
    for (i in 0 until 8) out[i] = (v ushr (56 - 8 * i)).toByte()
    return out
}
