package app.polishot.quicksend

import java.io.ByteArrayOutputStream

private const val B32: String = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** First 10 bytes of SHA-256 of the 65-byte long-term public key; text form is 16 characters of base32. */
class DeviceId private constructor(private val bytes: ByteArray) : Comparable<DeviceId> {

    /** A copy of the raw 10 bytes. */
    fun toBytes(): ByteArray = bytes.copyOf()

    /** RFC 4648 base32, upper case, no padding. */
    override fun toString(): String {
        val sb = StringBuilder(16)
        var acc = 0
        var bits = 0
        for (b in bytes) {
            acc = (acc shl 8) or (b.toInt() and 0xFF)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                sb.append(B32[(acc shr bits) and 31])
            }
            // keep only the bits not yet emitted, so the accumulator cannot overflow
            acc = acc and ((1 shl bits) - 1)
        }
        return sb.toString()
    }

    /** Unsigned lexicographic order of the raw bytes (the canonical order for transcripts). */
    override fun compareTo(other: DeviceId): Int {
        for (i in bytes.indices) {
            val a = bytes[i].toInt() and 0xFF
            val b = other.bytes[i].toInt() and 0xFF
            if (a != b) return a - b
        }
        return 0
    }

    override fun equals(other: Any?): Boolean = other is DeviceId && bytes.contentEquals(other.bytes)

    override fun hashCode(): Int = bytes.contentHashCode()

    companion object {
        fun fromBytes(bytes: ByteArray): DeviceId {
            if (bytes.size != Protocol.DEVICE_ID_LEN) throw invalidInput("device id must be 10 bytes")
            return DeviceId(bytes.copyOf())
        }

        fun fromPublic(publicKey: ByteArray): DeviceId =
            DeviceId(Crypto.sha256(publicKey).copyOf(Protocol.DEVICE_ID_LEN))

        /** Parse a 16-character base32 id, case-insensitively. */
        fun parse(text: String): DeviceId {
            if (text.length != 16) throw invalidInput("device id must be 16 base32 characters")
            val out = ByteArray(Protocol.DEVICE_ID_LEN)
            var acc = 0
            var bits = 0
            var n = 0
            for (ch in text) {
                val c = if (ch in 'a'..'z') (ch.code - 32).toChar() else ch
                val v = when (c) {
                    in 'A'..'Z' -> c - 'A'
                    in '2'..'7' -> c - '2' + 26
                    else -> throw invalidInput("device id has a non-base32 character")
                }
                acc = (acc shl 5) or v
                bits += 5
                if (bits >= 8) {
                    bits -= 8
                    out[n] = ((acc shr bits) and 0xFF).toByte()
                    n++
                    acc = acc and ((1 shl bits) - 1)
                }
            }
            return DeviceId(out)
        }
    }
}

/**
 * This device's long-term P-256 key pair. Store [toBytes] in encrypted storage (Android Keystore-wrapped
 * preferences); it contains the private key.
 */
class Identity internal constructor(internal val key: EcKeyPair) {

    /** The 65-byte SEC1 uncompressed public key. */
    val publicKey: ByteArray get() = key.publicBytes.copyOf()

    /** The device id derived from the public key. */
    val id: DeviceId = DeviceId.fromPublic(key.publicBytes)

    /** `private scalar (32) || public key (65)` = 97 bytes. The JCA cannot derive a public key from a scalar. */
    fun toBytes(): ByteArray = key.secretBytes() + key.publicBytes

    override fun toString(): String = "Identity($id)"

    companion object {
        fun generate(): Identity = Identity(Crypto.generateKeyPair())

        /** Restore an identity from the 97 bytes produced by [toBytes]. */
        fun fromBytes(bytes: ByteArray): Identity {
            if (bytes.size != 32 + Protocol.PUBLIC_KEY_LEN) throw invalidInput("identity must be 97 bytes")
            return Identity(Crypto.keyPairFrom(bytes.copyOfRange(0, 32), bytes.copyOfRange(32, bytes.size)))
        }
    }
}

/** What a device persists after a successful pairing. [pairKey] is a secret. */
class PairRecord(peerPublic: ByteArray, pairKey: ByteArray, peerName: String) {
    val peerPublic: ByteArray = peerPublic.copyOf()
    val pairKey: ByteArray = pairKey.copyOf()
    val peerName: String = peerName
    val peerId: DeviceId

    init {
        Crypto.decodePublic(this.peerPublic)
        if (this.pairKey.size != Protocol.PAIR_KEY_LEN) throw invalidInput("pair key must be 32 bytes")
        Content.validateDeviceName(peerName)
        peerId = DeviceId.fromPublic(this.peerPublic)
    }

    /** `format(1) || peerPublic(65) || pairKey(32) || len(1) || name`. Contains a secret. */
    fun toBytes(): ByteArray {
        val name = peerName.toByteArray(Charsets.UTF_8)
        val out = ByteArrayOutputStream()
        out.write(1)
        out.write(peerPublic)
        out.write(pairKey)
        out.write(name.size)
        out.write(name)
        return out.toByteArray()
    }

    override fun toString(): String = "PairRecord($peerId, $peerName)"

    companion object {
        /** Parse the output of [toBytes]. */
        fun fromBytes(bytes: ByteArray): PairRecord {
            val fixed = 1 + Protocol.PUBLIC_KEY_LEN + Protocol.PAIR_KEY_LEN
            if (bytes.size < fixed + 1 || bytes[0].toInt() != 1) throw invalidInput("unrecognised pair record")
            val n = bytes[fixed].toInt() and 0xFF
            if (bytes.size != fixed + 1 + n) throw invalidInput("pair record has trailing or missing bytes")
            val name = try {
                decodeUtf8Strict(bytes.copyOfRange(fixed + 1, bytes.size))
            } catch (e: QuickSendException) {
                throw invalidInput("pair record name is not UTF-8")
            }
            return PairRecord(
                bytes.copyOfRange(1, 1 + Protocol.PUBLIC_KEY_LEN),
                bytes.copyOfRange(1 + Protocol.PUBLIC_KEY_LEN, fixed),
                name,
            )
        }
    }
}
