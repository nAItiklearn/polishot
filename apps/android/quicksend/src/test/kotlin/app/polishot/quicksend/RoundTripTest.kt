package app.polishot.quicksend

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/** Kotlin-to-Kotlin behaviour over an in-memory duplex and over a real loopback socket. */
class RoundTripTest {

    @Test
    fun sasMatchesAndRecordsAgree() {
        val p = pairDevices()
        assertEquals(6, p.sas.length)
        assertTrue(p.sas.all { it in '0'..'9' })
        assertArrayEquals(p.aHasB.pairKey, p.bHasA.pairKey)
        assertEquals(p.b.id, p.aHasB.peerId)
        assertEquals(p.a.id, p.bHasA.peerId)
        assertArrayEquals(p.b.publicKey, p.aHasB.peerPublic)
        assertEquals("Phone", p.aHasB.peerName)
        assertEquals("Studio PC", p.bHasA.peerName)
    }

    @Test
    fun rejectedPairingStoresNothingOnEitherSide() {
        val a = Identity.generate()
        val b = Identity.generate()
        val (ta, tb) = duplex()
        val responder = async { QuickSend.pairResponder(tb, b, "Phone").confirm(true) }
        val pa = QuickSend.pairInitiator(ta, a, "PC")
        val mine = runCatching { pa.confirm(false) }
        assertEquals(Failure.PAIRING_REJECTED, mine.failureKind())
        assertEquals(Failure.PAIRING_REJECTED, responder.await().failureKind())
    }

    @Test
    fun transferWithProgressAcrossSeveralChunks() {
        val p = pairDevices()
        val data = fakePng(150_000)
        val (tx, rx) = duplex()
        val seen = ArrayList<Pair<Long, Long>>()
        var offered: OfferInfo? = null
        val receiver = async {
            QuickSend.receive(rx, p.b, listOf(p.bHasA), Config(), { done, total -> seen.add(Pair(done, total)) }) { offer ->
                offered = offer
                true
            }
        }
        val sentProgress = ArrayList<Long>()
        QuickSend.sendFile(
            tx, p.a, p.aHasB, FileMeta("Screenshot 1.png", "image/png"), data,
            Config(), { done, _ -> sentProgress.add(done) },
        )
        val got = receiver.await().getOrThrow()
        assertArrayEquals(data, got.data)
        assertEquals(p.a.id, got.peerId)
        assertEquals("Screenshot 1.png", got.name)
        val info = offered ?: error("the accept callback was not called")
        assertEquals(150_000L, info.size)
        assertEquals("Studio PC", info.peerName)
        assertEquals(Pair(0L, 150_000L), seen.first())
        assertEquals(Pair(150_000L, 150_000L), seen.last())
        assertEquals(listOf(0L, 65_536L, 131_072L, 150_000L), sentProgress)
    }

    @Test
    fun declinedOfferReachesTheSender() {
        val p = pairDevices()
        val (tx, rx) = duplex()
        val receiver = async { QuickSend.receive(rx, p.b, listOf(p.bHasA)) { false } }
        val sent = runCatching {
            QuickSend.sendFile(tx, p.a, p.aHasB, FileMeta("a.png", "image/png"), fakePng(1000))
        }
        assertEquals(Failure.DECLINED, sent.failureKind())
        assertEquals(Failure.DECLINED, receiver.await().failureKind())
    }

    @Test
    fun unpairedSenderIsRefused() {
        val p = pairDevices()
        val stranger = Identity.generate()
        val forged = PairRecord(p.b.publicKey, ByteArray(32) { 5 }, "Phone")
        val (tx, rx) = duplex()
        val receiver = async { QuickSend.receive(rx, p.b, listOf(p.bHasA)) { true } }
        val sent = runCatching {
            QuickSend.sendFile(tx, stranger, forged, FileMeta("a.png", "image/png"), fakePng(500))
        }
        assertEquals(Failure.REMOTE, sent.failureKind())
        assertEquals(ErrorCode.UNPAIRED, sent.remoteCode())
        assertEquals(Failure.UNPAIRED, receiver.await().failureKind())
    }

    @Test
    fun wrongPairKeyFailsAuthenticationOnBothEnds() {
        val p = pairDevices()
        val badKey = p.aHasB.pairKey.copyOf()
        badKey[0] = (badKey[0].toInt() xor 1).toByte()
        val bad = PairRecord(p.aHasB.peerPublic, badKey, p.aHasB.peerName)
        val (tx, rx) = duplex()
        val receiver = async { QuickSend.receive(rx, p.b, listOf(p.bHasA)) { true } }
        val sent = runCatching { QuickSend.sendFile(tx, p.a, bad, FileMeta("a.png", "image/png"), fakePng(500)) }
        assertEquals(ErrorCode.AUTH_FAILED, sent.remoteCode())
        assertEquals(Failure.AUTH_FAILED, receiver.await().failureKind())
    }

    @Test
    fun senderValidatesBeforeConnecting() {
        val p = pairDevices()
        fun attempt(meta: FileMeta, data: ByteArray): Failure? {
            val (tx, _) = duplex()
            return runCatching { QuickSend.sendFile(tx, p.a, p.aHasB, meta, data) }.failureKind()
        }
        val png = fakePng(100)
        assertEquals(Failure.UNSUPPORTED_TYPE, attempt(FileMeta("a.gif", "image/gif"), png))
        assertEquals(Failure.BAD_CONTENT, attempt(FileMeta("a.jpg", "image/jpeg"), png))
        assertEquals(Failure.INVALID_INPUT, attempt(FileMeta("a.png", "image/png"), ByteArray(0)))
        assertEquals(Failure.TOO_LARGE, attempt(FileMeta("a.png", "image/png"), ByteArray(50 * 1024 * 1024 + 1)))
    }

    @Test
    fun silentPeerTimesOut() {
        val id = Identity.generate()
        val (_, rx) = duplex()
        val config = Config(Timeouts(handshakeMs = 150))
        val r = runCatching { QuickSend.receive(rx, id, emptyList(), config) { true } }
        assertEquals(Failure.TIMEOUT, r.failureKind())
    }

    @Test
    fun pairRecordAndIdentitySurviveStorage() {
        val p = pairDevices()
        val a2 = Identity.fromBytes(p.a.toBytes())
        val recA = PairRecord.fromBytes(p.aHasB.toBytes())
        val recB = PairRecord.fromBytes(p.bHasA.toBytes())
        assertEquals(p.a.id, a2.id)
        val data = fakePng(2000)
        val (tx, rx) = duplex()
        val receiver = async { QuickSend.receive(rx, p.b, listOf(recB)) { true } }
        QuickSend.sendFile(tx, a2, recA, FileMeta("x.png", "image/png"), data)
        assertArrayEquals(data, receiver.await().getOrThrow().data)
    }

    @Test
    fun pairingThenTransferOverARealLoopbackSocket() {
        val serverId = Identity.generate()
        val clientId = Identity.generate()
        ServerSocket(0, 5, InetAddress.getLoopbackAddress()).use { listener ->
            val port = listener.localPort
            val data = fakePng(300_000)
            val server = async {
                val first = listener.accept()
                val sc1 = ServeConfig(serverId, "Studio PC", emptyList(), allowPairing = true)
                val pairing = QuickSend.serve(Transport.of(first), sc1) { false } as Incoming.Pairing
                val sasServer = pairing.pending.sas
                val record = pairing.pending.confirm(true)

                val second = listener.accept()
                val sc2 = ServeConfig(serverId, "Studio PC", listOf(record), allowPairing = false)
                val received = QuickSend.serve(Transport.of(second), sc2) { it.mime == "image/png" } as Incoming.Received
                Pair(sasServer, received.file)
            }

            val pending = QuickSend.pairInitiator(Transport.of(Socket(InetAddress.getLoopbackAddress(), port)), clientId, "Pixel")
            val clientSas = pending.sas
            val clientRecord = pending.confirm(true)
            assertEquals(serverId.id, clientRecord.peerId)

            QuickSend.sendFile(
                Transport.of(Socket(InetAddress.getLoopbackAddress(), port)),
                clientId, clientRecord, FileMeta("tcp.png", "image/png"), data,
            )
            val (serverSas, file) = server.await().getOrThrow()
            assertEquals(clientSas, serverSas)
            assertArrayEquals(data, file.data)
            assertEquals(clientId.id, file.peerId)
            assertEquals("tcp.png", file.name)
        }
    }

    @Test
    fun serveRefusesPairingWhenDisabledAndAfterFiveAttempts() {
        val id = Identity.generate()
        val peer = Identity.generate()

        run {
            val (tx, rx) = duplex()
            val server = async { QuickSend.serve(rx, ServeConfig(id, "PC", emptyList(), allowPairing = false)) { true } }
            val r = runCatching { QuickSend.pairInitiator(tx, peer, "Phone") }
            assertEquals(ErrorCode.PAIRING_DISABLED, r.remoteCode())
            assertEquals(Failure.PAIRING_DISABLED, server.await().failureKind())
        }

        val limiter = PairingRateLimiter()
        for (attempt in 0 until 6) {
            val (tx, rx) = duplex()
            val sc = ServeConfig(id, "PC", emptyList(), allowPairing = true, rateLimiter = limiter)
            val server = async {
                val inc = QuickSend.serve(rx, sc) { true }
                if (inc is Incoming.Pairing) runCatching { inc.pending.confirm(false) }
            }
            val r = runCatching { QuickSend.pairInitiator(tx, peer, "Phone") }
            if (attempt < 5) {
                r.getOrThrow().cancel()
                server.await()
            } else {
                assertEquals(ErrorCode.RATE_LIMITED, r.remoteCode())
                assertEquals(Failure.RATE_LIMITED, server.await().failureKind())
            }
        }
    }

    @Test
    fun rateLimiterIsASlidingWindow() {
        val rl = PairingRateLimiter()
        val second = 1_000_000_000L
        for (i in 0 until 5) assertTrue(rl.tryAcquireAt(i * second), "attempt $i")
        assertTrue(!rl.tryAcquireAt(30 * second))
        assertTrue(!rl.tryAcquireAt(59 * second))
        assertTrue(rl.tryAcquireAt(60 * second))
        assertTrue(!rl.tryAcquireAt(60 * second))
    }
}
