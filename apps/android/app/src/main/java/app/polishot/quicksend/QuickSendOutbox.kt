package app.polishot.quicksend

/**
 * Hands one rendered PNG from the editor to the "Send to" screen. Both live in this process, so the bytes (up to
 * about 37 MB) are held in memory instead of being copied to disk or squeezed through an Intent; they are removed
 * the moment the send screen takes them.
 */
object QuickSendOutbox {
    @Volatile
    private var pending: ByteArray? = null

    fun put(png: ByteArray) {
        pending = png
    }

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
