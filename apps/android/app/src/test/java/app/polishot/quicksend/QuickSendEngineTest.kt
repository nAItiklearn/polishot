package app.polishot.quicksend

import app.polishot.license.InMemorySecretStore
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Two engines on real loopback sockets: pairing with a six-digit code, a verified transfer, a declined transfer, a
 * rejected pairing and pairing mode being off. This is the app's side of docs/QUICKSEND.md exercised end to end.
 */
class QuickSendEngineTest {
    private class Recorder(private val acceptOffers: Boolean = true, private val codesMatch: Boolean = true) : QuickSendEngine.Prompts {
        val sas = CompletableFuture<String>()
        val received = CompletableFuture<ReceivedFile>()
        val paired = CompletableFuture<PairRecord>()
        val problems = CopyOnWriteArrayList<ProblemKind>()
        val problemSeen = CountDownLatch(1)
        val progress = CopyOnWriteArrayList<Long>()
        val offers = CopyOnWriteArrayList<OfferInfo>()

        override fun confirmOffer(offer: OfferInfo): Boolean {
            offers.add(offer)
            return acceptOffers
        }

        override fun confirmPairing(sas: String, peerName: String, peerId: DeviceId): Boolean {
            this.sas.complete(sas)
            return codesMatch
        }

        override fun onReceived(file: ReceivedFile) {
            received.complete(file)
        }

        override fun onPaired(record: PairRecord) {
            paired.complete(record)
        }

        override fun onProblem(kind: ProblemKind) {
            problems.add(kind)
            problemSeen.countDown()
        }

        override fun onSendProgress(done: Long, total: Long) {
            progress.add(done)
        }
    }

    private val phoneStore = QuickSendStore(InMemorySecretStore())
    private val pcStore = QuickSendStore(InMemorySecretStore())
    private val engines = ArrayList<QuickSendEngine>()

    private fun engine(store: QuickSendStore, prompts: QuickSendEngine.Prompts, name: String) =
        QuickSendEngine(store, prompts, ownName = { name }).also { engines.add(it) }

    @Before
    fun warmUp() {
        // Key generation is slow on a cold JVM; do it before the timed parts.
        phoneStore.identity()
        pcStore.identity()
    }

    @After
    fun tearDown() {
        engines.forEach { it.shutdown() }
    }

    private fun png(size: Int = 200_000): ByteArray =
        byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) + ByteArray(size) { (it * 31).toByte() }

    private fun pair(phone: QuickSendEngine, phonePrompts: Recorder, pcPrompts: Recorder, pc: QuickSendEngine) {
        phone.pairingOpen = true
        val port = phone.startListening()
        pc.pairWith("127.0.0.1", port)
        val phoneRecord = phonePrompts.paired.get(10, TimeUnit.SECONDS)
        val pcRecord = pcPrompts.paired.get(10, TimeUnit.SECONDS)
        assertNotNull(phoneRecord)
        assertNotNull(pcRecord)
    }

    @Test
    fun `pairing shows the same six digit code on both sides and stores the pair`() {
        val phonePrompts = Recorder()
        val pcPrompts = Recorder()
        val phone = engine(phoneStore, phonePrompts, "Pixel")
        val pc = engine(pcStore, pcPrompts, "Desk PC")
        pair(phone, phonePrompts, pcPrompts, pc)

        val phoneSas = phonePrompts.sas.get(5, TimeUnit.SECONDS)
        assertEquals(phoneSas, pcPrompts.sas.get(5, TimeUnit.SECONDS))
        assertTrue("six digits expected: $phoneSas", Regex("^[0-9]{6}$").matches(phoneSas))

        assertEquals(1, phoneStore.pairs().size)
        assertEquals("Desk PC", phoneStore.pairs().single().peerName)
        assertEquals(1, pcStore.pairs().size)
        assertEquals("Pixel", pcStore.pairs().single().peerName)
        assertEquals(pcStore.identity().id, phoneStore.pairs().single().peerId)
    }

    @Test
    fun `a rejected code pairs nobody`() {
        val phonePrompts = Recorder(codesMatch = true)
        val pcPrompts = Recorder(codesMatch = false)
        val phone = engine(phoneStore, phonePrompts, "Pixel")
        val pc = engine(pcStore, pcPrompts, "Desk PC")
        phone.pairingOpen = true
        pc.pairWith("127.0.0.1", phone.startListening())

        assertTrue(pcPrompts.problemSeen.await(10, TimeUnit.SECONDS))
        assertTrue(phonePrompts.problemSeen.await(10, TimeUnit.SECONDS))
        assertEquals(ProblemKind.PairingCancelled, pcPrompts.problems.first())
        assertTrue(phoneStore.pairs().isEmpty())
        assertTrue(pcStore.pairs().isEmpty())
    }

    @Test
    fun `pairing is refused while pairing mode is off`() {
        val phonePrompts = Recorder()
        val pcPrompts = Recorder()
        val phone = engine(phoneStore, phonePrompts, "Pixel")
        val pc = engine(pcStore, pcPrompts, "Desk PC")
        phone.pairingOpen = false
        pc.pairWith("127.0.0.1", phone.startListening())

        assertTrue(pcPrompts.problemSeen.await(10, TimeUnit.SECONDS))
        assertTrue(pcPrompts.problems.first() in setOf(ProblemKind.PairingOff, ProblemKind.Connection))
        assertTrue(phoneStore.pairs().isEmpty())
        assertFalse(phonePrompts.sas.isDone)
    }

    @Test
    fun `a paired device can send an image and the receiver gets identical bytes`() {
        val phonePrompts = Recorder()
        val pcPrompts = Recorder()
        val phone = engine(phoneStore, phonePrompts, "Pixel")
        val pc = engine(pcStore, pcPrompts, "Desk PC")
        pair(phone, phonePrompts, pcPrompts, pc)

        val image = png()
        val record = pcStore.pairs().single()
        val outcome = pc.send("127.0.0.1", phone.port!!, record, "shot.png", "image/png", image)

        assertEquals(SendOutcome.Sent, outcome)
        val file = phonePrompts.received.get(10, TimeUnit.SECONDS)
        assertArrayEquals(image, file.data)
        assertEquals("image/png", file.mime)
        assertEquals("shot.png", file.name)
        assertEquals(pcStore.identity().id, file.peerId)
        assertEquals(image.size.toLong(), phonePrompts.offers.single().size)
        assertTrue("progress is reported", pcPrompts.progress.isNotEmpty())
        assertEquals(image.size.toLong(), pcPrompts.progress.last())
    }

    @Test
    fun `a declined image is reported to the sender and nothing is delivered`() {
        val phonePrompts = Recorder(acceptOffers = false)
        val pcPrompts = Recorder()
        val phone = engine(phoneStore, phonePrompts, "Pixel")
        val pc = engine(pcStore, pcPrompts, "Desk PC")
        pair(phone, phonePrompts, pcPrompts, pc)

        val outcome = pc.send("127.0.0.1", phone.port!!, pcStore.pairs().single(), "shot.png", "image/png", png(1000))

        assertEquals(SendOutcome.Failed(ProblemKind.Declined), outcome)
        assertFalse(phonePrompts.received.isDone)
    }

    @Test
    fun `a file whose content does not match its type never reaches the receiver`() {
        val phonePrompts = Recorder()
        val pcPrompts = Recorder()
        val phone = engine(phoneStore, phonePrompts, "Pixel")
        val pc = engine(pcStore, pcPrompts, "Desk PC")
        pair(phone, phonePrompts, pcPrompts, pc)

        val outcome = pc.send("127.0.0.1", phone.port!!, pcStore.pairs().single(), "x.png", "image/png", ByteArray(500) { 7 })

        assertEquals(SendOutcome.Failed(ProblemKind.BadFile), outcome)
        assertFalse(phonePrompts.received.isDone)
    }

    @Test
    fun `sending to a device that is not listening reports unreachable`() {
        val phonePrompts = Recorder()
        val pcPrompts = Recorder()
        val phone = engine(phoneStore, phonePrompts, "Pixel")
        val pc = engine(pcStore, pcPrompts, "Desk PC")
        pair(phone, phonePrompts, pcPrompts, pc)
        val port = phone.port!!
        phone.stopListening()

        val outcome = pc.send("127.0.0.1", port, pcStore.pairs().single(), "x.png", "image/png", png(100))
        assertEquals(SendOutcome.Failed(ProblemKind.Unreachable), outcome)
    }

    @Test
    fun `the listener is only up between start and stop`() {
        val phone = engine(phoneStore, Recorder(), "Pixel")
        assertNull(phone.port)
        val port = phone.startListening()
        assertEquals(port, phone.startListening())
        assertEquals(port, phone.port)
        phone.stopListening()
        assertNull(phone.port)
    }
}
