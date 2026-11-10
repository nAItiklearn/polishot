package app.polishot.settings

/**
 * Pro brand mark (CONTRACTS section 5b): the user's own name or logo in the corner instead of the Polishot
 * watermark. Free never shows it: the page draws the default watermark unless `licensed` is true, however the
 * mark is set.
 */
enum class BrandMarkMode(val id: String) {
    Off("off"),
    Text("text"),
    Logo("logo");

    companion object {
        fun fromId(id: String?): BrandMarkMode = entries.firstOrNull { it.id == id } ?: Off
    }
}

/** What the editor page receives as `brandMark` (see packages/editor `BrandMark`). */
sealed interface BrandMarkPayload {
    data class Text(val text: String) : BrandMarkPayload

    /** A `data:image/png;base64,...` URL; the page CSP allows `data:` images and nothing remote. */
    data class Image(val dataUrl: String) : BrandMarkPayload
}

/** Text rules. They mirror `sanitizeBrandMark` in packages/editor, which re-checks everything in the page. */
object BrandMarkRules {
    /** BRAND_MARK_MAX_TEXT in packages/editor. */
    const val MAX_TEXT = 40

    /** Longest side of the stored logo; it is drawn at about two text lines tall, so this is generous. */
    const val MAX_LOGO_SIDE_PX = 512

    /** Largest stored logo file; keeps the base64 data URL far below the page's payload limit. */
    const val MAX_LOGO_BYTES = 1_000_000

    // Control characters plus the bidirectional overrides (U+202A..U+202E) and isolates (U+2066..U+2069).
    private val UNWANTED = Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]")

    /** Keeps what the user types while editing: control characters out, cut at [MAX_TEXT] characters, no trimming. */
    fun limitWhileTyping(raw: String): String = truncate(raw.replace(UNWANTED, " "))

    /** The final signature: whitespace normalised, trimmed and cut at [MAX_TEXT] characters. Empty means no mark. */
    fun cleanText(raw: String): String {
        val normalised = buildString {
            var lastWasSpace = false
            for (ch in raw.replace(UNWANTED, " ")) {
                val space = Character.isWhitespace(ch) || Character.isSpaceChar(ch)
                if (space) {
                    if (!lastWasSpace) append(' ')
                } else {
                    append(ch)
                }
                lastWasSpace = space
            }
        }.trim()
        return truncate(normalised).trim()
    }

    /** Cuts at [MAX_TEXT] Unicode characters (code points), never in the middle of a surrogate pair. */
    private fun truncate(text: String): String {
        if (text.codePointCount(0, text.length) <= MAX_TEXT) return text
        return text.substring(0, text.offsetByCodePoints(0, MAX_TEXT))
    }
}
