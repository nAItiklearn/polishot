package app.polishot.quicksend

/**
 * Hands one rendered PNG from the editor to the "Send to" screen. Both live in this process, so the bytes (up to
 * about 18 MB) are held in memory instead of being copied to disk or squeezed through an Intent. The send screen
 * [peek]s at them (so a recreated screen still has its image) and [clear]s them when it is done; a new [put]
 * replaces whatever was waiting.
 */
object QuickSendOutbox {
    @Volatile
    private var pending: ByteArray? = null

    fun put(png: ByteArray) {
        pending = png
    }

    /** The waiting image, which stays until [clear] or the next [put]. */
    fun peek(): ByteArray? = pending

    /** Returns the waiting image and forgets it. */
    fun take(): ByteArray? {
        val png = pending
        pending = null
        return png
    }

    fun clear() {
        pending = null
    }
}
