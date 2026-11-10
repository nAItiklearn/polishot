package app.polishot.quicksend

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/**
 * Replays the byte-for-byte wire traces recorded from the Rust implementation through the Kotlin state
 * machines: the Kotlin side must write exactly the bytes Rust wrote, and accept exactly what Rust sent.
 */
class WireReplayTest {

    private fun framesOf(obj: org.json.JSONObject, key: String): ByteArray =
        concat(obj.getJSONArray(key).strings().map { unhex(it) })

    private fun transportFor(incoming: ByteArray, out: ByteArrayOutputStream): Transport =
        Transport(ByteArrayInputStream(incoming), out)

    @Test
    fun kotlinInitiatorAgainstRecordedRustResponder() {
        val v = Vectors.pairing
        val out = ByteArrayOutputStream()
        val pending = pairInitiatorImpl(
            transportFor(framesOf(v, "wire_responder"), out),
            Vectors.identity("a"),
            v.getString("initiator_name"),
            Config(),
            Vectors.key(v.getJSONObject("ephemeral_initiator")),
        )
        assertEquals(v.getString("sas"), pending.sas)
        assertEquals(v.getString("responder_name"), pending.peerName)
        assertEquals(Vectors.identity("b").id, pending.peerId)
        val record = pending.confirm(true)
        assertArrayEquals(framesOf(v, "wire_initiator"), out.toByteArray())
        assertEquals(v.getString("pair_key"), hex(record.pairKey))
        assertEquals(v.getString("record_initiator_has_responder"), hex(record.toBytes()))
    }

    @Test
    fun kotlinResponderAgainstRecordedRustInitiator() {
        val v = Vectors.pairing
        val out = ByteArrayOutputStream()
        val pending = pairResponderImpl(
            transportFor(framesOf(v, "wire_initiator"), out),
            Vectors.identity("b"),
            v.getString("responder_name"),
            null,
            Config(),
            Vectors.key(v.getJSONObject("ephemeral_responder")),
        )
        assertEquals(v.getString("sas"), pending.sas)
        assertEquals(v.getString("initiator_name"), pending.peerName)
        val record = pending.confirm(true)
        assertArrayEquals(framesOf(v, "wire_responder"), out.toByteArray())
        assertEquals(v.getString("pair_key"), hex(record.pairKey))
        assertEquals(v.getString("record_responder_has_initiator"), hex(record.toBytes()))
    }

    @Test
    fun kotlinSenderAgainstRecordedRustReceiver() {
        val t = Vectors.transfer
        val file = t.getJSONObject("file")
        val out = ByteArrayOutputStream()
        sendFileImpl(
            transportFor(framesOf(t, "wire_receiver"), out),
            Vectors.identity("a"),
            PairRecord.fromBytes(unhex(Vectors.pairing.getString("record_initiator_has_responder"))),
            FileMeta(file.getString("name"), file.getString("mime")),
            unhex(file.getString("data")),
            Config(),
            null,
            Vectors.key(t.getJSONObject("ephemeral_sender")),
        )
        assertArrayEquals(framesOf(t, "wire_sender"), out.toByteArray())
    }

    @Test
    fun kotlinReceiverAgainstRecordedRustSender() {
        val t = Vectors.transfer
        val file = t.getJSONObject("file")
        val out = ByteArrayOutputStream()
        var offered: OfferInfo? = null
        val received = receiveImpl(
            transportFor(framesOf(t, "wire_sender"), out),
            Vectors.identity("b"),
            listOf(PairRecord.fromBytes(unhex(Vectors.pairing.getString("record_responder_has_initiator")))),
            Config(),
            { offer ->
                offered = offer
                true
            },
            null,
            Vectors.key(t.getJSONObject("ephemeral_receiver")),
        )
        assertArrayEquals(framesOf(t, "wire_receiver"), out.toByteArray())
        assertArrayEquals(unhex(file.getString("data")), received.data)
        assertEquals(file.getString("sha256"), hex(received.sha256))
        assertEquals(file.getString("name"), received.name)
        assertEquals(file.getString("mime"), received.mime)
        assertEquals(Vectors.identity("a").id, received.peerId)
        val seen = offered ?: error("the accept callback was not called")
        assertEquals(unhex(file.getString("data")).size.toLong(), seen.size)
        assertEquals("Studio PC", seen.peerName)
    }
}
