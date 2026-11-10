package app.polishot.quicksend

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Closes a connection whose upload stopped moving. The JVM has no write timeout for sockets, so a peer that stops
 * reading would block the sender forever; the library's own deadlines only cover reads.
 *
 * The watchdog is armed by the first [touch] (the library reports progress for the first time right after the
 * receiver accepted, so the wait for the user's decision is not counted) and every later [touch] resets the clock.
 * If more than [stallMillis] pass without progress, [onStall] runs once (closing the socket makes the blocked write
 * throw). [check] holds the whole decision, so tests can drive it with a fake clock and no thread.
 */
class StallWatchdog(
    private val stallMillis: Long,
    private val clock: () -> Long = { System.nanoTime() / 1_000_000L },
    private val onStall: () -> Unit,
) {
    private val armed = AtomicBoolean(false)
    private val fired = AtomicBoolean(false)
    private val last = AtomicLong(0L)
    @Volatile private var thread: Thread? = null

    /** Reports progress: arms the watchdog on first use and restarts the stall timer. */
    fun touch() {
        last.set(clock())
        armed.set(true)
    }

    /** Fires [onStall] (once) and returns true when armed and stalled; false otherwise. */
    fun check(): Boolean {
        if (!armed.get() || fired.get()) return false
        if (clock() - last.get() <= stallMillis) return false
        if (!fired.compareAndSet(false, true)) return false
        onStall()
        return true
    }

    val hasFired: Boolean get() = fired.get()

    /** Starts the background poller. */
    fun start() {
        val poll = (stallMillis / 4).coerceIn(50L, 1_000L)
        val t = Thread({
            try {
                while (!Thread.currentThread().isInterrupted) {
                    Thread.sleep(poll)
                    if (check()) return@Thread
                }
            } catch (e: InterruptedException) {
                // stop() was called
            }
        }, "polishot-quicksend-watchdog")
        t.isDaemon = true
        thread = t
        t.start()
    }

    fun stop() {
        thread?.interrupt()
        thread = null
    }
}
