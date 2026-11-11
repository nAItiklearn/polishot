package app.polishot.license

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The licence manager's restore-on-a-background-thread behaviour: the app starts as Free, the stored key is checked
 * off the main thread, whatever the user does in the meantime wins, and a Keystore that is merely busy never costs
 * the user their key.
 */
class LicenseManagerTest {
    private val vectors: JSONObject = run {
        val configured = System.getProperty("polishot.licenseVectors")
        val file = if (!configured.isNullOrBlank()) File(configured) else File("../../../packages/license/test-vectors.json")
        require(file.isFile) { "licence test vectors not found at ${file.absolutePath}" }
        JSONObject(file.readText(Charsets.UTF_8))
    }
    private val verifier = LicenseVerifier(vectors.getString("publicKeyHex"))

    // valid-personal was issued on day 20468, so it covers builds up to day 20833.
    private val insideWindow = 20_500L
    private val afterWindow = 20_468L + 366

    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val scope = CoroutineScope(SupervisorJob() + executor.asCoroutineDispatcher())

    @After
    fun tearDown() {
        scope.cancel()
        executor.shutdownNow()
    }

    private fun validKey(): String {
        val cases = vectors.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            if (c.getString("name") == "valid-personal") return c.getString("key")
        }
        throw AssertionError("valid-personal vector missing")
    }

    /** A store whose read can be held back, to stage "the user acts while the stored key is still being checked". */
    private class GateStore(initial: String?, open: Boolean = true) : SecretStore {
        val started = CountDownLatch(1)
        private val gate = CountDownLatch(if (open) 0 else 1)

        @Volatile var value: String? = initial
        @Volatile var clears = 0
        @Volatile var readFailure: Throwable? = null
        @Volatile var writeFailure: Throwable? = null

        fun open() = gate.countDown()

        override fun read(): String? {
            val snapshot = value // what was stored when the restore started, whatever happens next
            started.countDown()
            check(gate.await(10, TimeUnit.SECONDS)) { "test gate never opened" }
            readFailure?.let { throw it }
            return snapshot
        }

        override fun write(value: String) {
            writeFailure?.let { throw it }
            this.value = value
        }

        override fun clear() {
            clears++
            value = null
        }
    }

    // ---- synchronous restore (no scope) ----------------------------------------------------------

    @Test
    fun `without a scope the stored key is restored before the constructor returns`() {
        val manager = LicenseManager(verifier, GateStore(validKey()), insideWindow)
        assertTrue(manager.isRestored)
        assertTrue(manager.isPro)
    }

    @Test
    fun `nothing stored means Free`() {
        val manager = LicenseManager(verifier, GateStore(null), insideWindow)
        assertTrue(manager.isRestored)
        assertFalse(manager.isPro)
        assertEquals(EntitlementReason.NoKey, manager.entitlement.value.reason)
    }

    @Test
    fun `a genuine key from an older window is kept but not Pro`() {
        val store = GateStore(validKey())
        val manager = LicenseManager(verifier, store, afterWindow)
        assertFalse(manager.isPro)
        assertEquals(EntitlementReason.UpdatesExpired, manager.entitlement.value.reason)
        assertEquals("the key stays so a later, covered build can use it", 0, store.clears)
        assertEquals(validKey(), store.value)
    }

    @Test
    fun `a stored key that no longer verifies is dropped`() {
        val store = GateStore("this is not a key")
        val manager = LicenseManager(verifier, store, insideWindow)
        assertFalse(manager.isPro)
        assertEquals(EntitlementReason.Invalid, manager.entitlement.value.reason)
        assertEquals(1, store.clears)
        assertNull(store.value)
    }

    // ---- a busy Keystore must never cost the user their key --------------------------------------

    @Test
    fun `an unavailable secret leaves the stored key alone and the app Free for this run`() {
        val store = GateStore(validKey()).apply { readFailure = SecretUnavailableException() }
        val manager = LicenseManager(verifier, store, insideWindow)
        assertTrue("startup must finish even though the read failed", manager.isRestored)
        assertFalse(manager.isPro)
        assertEquals(0, store.clears)
        assertEquals(validKey(), store.value)
    }

    @Test
    fun `an unexpected read failure is treated the same way`() {
        val store = GateStore(validKey()).apply { readFailure = IllegalStateException("boom") }
        val manager = LicenseManager(verifier, store, insideWindow)
        assertTrue(manager.isRestored)
        assertFalse(manager.isPro)
        assertEquals(0, store.clears)
    }

    // ---- asynchronous restore ---------------------------------------------------------------------

    @Test
    fun `with a scope the app starts Free and becomes Pro when the restore finishes`() = runBlocking {
        val store = GateStore(validKey(), open = false)
        val manager = LicenseManager(verifier, store, insideWindow, scope, executor.asCoroutineDispatcher())

        assertTrue(store.started.await(5, TimeUnit.SECONDS))
        assertFalse("the constructor must not wait for the Keystore", manager.isRestored)
        assertFalse(manager.isPro)

        store.open()
        withTimeout(5_000) { manager.awaitRestored() }
        assertTrue(manager.isRestored)
        assertTrue(manager.isPro)
    }

    @Test
    fun `awaitPro waits for the restore instead of answering Free`() = runBlocking {
        val store = GateStore(validKey(), open = false)
        val manager = LicenseManager(verifier, store, insideWindow, scope, executor.asCoroutineDispatcher())

        val answer = async { manager.awaitPro() }
        delay(150)
        assertFalse("still waiting on the Keystore", answer.isCompleted)

        store.open()
        assertTrue(withTimeout(5_000) { answer.await() })
    }

    @Test
    fun `awaitPro answers Free for a Free user once the restore is done`() = runBlocking {
        val manager = LicenseManager(verifier, GateStore(null), insideWindow, scope, executor.asCoroutineDispatcher())
        assertFalse(withTimeout(5_000) { manager.awaitPro() })
    }

    @Test
    fun `a key activated while the restore is running is not overwritten by it`() = runBlocking {
        // The stored text is junk, so a restore that got the last word would clear the store and drop to Free.
        val store = GateStore("this is not a key", open = false)
        val manager = LicenseManager(verifier, store, insideWindow, scope, executor.asCoroutineDispatcher())
        assertTrue(store.started.await(5, TimeUnit.SECONDS))

        val result = manager.activate(validKey())
        assertTrue(result is ActivationResult.Success)

        store.open()
        withTimeout(5_000) { manager.awaitRestored() }

        assertTrue("the user's key survives the late restore", manager.isPro)
        assertEquals(validKey(), store.value)
        assertEquals(0, store.clears)
    }

    @Test
    fun `removing the key while the restore is running is not undone by it`() = runBlocking {
        val store = GateStore(validKey(), open = false)
        val manager = LicenseManager(verifier, store, insideWindow, scope, executor.asCoroutineDispatcher())
        assertTrue(store.started.await(5, TimeUnit.SECONDS))

        manager.deactivate()
        store.open()
        withTimeout(5_000) { manager.awaitRestored() }

        assertFalse("the restore had read the old key but must not bring it back", manager.isPro)
        assertNull(store.value)
    }

    // ---- activation -------------------------------------------------------------------------------

    @Test
    fun `activating a genuine key stores it and unlocks Pro`() {
        val store = GateStore(null)
        val manager = LicenseManager(verifier, store, insideWindow)
        val result = manager.activate("  " + validKey() + "\n")
        assertTrue(result is ActivationResult.Success)
        assertTrue(manager.isPro)
        assertEquals("surrounding whitespace is not stored", validKey(), store.value)
    }

    @Test
    fun `a rejected key changes nothing`() {
        val store = GateStore(null)
        val manager = LicenseManager(verifier, store, insideWindow)
        val result = manager.activate("PSHOT-AAAAAA-AAAAAA-AAAAAA")
        assertTrue(result is ActivationResult.Failure)
        assertFalse(manager.isPro)
        assertNull(store.value)
    }

    @Test
    fun `a genuine key is honoured for this run even if secure storage fails`() {
        val store = GateStore(null).apply { writeFailure = IllegalStateException("keystore down") }
        val manager = LicenseManager(verifier, store, insideWindow)
        assertTrue(manager.activate(validKey()) is ActivationResult.Success)
        assertTrue(manager.isPro)
    }

    @Test
    fun `a genuine key outside its update window activates but stays Free`() {
        val manager = LicenseManager(verifier, GateStore(null), afterWindow)
        val result = manager.activate(validKey()) as ActivationResult.Success
        assertFalse(result.entitlement.pro)
        assertEquals(EntitlementReason.UpdatesExpired, result.entitlement.reason)
    }

    @Test
    fun `deactivating returns to Free and clears the store`() {
        val store = GateStore(validKey())
        val manager = LicenseManager(verifier, store, insideWindow)
        assertTrue(manager.isPro)
        manager.deactivate()
        assertFalse(manager.isPro)
        assertNull(store.value)
    }
}
