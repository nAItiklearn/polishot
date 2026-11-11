package app.polishot.editor

import java.util.Base64
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bridge end to end without a WebView: both transports feed the same validation, the host only ever sees typed,
 * checked values, results arrive in call order, and a call the user is waiting on is always answered.
 */
class EditorBridgeTest {
    private class RecordingHost : EditorBridge.Host {
        /** One short line per callback, in the order they ran. */
        val events = LinkedBlockingQueue<String>()
        val images = LinkedBlockingQueue<DecodedImage>()
        @Volatile var failCopyText = false

        override fun onReady() { events.add("ready") }
        override fun onRequestOcr(id: String) { events.add("ocr:$id") }
        override fun onSaveImage(image: DecodedImage, filename: String) {
            images.add(image)
            events.add("save:$filename")
        }
        override fun onShareImage(image: DecodedImage) {
            images.add(image)
            events.add("share:${image.mime}")
        }
        override fun onCopyImage(image: DecodedImage) {
            images.add(image)
            events.add("copyImage")
        }
        override fun onCopyText(text: String) {
            if (failCopyText) throw IllegalStateException("clipboard unavailable")
            events.add("copyText:$text")
        }
        override fun onSaveDoc(id: String, docJson: String) { events.add("doc:$id") }
        override fun onQuickSend(image: DecodedImage) {
            images.add(image)
            events.add("send")
        }
        override fun onClose() { events.add("close") }
        override fun onBatchProgress(done: Int, total: Int, failed: Int) { events.add("batch:$done/$total/$failed") }
        override fun onRejected(method: String) { events.add("rejected:$method") }
    }

    private val host = RecordingHost()
    private val bridge = EditorBridge(host)
    private val b64png: String = Base64.getEncoder().encodeToString(TEST_PNG)

    @After
    fun tearDown() = bridge.shutdown()

    private fun next(): String = host.events.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("the host was never called")

    /** The bridge's worker is serial, so once "close" is seen every earlier call has been fully handled. */
    private fun assertNothingBefore(then: String) {
        bridge.onMessage("""{"m":"close"}""")
        assertEquals("an unexpected callback came first", then, next())
    }

    // ---- text transport ---------------------------------------------------------------------------

    @Test
    fun `ready and close reach the host`() {
        bridge.onMessage("""{"m":"ready"}""")
        assertEquals("ready", next())
        bridge.onMessage("""{"m":"close"}""")
        assertEquals("close", next())
    }

    @Test
    fun `an ocr request needs a safe id`() {
        bridge.onMessage("""{"m":"requestOcr","id":"m3k9x2ab-9f31c07e"}""")
        assertEquals("ocr:m3k9x2ab-9f31c07e", next())

        bridge.onMessage("""{"m":"requestOcr","id":"../../etc/passwd"}""")
        bridge.onMessage("""{"m":"requestOcr"}""")
        // Nobody is waiting on an OCR answer for a bad id, so it is dropped quietly.
        assertNothingBefore("close")
    }

    @Test
    fun `a saved image reaches the host with a sanitised name and the exact bytes`() {
        bridge.onMessage("""{"m":"saveImage","base64":"$b64png","mime":"image/png","filename":"../../my shot.html"}""")
        assertEquals("save:my shot.png", next())
        assertArrayEquals(TEST_PNG, host.images.poll()!!.bytes)
    }

    @Test
    fun `a save with the wrong type or content is rejected and reported`() {
        bridge.onMessage("""{"m":"saveImage","base64":"$b64png","mime":"image/gif","filename":"a.png"}""")
        assertEquals("rejected:saveImage", next())
        bridge.onMessage("""{"m":"saveImage","base64":"$b64png","mime":"image/jpeg","filename":"a.jpg"}""")
        assertEquals("rejected:saveImage", next())
        bridge.onMessage("""{"m":"saveImage","base64":"not base64!!","mime":"image/png"}""")
        assertEquals("rejected:saveImage", next())
        bridge.onMessage("""{"m":"saveImage","mime":"image/png"}""")
        assertEquals("rejected:saveImage", next())
    }

    @Test
    fun `share copy and send each check their image`() {
        bridge.onMessage("""{"m":"shareImage","base64":"$b64png","mime":"image/png"}""")
        assertEquals("share:image/png", next())
        bridge.onMessage("""{"m":"copyImage","base64":"$b64png"}""")
        assertEquals("copyImage", next())
        bridge.onMessage("""{"m":"quickSend","base64":"$b64png"}""")
        assertEquals("send", next())

        val jpeg = Base64.getEncoder().encodeToString(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 0, 0))
        bridge.onMessage("""{"m":"copyImage","base64":"$jpeg"}""")
        assertEquals("copy and send carry PNG only", "rejected:copyImage", next())
        bridge.onMessage("""{"m":"quickSend","base64":"$jpeg"}""")
        assertEquals("rejected:quickSend", next())
    }

    @Test
    fun `copied text is bounded and blank text is reported`() {
        bridge.onMessage("""{"m":"copyText","text":"hello"}""")
        assertEquals("copyText:hello", next())
        bridge.onMessage("""{"m":"copyText","text":"   "}""")
        assertEquals("rejected:copyText", next())
        bridge.onMessage("""{"m":"copyText"}""")
        assertEquals("rejected:copyText", next())
    }

    @Test
    fun `an invalid document is dropped without bothering the user`() {
        val doc = """{\"version\":1,\"image\":{\"id\":\"abc-1\"}}"""
        bridge.onMessage("""{"m":"saveDoc","id":"abc-1","doc":"$doc"}""")
        assertEquals("doc:abc-1", next())

        bridge.onMessage("""{"m":"saveDoc","id":"other","doc":"$doc"}""") // for a different capture
        bridge.onMessage("""{"m":"saveDoc","id":"abc-1","doc":"nope"}""")
        assertNothingBefore("close")
    }

    @Test
    fun `batch progress must be sane`() {
        bridge.onMessage("""{"m":"batchProgress","done":2,"total":5,"failed":1}""")
        assertEquals("batch:2/5/1", next())

        bridge.onMessage("""{"m":"batchProgress","done":6,"total":5,"failed":0}""")
        bridge.onMessage("""{"m":"batchProgress","done":0,"total":0,"failed":0}""")
        bridge.onMessage("""{"m":"batchProgress","done":0,"total":${EditorBridge.MAX_BATCH + 1},"failed":0}""")
        bridge.onMessage("""{"m":"batchProgress"}""")
        assertNothingBefore("close")
    }

    @Test
    fun `a malformed message is reported instead of ignored`() {
        bridge.onMessage("this is not json")
        assertEquals("rejected:message", next())
        bridge.onMessage("""{"m":"launchMissiles"}""")
        assertEquals("rejected:message", next())
    }

    // ---- binary transport -------------------------------------------------------------------------

    @Test
    fun `a binary save skips base64 and keeps the bytes`() {
        bridge.onBinary(binaryFrame("""{"m":"saveImage","mime":"image/png","filename":"b.png"}""", TEST_PNG))
        assertEquals("save:b.png", next())
        assertArrayEquals(TEST_PNG, host.images.poll()!!.bytes)
    }

    @Test
    fun `binary share copy and send work and are checked`() {
        bridge.onBinary(binaryFrame("""{"m":"shareImage","mime":"image/png"}""", TEST_PNG))
        assertEquals("share:image/png", next())
        bridge.onBinary(binaryFrame("""{"m":"copyImage"}""", TEST_PNG))
        assertEquals("copyImage", next())
        bridge.onBinary(binaryFrame("""{"m":"quickSend"}""", TEST_PNG))
        assertEquals("send", next())
        bridge.onBinary(binaryFrame("""{"m":"quickSend"}""", "<html>".toByteArray()))
        assertEquals("rejected:quickSend", next())
    }

    @Test
    fun `an oversized binary image is rejected`() {
        val body = TEST_PNG.copyOf(BridgeValidation.MAX_IMAGE_BYTES + 1)
        bridge.onBinary(binaryFrame("""{"m":"saveImage","mime":"image/png","filename":"big.png"}""", body))
        assertEquals("rejected:saveImage", next())
        assertNull(host.images.poll())
    }

    @Test
    fun `a malformed binary message is reported`() {
        bridge.onBinary(byteArrayOf(1, 2))
        assertEquals("rejected:binary", next())
        bridge.onBinary(binaryFrame("""{"m":"ready"}""", TEST_PNG))
        assertEquals("rejected:binary", next())
    }

    // ---- behaviour that holds for both ------------------------------------------------------------

    @Test
    fun `calls are handled in the order they were made`() {
        for (i in 1..40) bridge.onMessage("""{"m":"batchProgress","done":$i,"total":40,"failed":0}""")
        for (i in 1..40) assertEquals("batch:$i/40/0", next())
    }

    @Test
    fun `a host that throws is reported to the page and the bridge keeps working`() {
        host.failCopyText = true
        bridge.onMessage("""{"m":"copyText","text":"hi"}""")
        assertEquals("rejected:message", next()) // the message transport reports under its own name
        bridge.copyText("hi")
        assertEquals("rejected:copyText", next())

        host.failCopyText = false
        bridge.onMessage("""{"m":"copyText","text":"again"}""")
        assertEquals("copyText:again", next())
    }

    @Test
    fun `calls after shutdown are ignored without an error`() {
        bridge.onMessage("""{"m":"ready"}""")
        bridge.shutdown()
        assertEquals("a call queued before shutdown still finishes", "ready", next())

        bridge.onMessage("""{"m":"ready"}""")
        bridge.onBinary(binaryFrame("""{"m":"copyImage"}""", TEST_PNG))
        bridge.ready()
        assertNull(host.events.poll(300, TimeUnit.MILLISECONDS))
    }

    // ---- JavaScript interface fallback ------------------------------------------------------------

    @Test
    fun `the fallback interface goes through the same checks`() {
        bridge.ready()
        assertEquals("ready", next())

        bridge.requestOcr("m3k9x2ab-9f31c07e")
        assertEquals("ocr:m3k9x2ab-9f31c07e", next())

        bridge.saveImage(b64png, "image/png", "../x.png")
        assertEquals("save:x.png", next())
        assertArrayEquals(TEST_PNG, host.images.poll()!!.bytes)

        bridge.saveImage(b64png, "text/html", "x.html")
        assertEquals("rejected:saveImage", next())

        bridge.shareImage(b64png, "image/png")
        assertEquals("share:image/png", next())
        bridge.copyImage(b64png)
        assertEquals("copyImage", next())
        bridge.copyText("text")
        assertEquals("copyText:text", next())
        bridge.quickSend(b64png)
        assertEquals("send", next())
        bridge.batchProgress(1, 2, 0)
        assertEquals("batch:1/2/0", next())
        bridge.close()
        assertEquals("close", next())
    }

    @Test
    fun `the fallback interface tolerates nulls`() {
        bridge.saveImage(null, null, null)
        assertEquals("rejected:saveImage", next())
        bridge.copyText(null)
        assertEquals("rejected:copyText", next())
        bridge.saveDoc(null, null)
        bridge.requestOcr(null)
        assertNothingBefore("close")
    }

    @Test
    fun `both transports produce the same sanitised result`() {
        bridge.saveImage(b64png, "image/png", "Name: <x>.png")
        val viaInterface = next()
        bridge.onMessage("""{"m":"saveImage","base64":"$b64png","mime":"image/png","filename":"Name: <x>.png"}""")
        val viaMessage = next()
        bridge.onBinary(binaryFrame("""{"m":"saveImage","mime":"image/png","filename":"Name: <x>.png"}""", TEST_PNG))
        val viaBinary = next()
        assertEquals(viaInterface, viaMessage)
        assertEquals(viaInterface, viaBinary)
        assertTrue(viaInterface.startsWith("save:"))
    }
}
