package app.polishot.editor

import app.polishot.APP_SLUG
import app.polishot.capture.CaptureIds
import java.io.IOException
import java.io.InputStream
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Base64
import org.json.JSONException
import org.json.JSONObject

/** An image that passed every check and is safe to write to disk or hand to another app. */
class DecodedImage(val bytes: ByteArray, val mime: String) {
    val extension: String get() = BridgeValidation.extensionFor(mime)
}

sealed interface ImageCheck {
    class Ok(val image: DecodedImage) : ImageCheck
    data class Rejected(val reason: String) : ImageCheck
}

/**
 * Everything the WebView page sends through `PolishotAndroid` is untrusted input: the page is our own code, but
 * a compromised or buggy page must not be able to write arbitrary files, exhaust memory or smuggle path
 * separators into file names. Native code validates every argument here before acting on it.
 *
 * Pure Kotlin (no Android types) so it is covered by plain JVM tests.
 */
object BridgeValidation {
    /**
     * Cap on the base64 text of one image: 24 MiB of text, about 18 MiB of image data. A bigger string would need
     * several times its size in memory to decode (the string, its bytes and the result), which a phone cannot
     * always spare; a screenshot export never comes close (a 3x PNG of a tall phone screen is 5 to 12 MiB).
     */
    const val MAX_BASE64_CHARS: Int = 24 * 1024 * 1024

    /** Cap on a binary image message (the same 18 MiB, without the base64 overhead). */
    const val MAX_IMAGE_BYTES: Int = 18 * 1024 * 1024
    const val MAX_TEXT_CHARS: Int = 500_000

    /**
     * Cap on a saved document. It is stored in one database column and read back through a cursor window of about
     * 2 MB per row, so it must stay well below that. A document with a large embedded background image is not saved
     * (the screenshot itself is); the page keeps working.
     */
    const val MAX_DOC_JSON_CHARS: Int = 1_200_000
    const val MAX_DOC_JSON_BYTES: Int = 1_500_000
    const val MAX_FILENAME_STEM: Int = 64

    private val ALLOWED_MIME = setOf("image/png", "image/jpeg", "image/webp")
    private val STEM_JUNK = Regex("[_ ]{2,}")
    private val FILENAME_TIME: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC)

    /** Lower-cases and trims [mime]; null when it is not on the allowlist. */
    fun normalizeMime(mime: String?): String? {
        val m = mime?.trim()?.lowercase() ?: return null
        return if (m in ALLOWED_MIME) m else null
    }

    fun extensionFor(mime: String): String =
        when (mime) {
            "image/jpeg" -> "jpg"
            "image/webp" -> "webp"
            else -> "png"
        }

    /**
     * Validates and decodes a base64 image from the page: size cap, MIME allowlist, strict base64, and the
     * decoded bytes must start with the signature of the claimed type. When [mime] is null the type is taken
     * from the signature (used by `copyImage`, which always carries PNG).
     *
     * The text is decoded as a stream straight into an array of the exact size, so the peak memory is the string
     * plus the result, not two or three copies. Running out of memory is reported as a rejection, not a crash.
     */
    fun decodeImage(base64: String?, mime: String?): ImageCheck {
        if (base64.isNullOrEmpty()) return ImageCheck.Rejected("empty image")
        if (base64.length > MAX_BASE64_CHARS) return ImageCheck.Rejected("image too large")

        val size = decodedSize(base64)
        if (size <= 0) return ImageCheck.Rejected("malformed base64")
        val bytes = try {
            decodeExactly(base64, size)
        } catch (e: OutOfMemoryError) {
            return ImageCheck.Rejected("out of memory")
        } ?: return ImageCheck.Rejected("malformed base64")
        return checkImageBytes(bytes, mime)
    }

    /** Validates image bytes that already arrived as binary (no base64): size cap, signature, claimed type. */
    fun checkImageBytes(bytes: ByteArray, mime: String?): ImageCheck {
        if (bytes.isEmpty()) return ImageCheck.Rejected("empty image")
        if (bytes.size > MAX_IMAGE_BYTES) return ImageCheck.Rejected("image too large")
        val detected = detectMime(bytes) ?: return ImageCheck.Rejected("not a PNG, JPEG or WebP image")
        if (mime != null) {
            val claimed = normalizeMime(mime) ?: return ImageCheck.Rejected("unsupported type")
            if (claimed != detected) return ImageCheck.Rejected("type does not match content")
        }
        return ImageCheck.Ok(DecodedImage(bytes, detected))
    }

    /**
     * Number of bytes [text] decodes to, or -1 when its shape is impossible (a length that is 1 modulo 4, or
     * padding that does not complete a quantum). Characters are checked while decoding. Padding is optional, like
     * the JDK's basic decoder.
     */
    fun decodedSize(text: String): Int {
        var length = text.length
        if (length == 0) return 0
        var padding = 0
        while (length > 0 && text[length - 1] == '=' && padding < 2) {
            length--
            padding++
        }
        val full = length / 4 * 3
        val tail = when (length % 4) {
            0 -> 0
            2 -> 1
            3 -> 2
            else -> return -1
        }
        // With padding present the text must be a whole number of quanta.
        if (padding > 0 && (length + padding) % 4 != 0) return -1
        return full + tail
    }

    private fun decodeExactly(text: String, size: Int): ByteArray? {
        val out = ByteArray(size)
        try {
            Base64.getDecoder().wrap(AsciiStream(text)).use { input ->
                var filled = 0
                while (filled < size) {
                    val n = input.read(out, filled, size - filled)
                    if (n < 0) return null // ended early
                    filled += n
                }
                if (input.read() != -1) return null // more data than the length implied
            }
        } catch (e: IOException) {
            return null
        } catch (e: IllegalArgumentException) {
            return null
        }
        return out
    }

    /** The characters of a string as ASCII bytes, without making a copy of the string. */
    private class AsciiStream(private val text: String) : InputStream() {
        private var index = 0

        override fun read(): Int {
            if (index >= text.length) return -1
            val c = text[index++].code
            return if (c < 128) c else NOT_BASE64
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            if (index >= text.length) return -1
            val n = minOf(len, text.length - index)
            for (i in 0 until n) {
                val c = text[index + i].code
                b[off + i] = if (c < 128) c.toByte() else NOT_BASE64.toByte()
            }
            index += n
            return n
        }

        override fun available(): Int = text.length - index

        private companion object {
            /** A question mark is not a base64 character, so the decoder rejects text with non-ASCII in it. */
            const val NOT_BASE64 = 0x3F
        }
    }

    /** MIME type from the file signature, or null when it is none of the allowed types. */
    fun detectMime(bytes: ByteArray): String? {
        if (bytes.size >= 8 &&
            bytes[0] == 0x89.toByte() && bytes[1] == 'P'.code.toByte() && bytes[2] == 'N'.code.toByte() &&
            bytes[3] == 'G'.code.toByte() && bytes[4] == 0x0D.toByte() && bytes[5] == 0x0A.toByte() &&
            bytes[6] == 0x1A.toByte() && bytes[7] == 0x0A.toByte()
        ) {
            return "image/png"
        }
        if (bytes.size >= 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte()) {
            return "image/jpeg"
        }
        if (bytes.size >= 12 &&
            bytes[0] == 'R'.code.toByte() && bytes[1] == 'I'.code.toByte() &&
            bytes[2] == 'F'.code.toByte() && bytes[3] == 'F'.code.toByte() &&
            bytes[8] == 'W'.code.toByte() && bytes[9] == 'E'.code.toByte() &&
            bytes[10] == 'B'.code.toByte() && bytes[11] == 'P'.code.toByte()
        ) {
            return "image/webp"
        }
        return null
    }

    /**
     * A file name that is safe to hand to MediaStore: base name only (no path separators), ASCII letters, digits,
     * space, underscore and hyphen, at most [MAX_FILENAME_STEM] characters, and an extension that always matches
     * [mime] whatever the page asked for. Falls back to `polishot-yyyyMMdd-HHmmss`.
     */
    fun sanitizeFilename(raw: String?, mime: String, nowMillis: Long): String {
        val base = raw.orEmpty().substringAfterLast('/').substringAfterLast('\\')
        val stemRaw = if (base.contains('.')) base.substringBeforeLast('.') else base
        val cleaned = buildString(stemRaw.length) {
            for (ch in stemRaw) {
                val ok = ch in 'a'..'z' || ch in 'A'..'Z' || ch in '0'..'9' || ch == '_' || ch == '-' || ch == ' '
                append(if (ok) ch else '_')
            }
        }
            .replace(STEM_JUNK, "_")
            .trim('_', ' ', '-')
            .take(MAX_FILENAME_STEM)
            .trim('_', ' ', '-')
        val stem = cleaned.ifEmpty { "$APP_SLUG-${FILENAME_TIME.format(Instant.ofEpochMilli(nowMillis))}" }
        return "$stem.${extensionFor(mime)}"
    }

    /** Text for the clipboard: bounded, and null when there is nothing to copy. */
    fun sanitizeText(text: String?): String? {
        if (text.isNullOrBlank()) return null
        return if (text.length > MAX_TEXT_CHARS) text.substring(0, MAX_TEXT_CHARS) else text
    }

    /**
     * Checks a document JSON the page wants to persist: bounded size, a JSON object, version 1, and an image id
     * that equals the capture it was saved for. Returns the JSON unchanged when valid.
     */
    fun validateDocJson(captureId: String?, docJson: String?): String? {
        if (!CaptureIds.isValid(captureId)) return null
        if (docJson.isNullOrEmpty() || docJson.length > MAX_DOC_JSON_CHARS) return null
        if (utf8Length(docJson) > MAX_DOC_JSON_BYTES) return null
        return try {
            val doc = JSONObject(docJson)
            val image = doc.optJSONObject("image")
            val ok = doc.optInt("version", 0) == 1 && image != null && image.optString("id") == captureId
            if (ok) docJson else null
        } catch (e: JSONException) {
            null
        }
    }

    /** Bytes of [text] in UTF-8, without encoding it. */
    fun utf8Length(text: String): Int {
        var bytes = 0
        var i = 0
        while (i < text.length) {
            val c = text[i]
            bytes += when {
                c.code < 0x80 -> 1
                c.code < 0x800 -> 2
                Character.isHighSurrogate(c) && i + 1 < text.length && Character.isLowSurrogate(text[i + 1]) -> {
                    i++
                    4
                }
                else -> 3
            }
            i++
        }
        return bytes
    }
}
