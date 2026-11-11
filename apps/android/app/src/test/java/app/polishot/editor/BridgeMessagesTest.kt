package app.polishot.editor

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A minimal PNG-looking payload: the signature is all the bridge checks before the platform decodes it. */
internal val TEST_PNG: ByteArray = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4)

/** `u32 big-endian header length | header | body`, the binary message layout (see [BridgeMessages]). */
internal fun binaryFrame(header: String, body: ByteArray): ByteArray {
    val h = header.toByteArray(Charsets.UTF_8)
    val out = ByteArray(4 + h.size + body.size)
    out[0] = (h.size ushr 24).toByte()
    out[1] = (h.size ushr 16).toByte()
    out[2] = (h.size ushr 8).toByte()
    out[3] = h.size.toByte()
    h.copyInto(out, 4)
    body.copyInto(out, 4 + h.size)
    return out
}

/** The wire format between the page and the app, tested without a WebView. */
class BridgeMessagesTest {
    private val b64png: String = java.util.Base64.getEncoder().encodeToString(TEST_PNG)

    private fun imageBytesOf(payload: ImagePayload, mime: String? = null): ByteArray =
        (payload.check(mime) as ImageCheck.Ok).image.bytes

    // ---- text messages ----------------------------------------------------------------------------

    @Test
    fun `argument free calls map to their message`() {
        assertEquals(BridgeMessage.Ready, BridgeMessages.parse("""{"m":"ready"}"""))
        assertEquals(BridgeMessage.Close, BridgeMessages.parse("""{"m":"close"}"""))
    }

    @Test
    fun `requestOcr carries its id and tolerates a missing one`() {
        assertEquals(BridgeMessage.RequestOcr("abc-1"), BridgeMessages.parse("""{"m":"requestOcr","id":"abc-1"}"""))
        assertEquals(BridgeMessage.RequestOcr(null), BridgeMessages.parse("""{"m":"requestOcr"}"""))
        assertEquals(BridgeMessage.RequestOcr(null), BridgeMessages.parse("""{"m":"requestOcr","id":null}"""))
    }

    @Test
    fun `saveImage keeps its arguments and its base64 payload`() {
        val json = """{"m":"saveImage","base64":"$b64png","mime":"image/png","filename":"shot.png"}"""
        val message = BridgeMessages.parse(json) as BridgeMessage.SaveImage
        assertEquals("image/png", message.mime)
        assertEquals("shot.png", message.filename)
        assertTrue(message.image is ImagePayload.Base64)
        assertArrayEquals(TEST_PNG, imageBytesOf(message.image, "image/png"))
    }

    @Test
    fun `an image message without base64 is still a message and is rejected when checked`() {
        val message = BridgeMessages.parse("""{"m":"copyImage"}""") as BridgeMessage.CopyImage
        assertTrue(message.image.check("image/png") is ImageCheck.Rejected)
    }

    @Test
    fun `share copy and send carry a base64 payload`() {
        val share = BridgeMessages.parse("""{"m":"shareImage","base64":"$b64png","mime":"image/png"}""") as BridgeMessage.ShareImage
        assertEquals("image/png", share.mime)
        assertArrayEquals(TEST_PNG, imageBytesOf(share.image))
        val copy = BridgeMessages.parse("""{"m":"copyImage","base64":"$b64png"}""") as BridgeMessage.CopyImage
        assertArrayEquals(TEST_PNG, imageBytesOf(copy.image))
        val send = BridgeMessages.parse("""{"m":"quickSend","base64":"$b64png"}""") as BridgeMessage.QuickSend
        assertArrayEquals(TEST_PNG, imageBytesOf(send.image))
    }

    @Test
    fun `text and document messages keep their strings`() {
        assertEquals(BridgeMessage.CopyText("hello \"world\""), BridgeMessages.parse("""{"m":"copyText","text":"hello \"world\""}"""))
        assertEquals(BridgeMessage.CopyText(null), BridgeMessages.parse("""{"m":"copyText"}"""))
        val doc = """{"version":1}"""
        val escaped = doc.replace("\"", "\\\"")
        assertEquals(BridgeMessage.SaveDoc("id1", doc), BridgeMessages.parse("""{"m":"saveDoc","id":"id1","doc":"$escaped"}"""))
    }

    @Test
    fun `batch progress carries its counts and uses -1 for a missing one`() {
        assertEquals(
            BridgeMessage.BatchProgress(3, 10, 1),
            BridgeMessages.parse("""{"m":"batchProgress","done":3,"total":10,"failed":1}"""),
        )
        assertEquals(BridgeMessage.BatchProgress(-1, -1, -1), BridgeMessages.parse("""{"m":"batchProgress"}"""))
    }

    @Test
    fun `unknown methods and non message text are refused`() {
        for (bad in listOf("", "null", "[]", "not json", "{", """{"m":"launchMissiles"}""", """{"m":""}""", """{"x":1}""", """{"m":5}""")) {
            assertNull("should refuse: $bad", BridgeMessages.parse(bad))
        }
    }

    @Test
    fun `a message over the size cap is refused without parsing it`() {
        assertNull(BridgeMessages.parse("x".repeat(BridgeMessages.MAX_MESSAGE_CHARS + 1)))
    }

    @Test
    fun `the message cap leaves room for a maximum base64 image`() {
        assertTrue(BridgeMessages.MAX_MESSAGE_CHARS > BridgeValidation.MAX_BASE64_CHARS)
    }

    // ---- binary messages --------------------------------------------------------------------------

    @Test
    fun `a binary save carries the header fields and the exact image bytes`() {
        val frame = binaryFrame("""{"m":"saveImage","mime":"image/png","filename":"a b.png"}""", TEST_PNG)
        val message = BridgeMessages.parseBinary(frame) as BridgeMessage.SaveImage
        assertEquals("image/png", message.mime)
        assertEquals("a b.png", message.filename)
        assertTrue(message.image is ImagePayload.Bytes)
        assertArrayEquals(TEST_PNG, imageBytesOf(message.image, "image/png"))
    }

    @Test
    fun `binary share copy and send are understood`() {
        val share = BridgeMessages.parseBinary(binaryFrame("""{"m":"shareImage","mime":"image/png"}""", TEST_PNG))
        assertTrue(share is BridgeMessage.ShareImage)
        assertTrue(BridgeMessages.parseBinary(binaryFrame("""{"m":"copyImage"}""", TEST_PNG)) is BridgeMessage.CopyImage)
        assertTrue(BridgeMessages.parseBinary(binaryFrame("""{"m":"quickSend"}""", TEST_PNG)) is BridgeMessage.QuickSend)
    }

    @Test
    fun `a header with non ASCII text is measured in bytes`() {
        val name = "été ス.png" // two-byte and three-byte UTF-8 characters
        val frame = binaryFrame("{\"m\":\"saveImage\",\"mime\":\"image/png\",\"filename\":\"$name\"}", TEST_PNG)
        val message = BridgeMessages.parseBinary(frame) as BridgeMessage.SaveImage
        assertEquals(name, message.filename)
        assertArrayEquals(TEST_PNG, imageBytesOf(message.image))
    }

    @Test
    fun `only image calls may arrive as binary`() {
        for (method in listOf("ready", "close", "copyText", "saveDoc", "requestOcr", "batchProgress", "nope")) {
            assertNull("binary $method", BridgeMessages.parseBinary(binaryFrame("""{"m":"$method"}""", TEST_PNG)))
        }
    }

    @Test
    fun `a binary message with a bad frame is refused`() {
        val good = binaryFrame("""{"m":"copyImage"}""", TEST_PNG)

        assertNull("empty", BridgeMessages.parseBinary(ByteArray(0)))
        assertNull("shorter than the length field", BridgeMessages.parseBinary(byteArrayOf(0, 0, 1)))
        assertNull("zero length header", BridgeMessages.parseBinary(byteArrayOf(0, 0, 0, 0, 1, 2, 3)))

        val huge = good.copyOf()
        huge[0] = 0x7F // header length of about two billion
        assertNull("header longer than the buffer", BridgeMessages.parseBinary(huge))

        val negative = good.copyOf()
        negative[0] = 0x80.toByte() // top bit set: would be negative as a signed int
        assertNull("negative header length", BridgeMessages.parseBinary(negative))

        val bigHeader = binaryFrame("""{"m":"copyImage","pad":"${"x".repeat(BridgeMessages.MAX_HEADER_BYTES)}"}""", TEST_PNG)
        assertNull("header over the cap", BridgeMessages.parseBinary(bigHeader))

        val noBody = binaryFrame("""{"m":"copyImage"}""", ByteArray(0))
        assertNull("header but no image bytes", BridgeMessages.parseBinary(noBody))

        assertNull("header is not JSON", BridgeMessages.parseBinary(binaryFrame("not json at all", TEST_PNG)))
        assertNull("header is not an object", BridgeMessages.parseBinary(binaryFrame("[1,2,3]", TEST_PNG)))
    }

    @Test
    fun `the image after the header is checked like any other`() {
        val message = BridgeMessages.parseBinary(binaryFrame("""{"m":"copyImage"}""", "<html></html>".toByteArray())) as BridgeMessage.CopyImage
        assertTrue(message.image.check("image/png") is ImageCheck.Rejected)
    }

    @Test
    fun `the calls a user waits on are the ones that report rejection`() {
        val waiting = EditorBridge.USER_WAITING_METHODS
        assertEquals(setOf("saveImage", "shareImage", "copyImage", "copyText", "quickSend"), waiting)
    }
}
