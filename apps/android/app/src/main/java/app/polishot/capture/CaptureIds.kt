package app.polishot.capture

import java.security.SecureRandom

/**
 * Capture ids name files in app-private storage and appear in URLs served to the editor WebView
 * (`/capture/<id>.png`). They are validated with the same pattern the desktop app uses.
 */
object CaptureIds {
    private val ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val random = SecureRandom()

    fun isValid(id: String?): Boolean = id != null && ID_PATTERN.matches(id)

    /** A fresh id: base-36 timestamp plus 8 random hex digits, e.g. `m3k9x2ab-9f31c07e`. */
    fun generate(nowMillis: Long = System.currentTimeMillis()): String {
        val suffix = ByteArray(4).also { random.nextBytes(it) }
            .joinToString("") { "%02x".format(it.toInt() and 0xFF) }
        return nowMillis.toString(36) + "-" + suffix
    }

    /** `abc123.png` -> `abc123`; null for anything that is not a valid id followed by `.png`. */
    fun fromPngFileName(name: String): String? {
        if (!name.endsWith(".png")) return null
        val id = name.removeSuffix(".png")
        return if (isValid(id)) id else null
    }
}
