package app.polishot.license

import java.io.ByteArrayOutputStream

/**
 * Crockford base32, no padding. Mirrors packages/license/src/base32.ts (CONTRACTS section 3).
 *
 * Alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I, L, O, U). Decoding is case-insensitive, ignores ASCII
 * whitespace and `-`, maps `O -> 0` and `I`/`L` -> `1`, and rejects everything else (including `U`).
 * Bits left over after the last full byte are padding and are ignored.
 */
internal object CrockfordBase32 {
    const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    private val decodeTable: IntArray = IntArray(128) { -1 }.also { table ->
        for (i in ALPHABET.indices) {
            table[ALPHABET[i].code] = i
            table[ALPHABET[i].lowercaseChar().code] = i
        }
        for (c in "Oo") table[c.code] = 0
        for (c in "IiLl") table[c.code] = 1
    }

    /** Space, \t, \n, \v, \f, \r and `-`. Deliberately ASCII-only so every implementation agrees. */
    private fun isSeparator(code: Int): Boolean = code == 0x20 || code in 0x09..0x0D || code == 0x2D

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size * 8 + 4) / 5)
        var acc = 0
        var bits = 0
        for (b in bytes) {
            acc = ((acc shl 8) or (b.toInt() and 0xFF)) and 0xFFF
            bits += 8
            while (bits >= 5) {
                bits -= 5
                out.append(ALPHABET[(acc shr bits) and 31])
            }
        }
        if (bits > 0) out.append(ALPHABET[(acc shl (5 - bits)) and 31])
        return out.toString()
    }

    /** Returns null when the text contains a character outside the (lenient) alphabet. */
    fun decode(text: String): ByteArray? {
        val out = ByteArrayOutputStream((text.length * 5) / 8 + 1)
        var acc = 0
        var bits = 0
        for (ch in text) {
            val code = ch.code
            if (isSeparator(code)) continue
            val value = if (code < 128) decodeTable[code] else -1
            if (value < 0) return null
            acc = ((acc shl 5) or value) and 0xFFF
            bits += 5
            if (bits >= 8) {
                bits -= 8
                out.write((acc shr bits) and 0xFF)
            }
        }
        return out.toByteArray()
    }
}
