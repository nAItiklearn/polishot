package app.polishot.quicksend

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** Active-attacker behaviour: tampering, replay, reordering, oversize frames, MITM during pairing. */
class SecurityTest {

    // sender-to-receiver frame indices: 0 HELLO, 1 AUTH, 2 OFFER, 3.. CHUNK, last DONE
    private val firstChunk = 3
    private val bodyOffset = 5

    private fun transferThrough(
        p: Paired,
        data: ByteArray,
        mutate: (Int, ByteArray) -> List<ByteArray>,
    ): Pair<Result<Unit>, Result<ReceivedFile>> {
        val (tx, rx) = duplex(mutate)
        val receiver = async { QuickSend.receive(rx, p.b, listOf(p.bHasA)) { true } }
        val sender = runCatching {
            QuickSend.sendFile(tx, p.a, p.aHasB, FileMeta("a.png", "image/png"), data)
        }
        return Pair(sender, receiver.await())
    }

    @Test
    fun aPassThroughRelayIsTransparent() {
        val p = pairDevices()
        val data = fakePng(150_000)
        val (sent, got) = transferThrough(p, data) { _, f -> listOf(f) }
        sent.getOrThrow()
        assertTrue(data.contentEquals(got.getOrThrow().data))
    }

    @Test
    fun tamperedChunkIsRejected() {
        val p = pairDevices()
        val (sent, got) = transferThrough(p, fakePng(150_000)) { i, f ->
            if (i == firstChunk) f[bodyOffset + 10] = (f[bodyOffset + 10].toInt() xor 1).toByte()
            listOf(f)
        }
        assertEquals(Failure.CRYPTO, got.failureKind())
        assertEquals(ErrorCode.PROTOCOL, sent.remoteCode())
    }

    @Test
    fun tamperedFrameTypeIsRejected() {
        val p = pairDevices()
        val (_, got) = transferThrough(p, fakePng(150_000)) { i, f ->
            if (i == firstChunk) f[4] = FrameType.DONE.toByte()
            listOf(f)
        }
        assertEquals(Failure.CRYPTO, got.failureKind())
    }

    @Test
    fun replayedChunkIsRejected() {
        val p = pairDevices()
        val (sent, got) = transferThrough(p, fakePng(150_000)) { i, f ->
            if (i == firstChunk) listOf(f, f.copyOf()) else listOf(f)
        }
        assertEquals(Failure.CRYPTO, got.failureKind())
        assertTrue(sent.isFailure)
    }

    @Test
    fun reorderedChunksAreRejected() {
        val p = pairDevices()
        var held: ByteArray? = null
        val (sent, got) = transferThrough(p, fakePng(150_000)) { i, f ->
            when (i) {
                firstChunk -> {
                    held = f
                    emptyList()
                }
                firstChunk + 1 -> listOf(f, held ?: error("nothing held"))
                else -> listOf(f)
            }
        }
        assertEquals(Failure.CRYPTO, got.failureKind())
        assertTrue(sent.isFailure)
    }

    @Test
    fun droppedChunkIsRejected() {
        val p = pairDevices()
        val (sent, got) = transferThrough(p, fakePng(150_000)) { i, f ->
            if (i == firstChunk) emptyList() else listOf(f)
        }
        assertEquals(Failure.CRYPTO, got.failureKind())
        assertTrue(sent.isFailure)
    }

    @Test
    fun aFrameRecordedInAnotherSessionIsRejected() {
        val p = pairDevices()
        val data = fakePng(70_000)
        var recorded: ByteArray? = null
        val (sent, _) = transferThrough(p, data) { i, f ->
            if (i == firstChunk) recorded = f.copyOf()
            listOf(f)
        }
        sent.getOrThrow()
        val old = recorded ?: error("no chunk was recorded")
        val (_, got) = transferThrough(p, data) { i, f -> if (i == firstChunk) listOf(old) else listOf(f) }
        assertEquals(Failure.CRYPTO, got.failureKind())
    }

    @Test
    fun tamperedAuthMacIsRejected() {
        val p = pairDevices()
        val (sent, got) = transferThrough(p, fakePng(1000)) { i, f ->
            if (i == 1) f[bodyOffset] = (f[bodyOffset].toInt() xor 0x80).toByte()
            listOf(f)
        }
        assertEquals(Failure.AUTH_FAILED, got.failureKind())
        assertEquals(ErrorCode.AUTH_FAILED, sent.remoteCode())
    }

    @Test
    fun oversizedFramesAreRejectedBeforeAllocation() {
        val p = pairDevices()
        fun receiveAfterWriting(vararg raw: Int): Failure? {
            val (client, server) = duplex()
            for (b in raw) client.output.write(b)
            return runCatching { QuickSend.receive(server, p.b, listOf(p.bHasA)) { true } }.failureKind()
        }
        // 2000 bytes before authentication (limit 1024), then HELLO's type byte; the body never has to arrive
        assertEquals(Failure.FRAME_TOO_LARGE, receiveAfterWriting(0, 0, 0x07, 0xD0, 1))
        // an absurd length
        assertEquals(Failure.FRAME_TOO_LARGE, receiveAfterWriting(0xFF, 0xFF, 0xFF, 0xFF))
        // a zero-length frame
        assertEquals(Failure.PROTOCOL, receiveAfterWriting(0, 0, 0, 0))
    }

    @Test
    fun truncatedStreamIsACleanError() {
        val p = pairDevices()
        val (client, server) = duplex()
        client.output.write(byteArrayOf(0, 0, 0, 20, 1, 1, 1))
        client.close()
        val r = runCatching { QuickSend.receive(server, p.b, listOf(p.bHasA)) { true } }
        assertEquals(Failure.CLOSED, r.failureKind())
    }

    @Test
    fun unknownVersionRangeIsRefusedWithACleanCode() {
        val responder = Identity.generate()
        val (client, server) = duplex()
        // HELLO: versions 2..3, intent pair, id, no ephemeral key
        val body = byteArrayOf(2, 3, 1) + ByteArray(10) { 9 } + byteArrayOf(0)
        val len = 1 + body.size
        client.output.write(byteArrayOf(0, 0, 0, len.toByte(), FrameType.HELLO.toByte()) + body)
        val r = runCatching { QuickSend.pairResponder(server, responder, "PC") }
        assertEquals(Failure.UNSUPPORTED_VERSION, r.failureKind())
        val reply = ByteArray(7)
        var got = 0
        while (got < reply.size) {
            val n = client.input.read(reply, got, reply.size - got)
            if (n < 0) break
            got += n
        }
        assertEquals(7, got)
        assertEquals(FrameType.ERROR, reply[4].toInt())
        assertEquals(ErrorCode.UNSUPPORTED_VERSION.wire, ((reply[5].toInt() and 0xFF) shl 8) or (reply[6].toInt() and 0xFF))
    }

    // ---- pairing under a man in the middle ----------------------------------------------------------------

    @Test
    fun sasDiffersWhenAManInTheMiddleSubstitutesKeys() {
        val alice = Identity.generate()
        val bob = Identity.generate()
        val mallory = Identity.generate()
        val (aWire, mToA) = duplex() // Alice <-> Mallory
        val (mToB, bWire) = duplex() // Mallory <-> Bob

        val bobSide = async {
            val p = QuickSend.pairResponder(bWire, bob, "Bob")
            val sas = p.sas
            runCatching { p.confirm(false) }
            sas
        }
        val malSide = async {
            val toAlice = QuickSend.pairResponder(mToA, mallory, "Bob")
            val toBob = QuickSend.pairInitiator(mToB, mallory, "Alice")
            val r = Pair(toAlice.sas, toBob.sas)
            runCatching { toAlice.confirm(false) }
            runCatching { toBob.confirm(false) }
            r
        }
        val pa = QuickSend.pairInitiator(aWire, alice, "Alice")
        val sasAlice = pa.sas
        runCatching { pa.confirm(false) }
        val sasBob = bobSide.await().getOrThrow()
        val (malA, malB) = malSide.await().getOrThrow()
        // each leg is internally consistent, but the two humans see different codes (1 in 10^6 flake chance)
        assertEquals(sasAlice, malA)
        assertEquals(sasBob, malB)
        assertNotEquals(sasAlice, sasBob)
    }

    @Test
    fun aSubstitutedResponderKeyIsCaughtByTheDeviceIdCheck() {
        val alice = Identity.generate()
        val bob = Identity.generate()
        val mallory = Identity.generate()
        // frames bob -> alice: 0 HELLO, 1 PAIR_RESPONSE; swap the long-term key in the response
        val (bobT, aliceT) = duplex { i, f ->
            if (i == 1) System.arraycopy(mallory.publicKey, 0, f, bodyOffset, 65)
            listOf(f)
        }
        val bobSide = async { QuickSend.pairResponder(bobT, bob, "Bob") }
        val r = runCatching { QuickSend.pairInitiator(aliceT, alice, "Alice") }
        assertEquals(Failure.PROTOCOL, r.failureKind())
        bobSide.await()
    }

    @Test
    fun aRevealThatDoesNotOpenTheCommitmentIsRejected() {
        val alice = Identity.generate()
        val bob = Identity.generate()
        val other = Identity.generate() // any valid P-256 point works as a substitute ephemeral key
        // frames alice -> bob: 0 HELLO, 1 PAIR_REQUEST, 2 PAIR_REVEAL
        val (aliceT, bobT) = duplex { i, f ->
            if (i == 2) System.arraycopy(other.publicKey, 0, f, bodyOffset, 65)
            listOf(f)
        }
        val bobSide = async { QuickSend.pairResponder(bobT, bob, "Bob") }
        runCatching { QuickSend.pairInitiator(aliceT, alice, "Alice") }
        assertEquals(Failure.BAD_COMMITMENT, bobSide.await().failureKind())
    }

    @Test
    fun pairingWithYourselfIsRefused() {
        val me = Identity.generate()
        val (a, b) = duplex()
        val responder = async { QuickSend.pairResponder(b, me, "PC") }
        val initiator = runCatching { QuickSend.pairInitiator(a, me, "PC") }
        assertTrue(initiator.isFailure)
        assertEquals(Failure.SELF_PAIRING, responder.await().failureKind())
    }
}
