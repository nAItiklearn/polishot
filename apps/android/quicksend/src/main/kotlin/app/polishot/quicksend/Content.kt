package app.polishot.quicksend

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/** Content rules: MIME allowlist, magic bytes, name validation and sanitization (spec sections 2.2 and 9). */
object Content {

    /** Code points never allowed in device names or file names (including lone surrogates). */
    internal fun isForbidden(cp: Int): Boolean =
        cp in 0x0000..0x001F ||
            cp in 0x007F..0x009F ||
            cp == 0x2028 ||
            cp == 0x2029 ||
            cp == 0x200E ||
            cp == 0x200F ||
            cp in 0x202A..0x202E ||
            cp in 0x2066..0x2069 ||
            cp in 0xD800..0xDFFF

    private const val PATH_UNSAFE: String = "/\\:*?\"<>|"

    private val RESERVED: Set<String> = setOf(
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    )

    internal fun codePoints(s: String): IntArray {
        val out = ArrayList<Int>(s.length)
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            out.add(cp)
            i += Character.charCount(cp)
        }
        return out.toIntArray()
    }

    private fun fromCodePoints(cps: List<Int>): String {
        val sb = StringBuilder()
        for (cp in cps) sb.appendCodePoint(cp)
        return sb.toString()
    }

    private fun utf8Length(cp: Int): Int = when {
        cp < 0x80 -> 1
        cp < 0x800 -> 2
        cp < 0x10000 -> 3
        else -> 4
    }

    /** True when [mime] is exactly one of the allowed image types. */
    fun isAllowedMime(mime: String): Boolean = Protocol.ALLOWED_MIME.contains(mime)

    /** Check the leading bytes of [data] against the offered MIME type. */
    fun checkMagic(mime: String, data: ByteArray): Boolean {
        fun startsWith(vararg prefix: Int): Boolean {
            if (data.size < prefix.size) return false
            for (i in prefix.indices) if ((data[i].toInt() and 0xFF) != prefix[i]) return false
            return true
        }
        return when (mime) {
            "image/png" -> startsWith(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
            "image/jpeg" -> startsWith(0xFF, 0xD8, 0xFF)
            "image/webp" -> data.size >= 12 &&
                String(data, 0, 4, Charsets.ISO_8859_1) == "RIFF" &&
                String(data, 8, 4, Charsets.ISO_8859_1) == "WEBP"
            else -> false
        }
    }

    /** Validate a device name received from the wire or an advertisement. */
    fun validateDeviceName(name: String) {
        val cps = codePoints(name)
        if (cps.isEmpty() || cps.size > Protocol.MAX_DEVICE_NAME_CHARS) {
            throw protocolError("device name must be 1 to 32 characters")
        }
        if (cps.any { isForbidden(it) }) throw protocolError("device name contains forbidden characters")
    }

    /** Validate a file name received from the wire. */
    internal fun validateWireFileName(name: String) {
        val n = name.toByteArray(Charsets.UTF_8).size
        if (name.isEmpty() || n > Protocol.MAX_FILE_NAME_BYTES) throw protocolError("file name must be 1 to 128 bytes")
        if (codePoints(name).any { isForbidden(it) }) throw protocolError("file name contains forbidden characters")
    }

    /** Turn any string into a valid device name (spec section 2.2). */
    fun cleanDeviceName(raw: String): String {
        val filtered = codePoints(raw).filter { !isForbidden(it) }
        val trimmed = fromCodePoints(filtered).trim { it == ' ' }
        val cut = fromCodePoints(codePoints(trimmed).take(Protocol.MAX_DEVICE_NAME_CHARS)).trim { it == ' ' }
        return if (cut.isEmpty()) "Device" else cut
    }

    private fun trimNameEnds(s: String): String = s.trim { it == ' ' || it == '.' }

    /** Make a file name safe to show and to use as a path component (spec section 2.2). */
    fun sanitizeFileName(raw: String): String {
        val replaced = codePoints(raw).map { cp ->
            if (isForbidden(cp) || (cp < 0x80 && PATH_UNSAFE.indexOf(cp.toChar()) >= 0)) '_'.code else cp
        }
        var name = trimNameEnds(fromCodePoints(replaced))
        if (name.isEmpty()) name = "image"
        val stem = name.substringBefore('.')
        if (RESERVED.contains(asciiUpper(stem))) name = "_$name"
        if (name.toByteArray(Charsets.UTF_8).size > Protocol.MAX_FILE_NAME_BYTES) {
            val kept = ArrayList<Int>()
            var bytes = 0
            for (cp in codePoints(name)) {
                val n = utf8Length(cp)
                if (bytes + n > Protocol.MAX_FILE_NAME_BYTES) break
                kept.add(cp)
                bytes += n
            }
            name = trimNameEnds(fromCodePoints(kept))
            if (name.isEmpty()) name = "image"
        }
        return name
    }

    private fun asciiUpper(s: String): String {
        val sb = StringBuilder(s.length)
        for (c in s) sb.append(if (c in 'a'..'z') (c.code - 32).toChar() else c)
        return sb.toString()
    }
}

/** Strict UTF-8 decoding: malformed input is a protocol error, never silently replaced. */
internal fun decodeUtf8Strict(bytes: ByteArray): String {
    try {
        return Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (e: CharacterCodingException) {
        throw protocolError("string is not valid UTF-8")
    }
}
