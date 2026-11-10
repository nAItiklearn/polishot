package app.polishot.quicksend

import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket

/**
 * A blocking, bidirectional byte stream. For a [Socket] the read timeout is applied with `soTimeout` before
 * every read so a stalled peer cannot hold a session open; for plain streams (tests, pipes) subclasses may
 * override [setReadTimeout], and the default does nothing.
 *
 * The library closes the transport when an operation ends (success or failure). The exception is a pairing
 * returned by `serve`/`pairInitiator`/`pairResponder`: its [PendingPairing] owns the transport until
 * `confirm` or `cancel` is called.
 */
open class Transport(
    val input: InputStream,
    val output: OutputStream,
    private val socket: Socket? = null,
) : Closeable {

    /** Apply a read timeout in milliseconds (always at least 1); streams without timeouts ignore it. */
    open fun setReadTimeout(millis: Int) {
        val s = socket ?: return
        s.soTimeout = millis
    }

    override fun close() {
        runCatching { output.close() }
        runCatching { input.close() }
        val s = socket
        if (s != null) runCatching { s.close() }
    }

    companion object {
        /** Wrap a connected socket. */
        fun of(socket: Socket): Transport = Transport(socket.getInputStream(), socket.getOutputStream(), socket)
    }
}
