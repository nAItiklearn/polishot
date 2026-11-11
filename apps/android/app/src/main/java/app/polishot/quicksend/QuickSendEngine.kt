package app.polishot.quicksend

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean

/** Why a quick-send operation did not complete, reduced to what the user can act on. */
enum class ProblemKind {
    /** The other device could not be reached (off, other network, firewall). */
    Unreachable,
    Declined,
    /** The other device does not know this one (pairing was removed on that side). */
    Unpaired,
    Busy,
    Timeout,
    TooLarge,
    BadFile,
    /** A user said the codes do not match, or walked away. */
    PairingCancelled,
    /** A device tried to pair while pairing mode was off. */
    PairingOff,
    TooManyAttempts,
    /** The connection broke mid-way. */
    Connection,
    Failed;

    companion object {
        fun from(e: QuickSendException): ProblemKind =
            when (e.failure) {
                Failure.DECLINED -> Declined
                Failure.PAIRING_REJECTED -> PairingCancelled
                Failure.UNPAIRED -> Unpaired
                Failure.TIMEOUT -> Timeout
                Failure.TOO_LARGE -> TooLarge
                Failure.UNSUPPORTED_TYPE, Failure.BAD_CONTENT -> BadFile
                Failure.PAIRING_DISABLED -> PairingOff
                Failure.RATE_LIMITED -> TooManyAttempts
                Failure.IO, Failure.CLOSED -> Connection
                Failure.REMOTE -> when (e.remoteCode) {
                    ErrorCode.BUSY -> Busy
                    ErrorCode.UNPAIRED -> Unpaired
                    ErrorCode.TOO_LARGE -> TooLarge
                    ErrorCode.UNSUPPORTED_TYPE, ErrorCode.BAD_CONTENT -> BadFile
                    ErrorCode.PAIRING_REJECTED -> PairingCancelled
                    ErrorCode.PAIRING_DISABLED -> PairingOff
                    ErrorCode.RATE_LIMITED -> TooManyAttempts
                    ErrorCode.TIMEOUT -> Timeout
                    else -> Failed
                }
                else -> Failed
            }
    }
}

/** Result of sending one image. */
sealed interface SendOutcome {
    data object Sent : SendOutcome
    data class Failed(val kind: ProblemKind) : SendOutcome
}

/**
 * Listener, pairing and sender for quick send, on top of the protocol library. No Android types, so it is tested with
 * real loopback sockets. Everything that needs a person is delegated to [Prompts], which block the worker thread
 * until the user answers (they must give up before the sender's 60 s limit).
 *
 * Rules from docs/QUICKSEND.md that live here:
 *  - the listener binds 0.0.0.0 on a port chosen by the OS and runs only between [startListening] and [stopListening];
 *  - `allowPairing` is true only while [pairingOpen] is (the pairing screen is open);
 *  - connections are capped and every protocol call has its own deadlines;
 *  - uploads are cut after [STALL_MILLIS] without progress ([StallWatchdog]);
 *  - received bytes are handed over untouched for the image decoder; names and keys are never logged.
 */
class QuickSendEngine(
    private val store: QuickSendStore,
    private val prompts: Prompts,
    private val ownName: () -> String,
    private val config: Config = Config(),
    private val stallMillis: Long = STALL_MILLIS,
) {
    interface Prompts {
        /** A paired device offers a file. Return true to accept. Called on a worker thread; may block up to ~45 s. */
        fun confirmOffer(offer: OfferInfo): Boolean

        /** Both screens show [sas]. Return true if the user says the codes match. May block up to ~110 s. */
        fun confirmPairing(sas: String, peerName: String, peerId: DeviceId): Boolean

        fun onReceived(file: ReceivedFile)
        fun onPaired(record: PairRecord)
        fun onProblem(kind: ProblemKind)
        fun onSendProgress(done: Long, total: Long)
    }

    private val executor: ExecutorService = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "polishot-quicksend").apply { isDaemon = true }
    }
    private val limiter = PairingRateLimiter()
    private val slots = Semaphore(MAX_CONNECTIONS)
    private var server: ServerSocket? = null

    /** True while a pairing (either direction) waits for its user; a second one is refused meanwhile. */
    private val pairingInFlight = AtomicBoolean(false)

    /** True only while the pairing screen is open. */
    @Volatile var pairingOpen: Boolean = false

    /** The port the listener is bound to, or null when not listening. */
    @get:Synchronized
    val port: Int? get() = server?.localPort

    /** Starts accepting connections and returns the port to advertise. Idempotent. */
    @Synchronized
    fun startListening(): Int {
        server?.let { return it.localPort }
        val s = ServerSocket()
        s.reuseAddress = true
        s.bind(InetSocketAddress(InetAddress.getByName("0.0.0.0"), 0), BACKLOG)
        server = s
        executor.execute { acceptLoop(s) }
        return s.localPort
    }

    @Synchronized
    fun stopListening() {
        server?.let { runCatching { it.close() } }
        server = null
    }

    /** Stops listening and the worker threads. The engine cannot be used afterwards. */
    fun shutdown() {
        stopListening()
        executor.shutdownNow()
    }

    private fun acceptLoop(s: ServerSocket) {
        var failures = 0
        while (!s.isClosed) {
            val socket = try {
                s.accept()
            } catch (e: IOException) {
                // Closing the listener ends the loop; any other error (a connection reset while being accepted, a
                // momentary shortage of file descriptors) must not silently stop the phone from receiving.
                if (s.isClosed || ++failures > MAX_ACCEPT_FAILURES) return
                try {
                    Thread.sleep(ACCEPT_RETRY_MILLIS)
                } catch (interrupted: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return
                }
                continue
            }
            failures = 0
            if (!slots.tryAcquire()) {
                runCatching { socket.close() } // too many at once: refuse instead of queueing
                continue
            }
            try {
                executor.execute {
                    try {
                        handle(socket)
                    } finally {
                        slots.release()
                    }
                }
            } catch (e: RejectedExecutionException) {
                slots.release()
                runCatching { socket.close() }
                return
            }
        }
    }

    private fun handle(socket: Socket) {
        try {
            val serveConfig = ServeConfig(
                identity = store.identity(),
                localName = Content.cleanDeviceName(ownName()),
                pairs = store.pairs(),
                allowPairing = pairingOpen && !pairingInFlight.get(),
                rateLimiter = limiter,
                config = config,
            )
            when (val incoming = QuickSend.serve(Transport.of(socket), serveConfig, null) { offer -> prompts.confirmOffer(offer) }) {
                is Incoming.Pairing -> finishPairing(incoming.pending)
                is Incoming.Received -> prompts.onReceived(incoming.file)
            }
        } catch (e: QuickSendException) {
            prompts.onProblem(ProblemKind.from(e))
        } catch (e: IOException) {
            prompts.onProblem(ProblemKind.Connection)
        } catch (e: OutOfMemoryError) {
            prompts.onProblem(ProblemKind.TooLarge)
        } catch (e: Exception) {
            // Keystore trouble, a host callback that threw: one failed connection must not end the listener thread.
            prompts.onProblem(ProblemKind.Failed)
        } finally {
            runCatching { socket.close() }
        }
    }

    /** Pairing as the side that opens the connection. Blocks until the pairing is done or has failed. */
    fun pairWith(host: String, port: Int) {
        val socket = try {
            connect(host, port)
        } catch (e: IOException) {
            prompts.onProblem(ProblemKind.Unreachable)
            return
        }
        try {
            val pending = QuickSend.pairInitiator(
                Transport.of(socket),
                store.identity(),
                Content.cleanDeviceName(ownName()),
                config,
            )
            finishPairing(pending)
        } catch (e: QuickSendException) {
            prompts.onProblem(ProblemKind.from(e))
        } catch (e: IOException) {
            prompts.onProblem(ProblemKind.Connection)
        } catch (e: Exception) {
            prompts.onProblem(ProblemKind.Failed)
        } finally {
            runCatching { socket.close() }
        }
    }

    private fun finishPairing(pending: PendingPairing) {
        pairingInFlight.set(true)
        try {
            val matches = try {
                prompts.confirmPairing(pending.sas, pending.peerName, pending.peerId)
            } catch (e: RuntimeException) {
                pending.cancel()
                throw e
            }
            try {
                // With `false` this tells the peer and throws PAIRING_REJECTED.
                val record = pending.confirm(matches)
                store.addPair(record)
                prompts.onPaired(record)
            } catch (e: QuickSendException) {
                prompts.onProblem(ProblemKind.from(e))
            }
        } finally {
            pairingInFlight.set(false)
        }
    }

    /** Sends [bytes] to the paired device listening at [host]:[port]. Blocks until the receiver confirms or it fails. */
    fun send(host: String, port: Int, pair: PairRecord, fileName: String, mime: String, bytes: ByteArray): SendOutcome {
        val socket = try {
            connect(host, port)
        } catch (e: IOException) {
            return SendOutcome.Failed(ProblemKind.Unreachable)
        }
        val watchdog = StallWatchdog(stallMillis) { runCatching { socket.close() } }
        watchdog.start()
        return try {
            QuickSend.sendFile(
                Transport.of(socket),
                store.identity(),
                pair,
                FileMeta(fileName, mime),
                bytes,
                config,
            ) { done, total ->
                watchdog.touch()
                prompts.onSendProgress(done, total)
            }
            SendOutcome.Sent
        } catch (e: QuickSendException) {
            SendOutcome.Failed(if (watchdog.hasFired) ProblemKind.Connection else ProblemKind.from(e))
        } catch (e: OutOfMemoryError) {
            SendOutcome.Failed(ProblemKind.TooLarge)
        } catch (e: Exception) {
            SendOutcome.Failed(if (watchdog.hasFired) ProblemKind.Connection else ProblemKind.Failed)
        } finally {
            watchdog.stop()
            runCatching { socket.close() }
        }
    }

    private fun connect(host: String, port: Int): Socket {
        val socket = Socket()
        try {
            socket.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MILLIS)
        } catch (e: IOException) {
            runCatching { socket.close() }
            throw e
        }
        return socket
    }

    companion object {
        const val STALL_MILLIS = 30_000L
        const val CONNECT_TIMEOUT_MILLIS = 5_000
        const val MAX_CONNECTIONS = 4
        private const val BACKLOG = 8
        private const val MAX_ACCEPT_FAILURES = 20
        private const val ACCEPT_RETRY_MILLIS = 100L
    }
}
