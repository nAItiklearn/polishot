package app.polishot.quicksend

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class ContentTest {

    @Test
    fun mimeAllowlistAndMagicBytes() {
        assertTrue(Content.isAllowedMime("image/png"))
        assertFalse(Content.isAllowedMime("image/gif"))
        assertFalse(Content.isAllowedMime("IMAGE/PNG"))
        assertTrue(Content.checkMagic("image/png", unhex("89504e470d0a1a0a00")))
        assertFalse(Content.checkMagic("image/png", "GIF89a".toByteArray()))
        assertTrue(Content.checkMagic("image/jpeg", unhex("ffd8ffe0")))
        assertFalse(Content.checkMagic("image/jpeg", unhex("ffd8")))
        assertTrue(Content.checkMagic("image/webp", "RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray(Charsets.ISO_8859_1)))
        assertFalse(Content.checkMagic("image/webp", "RIFF\u0000\u0000\u0000\u0000WAVEfmt ".toByteArray(Charsets.ISO_8859_1)))
        assertFalse(Content.checkMagic("image/webp", "RIFF".toByteArray()))
        assertFalse(Content.checkMagic("text/plain", "hello".toByteArray()))
    }

    @Test
    fun deviceNames() {
        Content.validateDeviceName("Pixel 9")
        Content.validateDeviceName("a".repeat(32))
        val emoji = "\uD83D\uDE00" // one code point, two UTF-16 units
        Content.validateDeviceName(emoji.repeat(32))
        for (bad in listOf("", "a".repeat(33), "bad\nname", "rtl\u202Ename", emoji.repeat(33), "lone\uD800surrogate")) {
            assertThrows<QuickSendException> { Content.validateDeviceName(bad) }
        }
        assertEquals("Pixel 9", Content.cleanDeviceName("  \u202EPixel\n 9  "))
        assertEquals("Device", Content.cleanDeviceName("\n\n"))
        assertEquals(32, Content.codePoints(Content.cleanDeviceName("\u00E9".repeat(40))).size)
    }

    @Test
    fun fileNames() {
        assertEquals("shot.png", Content.sanitizeFileName("shot.png"))
        assertEquals("_.._etc_passwd", Content.sanitizeFileName("../../etc/passwd"))
        assertEquals("a_b_c_.png", Content.sanitizeFileName("a:b*c?.png"))
        assertEquals("image", Content.sanitizeFileName("  ...  "))
        assertEquals("_con.png", Content.sanitizeFileName("con.png"))
        assertEquals("_NUL", Content.sanitizeFileName("NUL"))
        assertEquals("COM10.png", Content.sanitizeFileName("COM10.png"))
        val long = "\u00E4".repeat(100) + ".png"
        val s = Content.sanitizeFileName(long)
        assertTrue(s.toByteArray(Charsets.UTF_8).size <= Protocol.MAX_FILE_NAME_BYTES)
        Content.validateWireFileName(s)
        for (raw in listOf("x/y", "con", "..a..", long, "\u202Eevil.png")) {
            val once = Content.sanitizeFileName(raw)
            assertEquals(once, Content.sanitizeFileName(once), "idempotent for $raw")
            Content.validateWireFileName(once)
        }
    }

    @Test
    fun deviceIdParsingAndOrdering() {
        val id = DeviceId.fromBytes("foobarbazq".toByteArray())
        assertEquals("MZXW6YTBOJRGC6TR", id.toString())
        assertEquals(id, DeviceId.parse("mzxw6ytbojrgc6tr"))
        assertThrows<QuickSendException> { DeviceId.parse("MZXW6YTBMJQXUZ3") }
        assertThrows<QuickSendException> { DeviceId.parse("MZXW6YTBMJQXUZ31") }
        val low = DeviceId.fromBytes(ByteArray(10) { 0x01 })
        val high = DeviceId.fromBytes(ByteArray(10) { 0xF0.toByte() })
        assertTrue(low < high, "ordering is unsigned")
        assertEquals(0, low.compareTo(DeviceId.fromBytes(ByteArray(10) { 0x01 })))
    }

    @Test
    fun identityRoundTrip() {
        val a = Identity.generate()
        val b = Identity.fromBytes(a.toBytes())
        assertArrayEquals(a.publicKey, b.publicKey)
        assertEquals(a.id, b.id)
        assertEquals(DeviceId.fromPublic(a.publicKey), a.id)
        assertEquals(65, a.publicKey.size)
        assertEquals(0x04, a.publicKey[0].toInt())
        assertThrows<QuickSendException> { Identity.fromBytes(ByteArray(97)) }
        assertThrows<QuickSendException> { Identity.fromBytes(ByteArray(31)) }
    }

    @Test
    fun ecdhAgreesBetweenGeneratedKeys() {
        val a = Crypto.generateKeyPair()
        val b = Crypto.generateKeyPair()
        assertArrayEquals(a.ecdh(b.publicBytes), b.ecdh(a.publicBytes))
        assertNotEquals(hex(a.publicBytes), hex(b.publicBytes))
    }

    @Test
    fun pairRecordRoundTripAndRejection() {
        val peer = Identity.generate()
        val rec = PairRecord(peer.publicKey, ByteArray(32) { 9 }, "Pixel 9")
        val back = PairRecord.fromBytes(rec.toBytes())
        assertEquals(peer.id, back.peerId)
        assertArrayEquals(ByteArray(32) { 9 }, back.pairKey)
        assertEquals("Pixel 9", back.peerName)
        assertThrows<QuickSendException> { PairRecord.fromBytes(rec.toBytes() + byteArrayOf(0)) }
        assertThrows<QuickSendException> { PairRecord.fromBytes(rec.toBytes().copyOf(10)) }
        assertThrows<QuickSendException> { PairRecord(peer.publicKey, ByteArray(31), "x") }
        assertThrows<QuickSendException> { PairRecord(ByteArray(65), ByteArray(32), "x") }
        assertFalse(rec.toString().contains("pairKey"))
    }

    @Test
    fun discoveryRecords() {
        val id = DeviceId.fromBytes(ByteArray(10) { 7 })
        val txt = Discovery.txtAttributes(id, "Studio PC")
        assertEquals("1", txt["v"])
        assertEquals(id.toString(), txt["id"])
        val ad = Discovery.parseTxt { txt[it] }
        assertEquals(id, ad.id)
        assertEquals("Studio PC", ad.name)
        assertEquals(1, ad.version)
        assertEquals(id.toString(), Discovery.instanceName(id))
        assertEquals(id, Discovery.idFromInstanceName("${id}._polishot._tcp.local."))
        assertEquals(null, Discovery.idFromInstanceName("not-an-id._polishot._tcp.local."))

        val bytes: Map<String, ByteArray?> = txt.mapValues { it.value.toByteArray() }
        assertEquals(id, Discovery.parseTxtBytes(bytes).id)

        assertThrows<QuickSendException> { Discovery.txtAttributes(id, "x".repeat(33)) }
        val bad = listOf(
            mapOf("id" to id.toString(), "name" to "A"),
            mapOf("v" to "x", "id" to id.toString(), "name" to "A"),
            mapOf("v" to "1", "id" to "short", "name" to "A"),
            mapOf("v" to "1", "id" to id.toString(), "name" to ""),
            mapOf("v" to "1", "id" to id.toString(), "name" to "A\u202EB"),
        )
        for (m in bad) assertThrows<QuickSendException> { Discovery.parseTxt { m[it] } }
    }
}
