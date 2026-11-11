package app.polishot.quicksend

import app.polishot.license.InMemorySecretStore
import app.polishot.license.SecretStore
import app.polishot.license.SecretUnavailableException
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QuickSendStoreTest {
    private fun pairRecord(name: String): PairRecord {
        val peer = Identity.generate()
        return PairRecord(peer.publicKey, ByteArray(Protocol.PAIR_KEY_LEN) { 9 }, name)
    }

    @Test
    fun `the identity is created once and survives a restart`() {
        val secrets = InMemorySecretStore()
        val first = QuickSendStore(secrets).identity()
        val again = QuickSendStore(secrets).identity()
        assertEquals(first.id, again.id)
        assertNotNull(secrets.read())
    }

    @Test
    fun `pairs are stored replaced and removed`() {
        val secrets = InMemorySecretStore()
        val store = QuickSendStore(secrets)
        val a = pairRecord("Desk PC")
        store.addPair(a)
        store.addPair(pairRecord("Laptop"))
        assertEquals(2, store.pairs().size)
        assertEquals("Desk PC", store.pairFor(a.peerId)?.peerName)

        // The same device paired again replaces the old record instead of duplicating it.
        store.addPair(PairRecord(a.peerPublic, ByteArray(Protocol.PAIR_KEY_LEN) { 1 }, "Desk PC 2"))
        assertEquals(2, store.pairs().size)
        assertEquals("Desk PC 2", store.pairFor(a.peerId)?.peerName)

        // A fresh store reads the same pairs back.
        assertEquals(2, QuickSendStore(secrets).pairs().size)

        store.removePair(a.peerId)
        assertNull(store.pairFor(a.peerId))
        assertEquals(1, QuickSendStore(secrets).pairs().size)
    }

    @Test
    fun `the number of pairs is capped`() {
        val store = QuickSendStore(InMemorySecretStore())
        repeat(QuickSendStore.MAX_PAIRS + 5) { store.addPair(pairRecord("Device $it")) }
        assertEquals(QuickSendStore.MAX_PAIRS, store.pairs().size)
    }

    @Test
    fun `a damaged secret is replaced by a new identity`() {
        val secrets = InMemorySecretStore("this is not json")
        val store = QuickSendStore(secrets)
        val identity = store.identity()
        assertTrue(store.pairs().isEmpty())
        assertNotEquals("this is not json", secrets.read())
        assertEquals(identity.id, QuickSendStore(secrets).identity().id)
    }

    @Test
    fun `one damaged pair record does not cost the others`() {
        val secrets = InMemorySecretStore()
        val store = QuickSendStore(secrets)
        store.addPair(pairRecord("Good"))
        val damaged = secrets.read()!!.replaceFirst("\"pairs\":[\"", "\"pairs\":[\"AAAA\",\"")
        secrets.write(damaged)
        val reread = QuickSendStore(secrets)
        assertEquals(listOf("Good"), reread.pairs().map { it.peerName })
    }

    /** A store whose read fails on demand, the way a busy Keystore does; every write is counted. */
    private class FlakySecrets(private val inner: InMemorySecretStore = InMemorySecretStore()) : SecretStore {
        @Volatile var unavailable = false
        var writes = 0
        var clears = 0

        override fun read(): String? {
            if (unavailable) throw SecretUnavailableException()
            return inner.read()
        }

        override fun write(value: String) {
            writes++
            inner.write(value)
        }

        override fun clear() {
            clears++
            inner.clear()
        }
    }

    @Test
    fun `a busy Keystore never replaces the identity or the pairs`() {
        val secrets = FlakySecrets()
        val store = QuickSendStore(secrets)
        val identity = store.identity()
        store.addPair(pairRecord("Desk PC"))
        val writesBefore = secrets.writes

        // A new process starts while the Keystore is busy: nothing may be generated, written or cleared.
        secrets.unavailable = true
        val restarted = QuickSendStore(secrets)
        try {
            restarted.identity()
            org.junit.Assert.fail("expected SecretUnavailableException")
        } catch (expected: SecretUnavailableException) {
            // reported to the caller, who retries later
        }
        try {
            restarted.pairs()
            org.junit.Assert.fail("expected SecretUnavailableException")
        } catch (expected: SecretUnavailableException) {
            // same
        }
        assertEquals("nothing was written while the secret was unreadable", writesBefore, secrets.writes)
        assertEquals(0, secrets.clears)

        // When the Keystore answers again, the same instance gets the original identity and pairing back.
        secrets.unavailable = false
        assertEquals(identity.id, restarted.identity().id)
        assertEquals(listOf("Desk PC"), restarted.pairs().map { it.peerName })
    }

    @Test
    fun `adding a pair while the Keystore is busy fails without losing the others`() {
        val secrets = FlakySecrets()
        val store = QuickSendStore(secrets)
        store.addPair(pairRecord("Keep me"))

        secrets.unavailable = true
        val fresh = QuickSendStore(secrets)
        try {
            fresh.addPair(pairRecord("New one"))
            org.junit.Assert.fail("expected SecretUnavailableException")
        } catch (expected: SecretUnavailableException) {
            // fine
        }
        secrets.unavailable = false
        assertEquals(listOf("Keep me"), QuickSendStore(secrets).pairs().map { it.peerName })
    }

    @Test
    fun `reset forgets the identity and pairs`() {
        val secrets = InMemorySecretStore()
        val store = QuickSendStore(secrets)
        val before = store.identity().id
        store.addPair(pairRecord("Desk PC"))
        store.reset()
        assertNull(secrets.read())
        assertNotEquals(before, store.identity().id)
        assertTrue(store.pairs().isEmpty())
    }
}

class StallWatchdogTest {
    private val now = AtomicLong(0)

    @Test
    fun `it stays quiet until the first progress arms it`() {
        var fired = 0
        val dog = StallWatchdog(30_000, { now.get() }) { fired++ }
        now.set(10_000_000)
        assertFalse(dog.check()) // waiting for the receiver's decision is not a stall
        assertEquals(0, fired)
    }

    @Test
    fun `it fires once after thirty seconds without progress`() {
        var fired = 0
        val dog = StallWatchdog(30_000, { now.get() }) { fired++ }
        now.set(1_000)
        dog.touch()
        now.set(30_999)
        assertFalse(dog.check())
        now.set(31_001)
        assertTrue(dog.check())
        assertTrue(dog.hasFired)
        assertFalse("only once", dog.check())
        assertEquals(1, fired)
    }

    @Test
    fun `progress keeps pushing the deadline back`() {
        var fired = 0
        val dog = StallWatchdog(30_000, { now.get() }) { fired++ }
        for (t in listOf(0L, 20_000L, 40_000L, 60_000L)) {
            now.set(t)
            dog.touch()
            assertFalse(dog.check())
        }
        assertEquals(0, fired)
    }

    @Test
    fun `problem kinds map from library failures`() {
        fun kind(f: Failure, remote: ErrorCode? = null) = ProblemKind.from(QuickSendException(f, "x", remote))
        assertEquals(ProblemKind.Declined, kind(Failure.DECLINED))
        assertEquals(ProblemKind.PairingCancelled, kind(Failure.PAIRING_REJECTED))
        assertEquals(ProblemKind.Unpaired, kind(Failure.UNPAIRED))
        assertEquals(ProblemKind.Busy, kind(Failure.REMOTE, ErrorCode.BUSY))
        assertEquals(ProblemKind.Unpaired, kind(Failure.REMOTE, ErrorCode.UNPAIRED))
        assertEquals(ProblemKind.Failed, kind(Failure.REMOTE, ErrorCode.INTERNAL))
        assertEquals(ProblemKind.Connection, kind(Failure.CLOSED))
        assertEquals(ProblemKind.Timeout, kind(Failure.TIMEOUT))
        assertEquals(ProblemKind.Failed, kind(Failure.CRYPTO))
    }
}
