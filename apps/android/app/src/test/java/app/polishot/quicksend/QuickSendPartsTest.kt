package app.polishot.quicksend

import java.net.InetAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pairing prompt slot: at most one question waits for the user at a time, and a prompt that timed out can never
 * clear the one that replaced it.
 */
class PromptSlotTest {
    @Test
    fun `the first prompt gets the slot and a second is refused while it waits`() {
        val slot = PromptSlot()
        val first = slot.begin()
        assertNotNull(first)
        assertNull("a second inbound request must be refused, not orphan the first", slot.begin())
    }

    @Test
    fun `an answer completes the waiting prompt`() {
        val slot = PromptSlot()
        val waiting = requireNotNull(slot.begin())
        slot.answer(true)
        assertTrue(waiting.isDone)
        assertTrue(waiting.get())

        val slot2 = PromptSlot()
        val declined = requireNotNull(slot2.begin())
        slot2.answer(false)
        assertFalse(declined.get())
    }

    @Test
    fun `an answer with nothing waiting is harmless`() {
        val slot = PromptSlot()
        slot.answer(true)
        val later = requireNotNull(slot.begin())
        assertFalse("an old answer must not satisfy a later prompt", later.isDone)
    }

    @Test
    fun `finishing frees the slot for the next prompt`() {
        val slot = PromptSlot()
        val first = requireNotNull(slot.begin())
        assertTrue(slot.finish(first))
        assertNotNull(slot.begin())
    }

    @Test
    fun `a stale prompt cannot release the slot of the one that replaced it`() {
        val slot = PromptSlot()
        val old = requireNotNull(slot.begin())
        assertTrue(slot.finish(old)) // it timed out
        val replacement = requireNotNull(slot.begin())

        assertFalse("the old prompt finishing late must change nothing", slot.finish(old))
        assertNull("the replacement still owns the slot", slot.begin())
        assertFalse(replacement.isDone)

        slot.answer(true)
        assertTrue(replacement.get())
        assertTrue(slot.finish(replacement))
    }

    @Test
    fun `finishing twice is safe`() {
        val slot = PromptSlot()
        val prompt = requireNotNull(slot.begin())
        assertTrue(slot.finish(prompt))
        assertFalse(slot.finish(prompt))
    }

    @Test
    fun `when many requests race exactly one wins the slot`() {
        val slot = PromptSlot()
        val threads = 16
        val pool = Executors.newFixedThreadPool(threads)
        try {
            val start = CountDownLatch(1)
            val winners = AtomicInteger()
            val futures = ArrayList<CompletableFuture<Boolean>?>()
            val done = CountDownLatch(threads)
            repeat(threads) {
                pool.execute {
                    start.await()
                    val got = slot.begin()
                    if (got != null) {
                        winners.incrementAndGet()
                        synchronized(futures) { futures.add(got) }
                    }
                    done.countDown()
                }
            }
            start.countDown()
            assertTrue(done.await(10, TimeUnit.SECONDS))
            assertEquals(1, winners.get())
            assertEquals(1, futures.size)
        } finally {
            pool.shutdownNow()
        }
    }
}

/** Which address of an mDNS answer is used to connect to a peer. */
class NsdAddressesTest {
    private fun v4(a: Int, b: Int, c: Int, d: Int): InetAddress =
        InetAddress.getByAddress(byteArrayOf(a.toByte(), b.toByte(), c.toByte(), d.toByte()))

    private fun v6(vararg groups: Int): InetAddress {
        val bytes = ByteArray(16)
        for ((i, g) in groups.withIndex()) {
            bytes[i * 2] = (g ushr 8).toByte()
            bytes[i * 2 + 1] = g.toByte()
        }
        return InetAddress.getByAddress(bytes)
    }

    private val lan = v4(192, 168, 1, 20)
    private val globalV6 = v6(0x2001, 0x0db8, 0, 0, 0, 0, 0, 1)

    @Test
    fun `an empty answer has no address`() {
        assertNull(NsdAddresses.pick(emptyList()))
    }

    @Test
    fun `IPv4 is preferred whatever the order`() {
        assertEquals(lan, NsdAddresses.pick(listOf(globalV6, lan)))
        assertEquals(lan, NsdAddresses.pick(listOf(lan, globalV6)))
    }

    @Test
    fun `IPv6 is used when there is no usable IPv4`() {
        assertEquals(globalV6, NsdAddresses.pick(listOf(globalV6)))
    }

    @Test
    fun `addresses that point back at this phone are never used`() {
        val loopback4 = v4(127, 0, 0, 1)
        val loopback6 = v6(0, 0, 0, 0, 0, 0, 0, 1)
        val wildcard4 = v4(0, 0, 0, 0)
        val wildcard6 = v6(0, 0, 0, 0, 0, 0, 0, 0)
        assertNull(NsdAddresses.pick(listOf(loopback4, loopback6, wildcard4, wildcard6)))
        assertEquals("a real address after the bad ones is still found", lan, NsdAddresses.pick(listOf(loopback4, wildcard4, lan)))
    }

    @Test
    fun `multicast addresses are never used`() {
        val multicast4 = v4(224, 0, 0, 251)
        val multicast6 = v6(0xff02, 0, 0, 0, 0, 0, 0, 0xfb)
        assertNull(NsdAddresses.pick(listOf(multicast4, multicast6)))
    }

    @Test
    fun `link local addresses are skipped`() {
        val linkLocal4 = v4(169, 254, 10, 10)
        val linkLocal6 = v6(0xfe80, 0, 0, 0, 0, 0, 0, 1)
        assertNull(NsdAddresses.pick(listOf(linkLocal4, linkLocal6)))
        assertEquals("a global IPv6 beats a link-local IPv4", globalV6, NsdAddresses.pick(listOf(linkLocal4, globalV6)))
        assertEquals(lan, NsdAddresses.pick(listOf(linkLocal6, linkLocal4, lan)))
    }
}

/** The hand-over of a rendered image from the editor to the "Send to" screen. */
class QuickSendOutboxTest {
    private fun fresh(): QuickSendOutbox {
        QuickSendOutbox.clear()
        return QuickSendOutbox
    }

    @Test
    fun `an image waits until it is cleared and survives a screen recreate`() {
        val outbox = fresh()
        val png = byteArrayOf(1, 2, 3)
        outbox.put(png)
        assertArrayEquals(png, outbox.peek())
        assertArrayEquals("peeking does not consume it", png, outbox.peek())
        outbox.clear()
        assertNull(outbox.peek())
    }

    @Test
    fun `take hands the image over once`() {
        val outbox = fresh()
        outbox.put(byteArrayOf(9))
        assertArrayEquals(byteArrayOf(9), outbox.take())
        assertNull(outbox.take())
        assertNull(outbox.peek())
    }

    @Test
    fun `a new image replaces the waiting one`() {
        val outbox = fresh()
        outbox.put(byteArrayOf(1))
        outbox.put(byteArrayOf(2))
        assertArrayEquals(byteArrayOf(2), outbox.peek())
        outbox.clear()
    }
}
