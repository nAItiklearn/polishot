package app.polishot.quicksend

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Thin wrappers over JCA: SHA-256, HMAC, HKDF, P-256 (secp256r1) ECDH and AES-256-GCM. Public keys cross the
 * wire as SEC1 uncompressed points (65 bytes), exactly like the Rust implementation.
 */
internal object Crypto {
    private val params: ECParameterSpec by lazy {
        val ap = AlgorithmParameters.getInstance("EC")
        ap.init(ECGenParameterSpec("secp256r1"))
        ap.getParameterSpec(ECParameterSpec::class.java)
    }

    private val fieldPrime: BigInteger by lazy { (params.curve.field as ECFieldFp).p }

    fun sha256(vararg parts: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        for (p in parts) md.update(p)
        return md.digest()
    }

    fun hmacSha256(key: ByteArray, vararg parts: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // SecretKeySpec rejects empty keys; an empty HMAC key is the same as 32 zero bytes (zero padding).
        val k = if (key.isEmpty()) ByteArray(32) else key
        mac.init(SecretKeySpec(k, "HmacSHA256"))
        for (p in parts) mac.update(p)
        return mac.doFinal()
    }

    /** HKDF-SHA256 (RFC 5869). An empty [salt] means 32 zero bytes. */
    fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..(255 * 32)) { "hkdf length" }
        val prk = hmacSha256(salt, ikm)
        val out = ByteArray(length)
        var previous = ByteArray(0)
        var pos = 0
        var counter = 1
        while (pos < length) {
            previous = hmacSha256(prk, previous, info, byteArrayOf(counter.toByte()))
            val n = minOf(previous.size, length - pos)
            System.arraycopy(previous, 0, out, pos, n)
            pos += n
            counter++
        }
        return out
    }

    /** Constant-time equality (lengths are public). */
    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    /** Big-endian, left-padded to exactly [len] bytes; [v] must be non-negative and fit. */
    fun toFixed(v: BigInteger, len: Int): ByteArray {
        val raw = v.toByteArray()
        val out = ByteArray(len)
        if (raw.size > len) {
            // a leading sign byte
            if (raw.size != len + 1 || raw[0].toInt() != 0) throw invalidInput("integer does not fit")
            System.arraycopy(raw, 1, out, 0, len)
        } else {
            System.arraycopy(raw, 0, out, len - raw.size, raw.size)
        }
        return out
    }

    fun encodePublic(key: ECPublicKey): ByteArray {
        val out = ByteArray(Protocol.PUBLIC_KEY_LEN)
        out[0] = 4
        System.arraycopy(toFixed(key.w.affineX, 32), 0, out, 1, 32)
        System.arraycopy(toFixed(key.w.affineY, 32), 0, out, 33, 32)
        return out
    }

    /** Decode a SEC1 uncompressed point, checking that it is on the curve. */
    fun decodePublic(bytes: ByteArray): ECPublicKey {
        if (bytes.size != Protocol.PUBLIC_KEY_LEN || bytes[0].toInt() != 4) {
            throw protocolError("public key must be 65-byte uncompressed SEC1")
        }
        val x = BigInteger(1, bytes.copyOfRange(1, 33))
        val y = BigInteger(1, bytes.copyOfRange(33, 65))
        val p = fieldPrime
        if (x >= p || y >= p) throw protocolError("public key coordinate out of range")
        val curve = params.curve
        val lhs = y.multiply(y).mod(p)
        val rhs = x.multiply(x).multiply(x).add(curve.a.multiply(x)).add(curve.b).mod(p)
        if (lhs != rhs) throw protocolError("public key is not on the curve")
        try {
            val spec = ECPublicKeySpec(ECPoint(x, y), params)
            return KeyFactory.getInstance("EC").generatePublic(spec) as ECPublicKey
        } catch (e: GeneralSecurityException) {
            throw protocolError("public key rejected: ${e.message}")
        }
    }

    fun generateKeyPair(): EcKeyPair {
        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"))
        val kp = kpg.generateKeyPair()
        return EcKeyPair(kp.private, encodePublic(kp.public as ECPublicKey))
    }

    /** Build a key pair from the 32-byte scalar and the matching 65-byte public key. */
    fun keyPairFrom(secret: ByteArray, publicKey: ByteArray): EcKeyPair {
        if (secret.size != 32) throw invalidInput("private key must be 32 bytes")
        val d = BigInteger(1, secret)
        if (d.signum() == 0 || d >= params.order) throw invalidInput("private key is not a valid P-256 scalar")
        decodePublic(publicKey)
        val priv = try {
            KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(d, params))
        } catch (e: GeneralSecurityException) {
            throw invalidInput("private key rejected: ${e.message}")
        }
        val pair = EcKeyPair(priv, publicKey.copyOf())
        // d * G must have the stated X coordinate, which catches a public key that belongs to another secret.
        // The JCA only exposes X coordinates of ECDH results, so a public key with the Y coordinate negated
        // (corrupted storage) cannot be detected here.
        val generator = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(params.generator, params))
        val shared = pair.ecdhRaw(generator as ECPublicKey)
        if (!constantTimeEquals(shared, publicKey.copyOfRange(1, 33))) {
            throw invalidInput("public key does not belong to the private key")
        }
        return pair
    }

    /** The 32-byte big-endian private scalar of a JCA EC private key. */
    fun scalarBytes(key: PrivateKey): ByteArray {
        val ec = key as? ECPrivateKey ?: throw invalidInput("not an EC private key")
        return toFixed(ec.s, 32)
    }
}

/** A P-256 key pair: the JCA private key plus the 65-byte SEC1 public key. */
internal class EcKeyPair(private val privateKey: PrivateKey, val publicBytes: ByteArray) {

    fun secretBytes(): ByteArray = Crypto.scalarBytes(privateKey)

    /** ECDH with a peer's 65-byte public key; returns the 32-byte X coordinate. */
    fun ecdh(peerPublic: ByteArray): ByteArray = ecdhRaw(Crypto.decodePublic(peerPublic))

    fun ecdhRaw(peer: ECPublicKey): ByteArray {
        try {
            val ka = KeyAgreement.getInstance("ECDH")
            ka.init(privateKey)
            ka.doPhase(peer, true)
            val secret = ka.generateSecret()
            if (secret.size != 32) throw invalidInput("unexpected ECDH output length")
            return secret
        } catch (e: GeneralSecurityException) {
            throw protocolError("key agreement failed: ${e.message}")
        }
    }
}

/**
 * One direction of the AES-256-GCM record layer. Nonce = 4-byte direction tag || u64 big-endian counter; the
 * counter is implicit and advances only on success, so replayed, dropped, duplicated or reordered frames fail.
 */
internal class Sealer(key: ByteArray, private val dirTag: ByteArray, private val version: Int) {
    private val keySpec = SecretKeySpec(key.copyOf(), "AES")
    private var counter: Long = 0L

    init {
        require(key.size == 32) { "AES-256 key" }
        require(dirTag.size == 4) { "direction tag" }
    }

    private fun nonce(): ByteArray {
        // the counter is an unsigned 64-bit value; all-ones is reserved as "exhausted"
        if (counter == -1L) throw protocolError("frame counter exhausted")
        val n = ByteArray(12)
        System.arraycopy(dirTag, 0, n, 0, 4)
        for (i in 0 until 8) n[4 + i] = (counter ushr (56 - 8 * i)).toByte()
        return n
    }

    fun seal(type: Int, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, GCMParameterSpec(128, nonce()))
        cipher.updateAAD(byteArrayOf(version.toByte(), type.toByte()))
        val out = cipher.doFinal(plaintext)
        counter++
        return out
    }

    fun open(type: Int, ciphertext: ByteArray): ByteArray {
        if (ciphertext.size < Protocol.TAG_LEN) throw QuickSendException(Failure.CRYPTO, "sealed frame too short")
        val out = try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, keySpec, GCMParameterSpec(128, nonce()))
            cipher.updateAAD(byteArrayOf(version.toByte(), type.toByte()))
            cipher.doFinal(ciphertext)
        } catch (e: GeneralSecurityException) {
            throw QuickSendException(Failure.CRYPTO, "frame authentication failed")
        }
        counter++
        return out
    }
}
