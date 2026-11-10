package app.polishot.quicksend

/**
 * Sliding-window limiter for pairing attempts: at most [max] in any [windowMillis] (spec section 8: 5 per
 * 60 seconds by default). Share one instance per listener; it is thread-safe.
 */
class PairingRateLimiter(
    private val max: Int = 5,
    private val windowMillis: Long = 60_000L,
) {
    private val hits = ArrayDeque<Long>()

    /** Record an attempt now; false means the attempt must be refused. */
    fun tryAcquire(): Boolean = tryAcquireAt(System.nanoTime())

    /** Like [tryAcquire] with an explicit monotonic clock in nanoseconds (for tests). */
    @Synchronized
    fun tryAcquireAt(nowNanos: Long): Boolean {
        val windowNanos = windowMillis * 1_000_000L
        while (hits.isNotEmpty() && nowNanos - hits.first() >= windowNanos) {
            hits.removeFirst()
        }
        if (hits.size >= max) return false
        hits.addLast(nowNanos)
        return true
    }
}
