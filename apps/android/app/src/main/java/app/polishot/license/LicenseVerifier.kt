package app.polishot.license

import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

/**
 * Offline licence keys, CONTRACTS section 3. Pure Kotlin (no Android types) so it runs in plain JVM tests.
 *
 * Payload (30 bytes): version(1) | edition(1) | issuedDays u32 big-endian (4) | keyId (8) | licenseeHash (16).
 * Key text: `PSHOT-` + Crockford base32 of payload || signature(64), in groups of 6 joined by `-`.
 *
 * Parsing rules, in the same order as packages/license/src/index.ts and the Rust crate:
 *  1. input longer than 300 characters                          -> LENGTH
 *  2. trim ASCII whitespace; drop a leading `PSHOT-` (any case); ignore ASCII whitespace and `-`
 *  3. any other character that is not Crockford base32          -> FORMAT
 *  4. decoded byte count is not 94                              -> LENGTH
 *  5. strict Ed25519 signature over the payload fails           -> SIGNATURE
 *  6. version byte is not 1, or edition byte is not 1 or 2      -> VERSION
 */
enum class Edition { PERSONAL, TEAM }

data class LicenseInfo(
    val version: Int,
    val edition: Edition,
    /** Days since the Unix epoch. This is an unsigned 32-bit value, so it is kept in a Long (0..4294967295). */
    val issuedDays: Long,
    /** 16 lowercase hex chars (8 bytes). */
    val keyIdHex: String,
    /** 32 lowercase hex chars (first 16 bytes of SHA-256 of the normalised email). */
    val licenseeHashHex: String,
) {
    /** Calendar day of issue; days beyond what a date can hold are clamped the way the TypeScript verifier does. */
    fun issuedDate(): java.time.LocalDate =
        java.time.LocalDate.ofEpochDay(issuedDays.coerceAtMost(MAX_DATE_DAYS))

    private companion object {
        const val MAX_DATE_DAYS = 100_000_000L
    }
}

enum class InvalidReason { FORMAT, LENGTH, VERSION, SIGNATURE }

sealed interface VerifyResult {
    data class Valid(val info: LicenseInfo) : VerifyResult
    data class Invalid(val reason: InvalidReason) : VerifyResult
}

class LicenseVerifier(publicKeyHex: String = PROD_PUBLIC_KEY_HEX) {
    private val publicKey: ByteArray = hexToBytes(publicKeyHex)

    init {
        require(publicKey.size == PUBLIC_KEY_LEN) { "public key must be $PUBLIC_KEY_LEN bytes" }
    }

    /** Never throws: every failure is reported through [InvalidReason]. */
    fun verify(key: String): VerifyResult {
        return try {
            verifyInternal(key)
        } catch (e: RuntimeException) {
            VerifyResult.Invalid(InvalidReason.SIGNATURE)
        }
    }

    private fun verifyInternal(key: String): VerifyResult {
        if (key.length > MAX_INPUT_LEN) return VerifyResult.Invalid(InvalidReason.LENGTH)

        var start = 0
        var end = key.length
        while (start < end && isAsciiSpace(key[start].code)) start++
        while (end > start && isAsciiSpace(key[end - 1].code)) end--
        var text = key.substring(start, end)
        if (hasPrefix(text)) text = text.substring(PREFIX.length)

        val bytes = CrockfordBase32.decode(text) ?: return VerifyResult.Invalid(InvalidReason.FORMAT)
        if (bytes.size != PAYLOAD_LEN + SIGNATURE_LEN) return VerifyResult.Invalid(InvalidReason.LENGTH)

        val payload = bytes.copyOfRange(0, PAYLOAD_LEN)
        val signature = bytes.copyOfRange(PAYLOAD_LEN, PAYLOAD_LEN + SIGNATURE_LEN)
        if (!verifySignature(payload, signature)) return VerifyResult.Invalid(InvalidReason.SIGNATURE)

        val version = payload[0].toInt() and 0xFF
        val editionByte = payload[1].toInt() and 0xFF
        if (version != 1 || (editionByte != 1 && editionByte != 2)) {
            return VerifyResult.Invalid(InvalidReason.VERSION)
        }

        // issuedDays is an unsigned 32-bit big-endian integer: assemble it in a Long, never in an Int.
        val issuedDays = ((payload[2].toLong() and 0xFF) shl 24) or
            ((payload[3].toLong() and 0xFF) shl 16) or
            ((payload[4].toLong() and 0xFF) shl 8) or
            (payload[5].toLong() and 0xFF)

        return VerifyResult.Valid(
            LicenseInfo(
                version = 1,
                edition = if (editionByte == 1) Edition.PERSONAL else Edition.TEAM,
                issuedDays = issuedDays,
                keyIdHex = bytesToHex(payload, 6, 14),
                licenseeHashHex = bytesToHex(payload, 14, 30),
            ),
        )
    }

    /**
     * Strict Ed25519: the scalar S must be canonical (S < L). BouncyCastle's verifier enforces this too, but the
     * rule is checked here explicitly so it does not depend on a library version, and so a mauled signature
     * (S + L) is rejected the same way the noble (zip215: false) and ed25519-dalek strict verifiers reject it.
     */
    private fun verifySignature(payload: ByteArray, signature: ByteArray): Boolean {
        if (signature.size != SIGNATURE_LEN) return false
        if (!isCanonicalScalar(signature, 32)) return false
        val signer = Ed25519Signer()
        signer.init(false, Ed25519PublicKeyParameters(publicKey, 0))
        signer.update(payload, 0, payload.size)
        return signer.verifySignature(signature)
    }

    internal companion object {
        const val PREFIX = "PSHOT-"
        const val PAYLOAD_LEN = 30
        const val SIGNATURE_LEN = 64
        const val PUBLIC_KEY_LEN = 32
        const val MAX_INPUT_LEN = 300

        /** The group order L = 2^252 + 27742317777372353535851937790883648493, little-endian bytes. */
        private val GROUP_ORDER_LE = intArrayOf(
            0xED, 0xD3, 0xF5, 0x5C, 0x1A, 0x63, 0x12, 0x58, 0xD6, 0x9C, 0xF7, 0xA2, 0xDE, 0xF9, 0xDE, 0x14,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
        )

        /** True when the 32 little-endian bytes of [bytes] starting at [offset] encode a value strictly below L. */
        fun isCanonicalScalar(bytes: ByteArray, offset: Int): Boolean {
            for (i in 31 downTo 0) {
                val s = bytes[offset + i].toInt() and 0xFF
                val l = GROUP_ORDER_LE[i]
                if (s < l) return true
                if (s > l) return false
            }
            return false // S == L is not canonical either
        }

        fun isAsciiSpace(code: Int): Boolean = code == 0x20 || code in 0x09..0x0D

        /** ASCII-only, case-insensitive check for `PSHOT-`. */
        fun hasPrefix(text: String): Boolean {
            if (text.length < PREFIX.length) return false
            for (i in PREFIX.indices) {
                var code = text[i].code
                if (code in 0x61..0x7A) code -= 0x20
                if (code != PREFIX[i].code) return false
            }
            return true
        }

        fun hexToBytes(hex: String): ByteArray {
            require(hex.length % 2 == 0) { "hex string must have an even length" }
            return ByteArray(hex.length / 2) { i ->
                val hi = Character.digit(hex[i * 2], 16)
                val lo = Character.digit(hex[i * 2 + 1], 16)
                require(hi >= 0 && lo >= 0) { "invalid hex digit" }
                ((hi shl 4) or lo).toByte()
            }
        }

        fun bytesToHex(bytes: ByteArray, from: Int = 0, to: Int = bytes.size): String {
            val digits = "0123456789abcdef"
            val sb = StringBuilder((to - from) * 2)
            for (i in from until to) {
                val v = bytes[i].toInt() and 0xFF
                sb.append(digits[v shr 4]).append(digits[v and 0x0F])
            }
            return sb.toString()
        }

        /** `PSHOT-XXXXXX-XXXXXX-...` for a payload and signature (the TypeScript `encodeKey`). */
        fun encodeKey(payload: ByteArray, signature: ByteArray): String {
            require(payload.size == PAYLOAD_LEN) { "payload must be $PAYLOAD_LEN bytes" }
            require(signature.size == SIGNATURE_LEN) { "signature must be $SIGNATURE_LEN bytes" }
            val text = CrockfordBase32.encode(payload + signature)
            return PREFIX + text.chunked(6).joinToString("-")
        }
    }
}
