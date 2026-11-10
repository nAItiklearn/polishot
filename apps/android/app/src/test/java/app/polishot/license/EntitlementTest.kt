package app.polishot.license

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Update-window rules from docs/CONTRACTS.md section 5b, plus the shared `entitlementCases` when present. */
class EntitlementTest {
    private val vectors: JSONObject = loadVectors()
    private val verifier = LicenseVerifier(vectors.getString("publicKeyHex"))

    private fun key(name: String): String {
        val cases: JSONArray = vectors.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            if (c.getString("name") == name) return c.getString("key")
        }
        throw AssertionError("vector $name not found")
    }

    private fun info(name: String): LicenseInfo =
        (verifier.verify(key(name)) as VerifyResult.Valid).info

    // ---- window arithmetic ----------------------------------------------------------------------

    @Test
    fun `a key covers builds up to issuedDays plus 365`() {
        val i = info("valid-personal") // issuedDays 20468
        assertEquals(20468L + 365, Entitlements.updatesUntilDays(i))
        assertTrue(Entitlements.coversBuild(i, 20468))
        assertTrue(Entitlements.coversBuild(i, 20468L + 365))
        assertFalse(Entitlements.coversBuild(i, 20468L + 366))
        assertTrue("builds older than the key are covered", Entitlements.coversBuild(i, 0))
    }

    @Test
    fun `the window saturates at u32 max instead of wrapping`() {
        val i = info("valid-max-u32-days") // issuedDays 4294967295
        assertEquals(4_294_967_295L, Entitlements.updatesUntilDays(i))
        assertTrue(Entitlements.coversBuild(i, 4_294_967_295L))
        assertTrue(Entitlements.coversBuild(i, 20468))
        // A wrapped sum (4294967295 + 365 mod 2^32 = 364) would wrongly reject today's builds.
        assertTrue(Entitlements.coversBuild(i, 20_600))
    }

    @Test
    fun `build days outside the u32 range are never covered`() {
        val i = info("valid-max-u32-days")
        assertFalse(Entitlements.coversBuild(i, -1))
        assertFalse(Entitlements.coversBuild(i, 4_294_967_296L))
    }

    // ---- entitlement ----------------------------------------------------------------------------

    @Test
    fun `no key and blank keys are Free with reason no-key`() {
        for (blank in listOf(null, "", "   \n")) {
            val e = Entitlements.evaluate(blank, verifier, 20_500)
            assertFalse(e.pro)
            assertEquals(EntitlementReason.NoKey, e.reason)
            assertNull(e.updatesUntil)
        }
    }

    @Test
    fun `a key that does not verify is Free with reason invalid`() {
        val e = Entitlements.evaluate("PSHOT-NOT-A-REAL-KEY", verifier, 20_500)
        assertFalse(e.pro)
        assertEquals(EntitlementReason.Invalid, e.reason)
        assertNull(e.updatesUntil)
        assertNull(e.info)
    }

    @Test
    fun `a covering key is Pro and reports the end of its updates`() {
        val e = Entitlements.evaluate(key("valid-personal"), verifier, 20_500)
        assertTrue(e.pro)
        assertNull(e.reason)
        assertEquals("2027-01-15", e.updatesUntil) // day 20833
        assertNotNull(e.info)
    }

    @Test
    fun `the last covered build is still Pro and the next day is not`() {
        val last = Entitlements.evaluate(key("valid-personal"), verifier, 20468L + 365)
        assertTrue(last.pro)
        val next = Entitlements.evaluate(key("valid-personal"), verifier, 20468L + 366)
        assertFalse(next.pro)
        assertEquals(EntitlementReason.UpdatesExpired, next.reason)
        assertEquals("2027-01-15", next.updatesUntil)
        assertNotNull("the genuine key details stay available for the message", next.info)
    }

    @Test
    fun `reason ids match the contract strings`() {
        assertEquals("no-key", EntitlementReason.NoKey.id)
        assertEquals("invalid", EntitlementReason.Invalid.id)
        assertEquals("updates-expired", EntitlementReason.UpdatesExpired.id)
    }

    // ---- manager --------------------------------------------------------------------------------

    @Test
    fun `manager activates a covering key, persists it and deactivates`() {
        val store = InMemorySecretStore()
        val manager = LicenseManager(verifier, store, buildDays = 20_500)
        assertFalse(manager.isPro)

        val result = manager.activate(key("valid-team"))
        assertTrue(result is ActivationResult.Success)
        assertTrue(manager.isPro)
        assertNotNull(store.read())

        // A fresh manager (next app start) restores the same state from the stored key.
        assertTrue(LicenseManager(verifier, store, buildDays = 20_500).isPro)

        manager.deactivate()
        assertFalse(manager.isPro)
        assertNull(store.read())
    }

    @Test
    fun `manager rejects a bad key and keeps the previous state`() {
        val manager = LicenseManager(verifier, InMemorySecretStore(), buildDays = 20_500)
        val result = manager.activate("PSHOT-AAAAAA-BBBBBB")
        assertTrue(result is ActivationResult.Failure)
        assertFalse(manager.isPro)
    }

    @Test
    fun `a stored key that no longer verifies is dropped on start`() {
        val store = InMemorySecretStore("garbage")
        val manager = LicenseManager(verifier, store, buildDays = 20_500)
        assertFalse(manager.isPro)
        assertEquals(EntitlementReason.Invalid, manager.entitlement.value.reason)
        assertNull(store.read())
    }

    @Test
    fun `a genuine key on a later build is Free but kept`() {
        val store = InMemorySecretStore(key("valid-personal"))
        val manager = LicenseManager(verifier, store, buildDays = 30_000)
        assertFalse(manager.isPro)
        assertEquals(EntitlementReason.UpdatesExpired, manager.entitlement.value.reason)
        assertNotNull("kept so an older build, or a free update, can use it", store.read())
    }

    @Test
    fun `activating on a build past the window succeeds but is not Pro`() {
        val manager = LicenseManager(verifier, InMemorySecretStore(), buildDays = 30_000)
        val result = manager.activate(key("valid-personal")) as ActivationResult.Success
        assertFalse(result.entitlement.pro)
        assertEquals(EntitlementReason.UpdatesExpired, result.entitlement.reason)
    }

    // ---- shared vectors -------------------------------------------------------------------------

    /**
     * `entitlementCases` in packages/license/test-vectors.json (written by the TypeScript and Rust workstreams):
     * `{ name, key, buildDays, pro, reason?, updatesUntilDays? }`. The same file drives their tests.
     */
    @Test
    fun `shared entitlement vectors agree`() {
        val cases = vectors.getJSONArray("entitlementCases")
        assertTrue("expected the shared entitlement vectors", cases.length() >= 10)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val e = Entitlements.evaluate(c.getString("key"), verifier, c.getLong("buildDays"))
            assertEquals("$name pro", c.getBoolean("pro"), e.pro)
            assertEquals("$name reason", c.optString("reason", ""), e.reason?.id ?: "")
            if (c.has("updatesUntilDays")) {
                val days = c.getLong("updatesUntilDays")
                assertEquals("$name updatesUntilDays", days, Entitlements.updatesUntilDays(requireNotNull(e.info)))
                assertEquals("$name updatesUntil", Entitlements.isoDate(days), e.updatesUntil)
            } else {
                assertNull("$name updatesUntil", e.updatesUntil)
            }
        }
    }

    @Test
    fun `iso dates match the TypeScript daysToIso`() {
        assertEquals("1970-01-01", Entitlements.isoDate(0))
        assertEquals("2027-01-15", Entitlements.isoDate(20833))
        assertEquals("2000-02-29", Entitlements.isoDate(11016))
        // Far beyond year 9999 there is no leading plus sign, exactly as the TypeScript test expects.
        assertEquals("11761191-01-20", Entitlements.isoDate(4_294_967_295L))
        assertFalse(Entitlements.isoDate(4_294_967_295L).startsWith("+"))
    }

    private companion object {
        fun loadVectors(): JSONObject {
            val configured = System.getProperty("polishot.licenseVectors")
            val file = if (!configured.isNullOrBlank()) File(configured) else File("../../../packages/license/test-vectors.json")
            require(file.isFile) { "licence test vectors not found at ${file.absolutePath}" }
            return JSONObject(file.readText(Charsets.UTF_8))
        }
    }
}
