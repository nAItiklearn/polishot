package app.polishot.quicksend

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.Paths
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

internal fun hex(b: ByteArray): String {
    val sb = StringBuilder(b.size * 2)
    for (x in b) {
        val v = x.toInt() and 0xFF
        sb.append("0123456789abcdef"[v shr 4])
        sb.append("0123456789abcdef"[v and 15])
    }
    return sb.toString()
}

internal fun unhex(s: String): ByteArray {
    require(s.length % 2 == 0) { "odd hex length" }
    val out = ByteArray(s.length / 2)
    for (i in out.indices) {
        out[i] = ((Character.digit(s[2 * i], 16) shl 4) or Character.digit(s[2 * i + 1], 16)).toByte()
    }
    return out
}

internal fun concat(parts: List<ByteArray>): ByteArray {
    val out = ByteArrayOutputStream()
    for (p in parts) out.write(p)
    return out.toByteArray()
}

internal fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

/** The shared interop vectors written by the Rust crate. */
internal object Vectors {
    val root: JSONObject by lazy {
        val path = System.getProperty("quicksend.vectors") ?: error("system property quicksend.vectors is not set")
        JSONObject(String(Files.readAllBytes(Paths.get(path)), Charsets.UTF_8))
    }

    fun identity(name: String): Identity {
        val o = root.getJSONObject("identities").getJSONObject(name)
        return Identity.fromBytes(unhex(o.getString("private")) + unhex(o.getString("public")))
    }

    fun key(o: JSONObject): EcKeyPair = Crypto.keyPairFrom(unhex(o.getString("private")), unhex(o.getString("public")))

    val pairing: JSONObject get() = root.getJSONObject("pairing")
    val transfer: JSONObject get() = root.getJSONObject("transfer")
}

private val pool = Executors.newCachedThreadPool { r ->
    val t = Thread(r)
    t.isDaemon = true
    t
}

/** Run [block] on another thread, capturing a thrown exception in the [Result]. */
internal fun <T> async(block: () -> T): Future<Result<T>> = pool.submit(Callable { runCatching(block) })

internal fun <T> Future<Result<T>>.await(): Result<T> =
    try {
        get(30, TimeUnit.SECONDS)
    } catch (e: ExecutionException) {
        throw e.cause ?: e
    }

internal fun <T> Result<T>.failureKind(): Failure? = (exceptionOrNull() as? QuickSendException)?.failure

/** The remote code carried by a REMOTE failure. */
internal fun <T> Result<T>.remoteCode(): ErrorCode? = (exceptionOrNull() as? QuickSendException)?.remoteCode

// ---- in-memory duplex ----------------------------------------------------------------------------------------

private val EOF = ByteArray(0)

/** A one-directional byte pipe with blocking reads, an optional read timeout and an EOF marker. */
internal class Pipe {
    private val queue = LinkedBlockingQueue<ByteArray>()

    /** 0 = block forever. */
    @Volatile
    var readTimeoutMs: Long = 0L

    val output: OutputStream = object : OutputStream() {
        override fun write(b: Int) {
            queue.put(byteArrayOf(b.toByte()))
        }

        override fun write(b: ByteArray, off: Int, len: Int) {
            if (len > 0) queue.put(b.copyOfRange(off, off + len))
        }

        override fun close() {
            queue.put(EOF)
        }
    }

    val input: InputStream = object : InputStream() {
        private var current: ByteArray? = null
        private var pos = 0

        override fun read(): Int {
            val one = ByteArray(1)
            val n = read(one, 0, 1)
            return if (n < 0) -1 else one[0].toInt() and 0xFF
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            while (true) {
                val cur = current
                if (cur != null && pos < cur.size) {
                    val n = minOf(len, cur.size - pos)
                    System.arraycopy(cur, pos, b, off, n)
                    pos += n
                    return n
                }
                val timeout = readTimeoutMs
                val next = if (timeout > 0L) {
                    queue.poll(timeout, TimeUnit.MILLISECONDS) ?: throw java.net.SocketTimeoutException("read timed out")
                } else {
                    queue.take()
                }
                if (next === EOF) {
                    queue.put(EOF)
                    return -1
                }
                current = next
                pos = 0
            }
        }
    }
}

/** Rewrites the frames one side writes: `mutate(index, frame)` returns the frames to deliver instead. */
internal class MutatingOutput(
    private val inner: OutputStream,
    private val mutate: (Int, ByteArray) -> List<ByteArray>,
) : OutputStream() {
    private var index = 0

    override fun write(b: Int) {
        throw UnsupportedOperationException("frames are written with a single call")
    }

    override fun write(b: ByteArray, off: Int, len: Int) {
        val frame = b.copyOfRange(off, off + len)
        val i = index
        index += 1
        for (out in mutate(i, frame)) inner.write(out)
    }

    override fun flush() = inner.flush()

    override fun close() = inner.close()
}

/** A [Transport] over two pipes whose read timeout is honoured. */
internal class PipeTransport(private val inbound: Pipe, outbound: OutputStream) :
    Transport(inbound.input, outbound) {
    override fun setReadTimeout(millis: Int) {
        inbound.readTimeoutMs = millis.toLong()
    }
}

/**
 * Two connected transports. Frames written by the first one pass through [mutateFirstToSecond] when given,
 * which lets a test play an on-path attacker without any relay thread.
 */
internal fun duplex(
    mutateFirstToSecond: ((Int, ByteArray) -> List<ByteArray>)? = null,
): Pair<PipeTransport, PipeTransport> {
    val aToB = Pipe()
    val bToA = Pipe()
    val firstOut: OutputStream = if (mutateFirstToSecond == null) aToB.output else MutatingOutput(aToB.output, mutateFirstToSecond)
    return Pair(PipeTransport(bToA, firstOut), PipeTransport(aToB, bToA.output))
}

// ---- fixtures --------------------------------------------------------------------------------------------------

/** A deterministic fake PNG of [len] bytes. */
internal fun fakePng(len: Int): ByteArray {
    val out = ByteArray(len)
    val magic = unhex("89504e470d0a1a0a")
    var x = 0x12345678
    for (i in 0 until len) {
        if (i < magic.size) {
            out[i] = magic[i]
        } else {
            x = x * 1664525 + 1013904223
            out[i] = (x ushr 24).toByte()
        }
    }
    return out
}

internal class Paired(
    val a: Identity,
    val b: Identity,
    /** What a stored about b. */
    val aHasB: PairRecord,
    /** What b stored about a. */
    val bHasA: PairRecord,
    val sas: String,
)

/** Run a real pairing between two fresh identities. */
internal fun pairDevices(): Paired {
    val a = Identity.generate()
    val b = Identity.generate()
    val (ta, tb) = duplex()
    val responder = async {
        val p = QuickSend.pairResponder(tb, b, "Phone")
        val sas = p.sas
        Pair(sas, p.confirm(true))
    }
    val pa = QuickSend.pairInitiator(ta, a, "Studio PC")
    val sasA = pa.sas
    val recA = pa.confirm(true)
    val (sasB, recB) = responder.await().getOrThrow()
    check(sasA == sasB) { "SAS mismatch: $sasA vs $sasB" }
    return Paired(a, b, recA, recB, sasA)
}
