package app.polishot.license

import java.io.File
import java.math.BigInteger
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs the shared vectors in packages/license/test-vectors.json (the same file the TypeScript and Rust tests
 * use) against the Kotlin verifier, plus the Android-specific edge cases.
 */
class LicenseVerifierTest {
    private val vectors: JSONObject = loadVectors()
    private val verifier = LicenseVerifier(vectors.getString("publicKeyHex"))
    private val cases: JSONArray = vectors.getJSONArray("cases")

    @Test
    fun `vector file has the expected shape`() {
        assertEquals(64, vectors.getString("publicKeyHex").length)
        assertTrue("expected at least 20 vectors, found ${cases.length()}", cases.length() >= 20)
    }

    @Test
    fun `every shared vector gives the expected result`() {
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val name = case.getString("name")
            val result = verifier.verify(case.getString("key"))
            if (case.getBoolean("valid")) {
                assertTrue("$name should be valid but was $result", result is VerifyResult.Valid)
                val info = (result as VerifyResult.Valid).info
                assertEquals("$name edition", case.getString("edition").uppercase(), info.edition.name)
                assertEquals("$name issuedDays", case.getLong("issuedDays"), info.issuedDays)
                assertEquals("$name keyId", case.getString("keyIdHex"), info.keyIdHex)
                assertEquals("$name licenseeHash", case.getString("licenseeHash"), info.licenseeHashHex)
                assertEquals("$name version", 1, info.version)
            } else {
                assertTrue("$name should be invalid but was $result", result is VerifyResult.Invalid)
                val expected = case.getString("reason").uppercase()
                assertEquals("$name reason", expected, (result as VerifyResult.Invalid).reason.name)
            }
        }
    }

    @Test
    fun `issuedDays is read as an unsigned 32 bit value`() {
        val case = findCase("valid-max-u32-days")
        val info = (verifier.verify(case.getString("key")) as VerifyResult.Valid).info
        assertEquals(4_294_967_295L, info.issuedDays)
        // A signed read would give -1 and break the date; the clamped date must still be computable.
        assertNotNull(info.issuedDate())
    }

    @Test
    fun `a signature with a non canonical S is rejected`() {
        val valid = findCase("valid-personal")
        val decoded = decodeKeyBytes(valid.getString("key"))
        val payload = decoded.copyOfRange(0, 30)
        val signature = decoded.copyOfRange(30, 94)

        val l = BigInteger("27742317777372353535851937790883648493").add(BigInteger.ONE.shiftLeft(252))
        val s = BigInteger(1, signature.copyOfRange(32, 64).reversedArray())
        val mauled = s.add(l) // same value modulo L, but not canonical: S >= L
        val mauledLe = toLittleEndian32(mauled)
        val tampered = signature.copyOf()
        System.arraycopy(mauledLe, 0, tampered, 32, 32)

        val key = LicenseVerifier.encodeKey(payload, tampered)
        val result = verifier.verify(key)
        assertEquals(VerifyResult.Invalid(InvalidReason.SIGNATURE), result)

        // The untouched signature still verifies, so the rejection above is down to S alone.
        assertTrue(verifier.verify(LicenseVerifier.encodeKey(payload, signature)) is VerifyResult.Valid)
    }

    @Test
    fun `canonical scalar check matches the group order boundary`() {
        val l = BigInteger("27742317777372353535851937790883648493").add(BigInteger.ONE.shiftLeft(252))
        assertFalse(LicenseVerifier.isCanonicalScalar(toLittleEndian32(l), 0))
        assertTrue(LicenseVerifier.isCanonicalScalar(toLittleEndian32(l.subtract(BigInteger.ONE)), 0))
        assertFalse(LicenseVerifier.isCanonicalScalar(toLittleEndian32(l.add(BigInteger.ONE)), 0))
        assertTrue(LicenseVerifier.isCanonicalScalar(ByteArray(32), 0))
        assertFalse(LicenseVerifier.isCanonicalScalar(ByteArray(32) { 0xFF.toByte() }, 0))
    }

    @Test
    fun `base32 round trips and follows the lenient decoding rules`() {
        val bytes = ByteArray(94) { (it * 7 + 3).toByte() }
        val text = CrockfordBase32.encode(bytes)
        assertEquals(151, text.length) // ceil(94 * 8 / 5)
        assertTrue(bytes.contentEquals(CrockfordBase32.decode(text)))
        assertTrue(bytes.contentEquals(CrockfordBase32.decode(text.lowercase())))
        // O -> 0, I and L -> 1, separators ignored, U and non-ASCII rejected.
        val plain = CrockfordBase32.decode("00 11")
        assertNotNull(plain)
        assertEquals(plain?.toList(), CrockfordBase32.decode("OO-IL")?.toList())
        assertEquals(plain?.toList(), CrockfordBase32.decode("oo\t\r\nil")?.toList())
        assertEquals(null, CrockfordBase32.decode("U"))
        assertEquals(null, CrockfordBase32.decode("\u00e9"))
    }

    @Test
    fun `the production public key constant is a valid verifier key`() {
        // The generated constant must be usable; a key signed by the test keypair must not verify against it.
        val prod = LicenseVerifier()
        val valid = findCase("valid-personal").getString("key")
        assertEquals(VerifyResult.Invalid(InvalidReason.SIGNATURE), prod.verify(valid))
    }

    private fun findCase(name: String): JSONObject {
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            if (c.getString("name") == name) return c
        }
        throw AssertionError("vector $name not found")
    }

    private fun decodeKeyBytes(key: String): ByteArray {
        val text = key.trim().removePrefix("PSHOT-")
        return requireNotNull(CrockfordBase32.decode(text)) { "vector key must decode" }
    }

    private fun toLittleEndian32(value: BigInteger): ByteArray {
        val be = value.toByteArray() // big-endian, may carry a leading sign byte
        val out = ByteArray(32)
        for (i in 0 until 32) {
            val src = be.size - 1 - i
            out[i] = if (src >= 0) be[src] else 0
        }
        return out
    }

    private companion object {
        fun loadVectors(): JSONObject {
            val configured = System.getProperty("polishot.licenseVectors")
            val file = if (!configured.isNullOrBlank()) {
                File(configured)
            } else {
                // Unit tests run with the module directory (apps/android/app) as the working directory.
                File("../../../packages/license/test-vectors.json")
            }
            require(file.isFile) { "licence test vectors not found at ${file.absolutePath}" }
            return JSONObject(file.readText(Charsets.UTF_8))
        }
    }
}
