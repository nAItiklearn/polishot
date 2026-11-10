package app.polishot.editor

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeValidationTest {
    private val now = 1_700_000_000_000L // 2023-11-14T22:13:20Z

    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0)
    private val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 0, 0)
    private val webp = "RIFF".toByteArray() + byteArrayOf(0, 0, 0, 0) + "WEBP".toByteArray()

    private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

    // ---- MIME -----------------------------------------------------------------------------------

    @Test
    fun `mime allowlist accepts the three image types and normalises case`() {
        assertEquals("image/png", BridgeValidation.normalizeMime("image/png"))
        assertEquals("image/jpeg", BridgeValidation.normalizeMime(" IMAGE/JPEG "))
        assertEquals("image/webp", BridgeValidation.normalizeMime("image/webp"))
    }

    @Test
    fun `mime allowlist rejects everything else`() {
        for (bad in listOf("image/gif", "image/svg+xml", "text/html", "application/octet-stream", "", "image/png; x=1", null)) {
            assertNull("should reject $bad", BridgeValidation.normalizeMime(bad))
        }
    }

    // ---- images ---------------------------------------------------------------------------------

    @Test
    fun `valid images of each type are decoded`() {
        for ((bytes, mime) in listOf(png to "image/png", jpeg to "image/jpeg", webp to "image/webp")) {
            val check = BridgeValidation.decodeImage(b64(bytes), mime)
            assertTrue("expected Ok for $mime but got $check", check is ImageCheck.Ok)
            val image = (check as ImageCheck.Ok).image
            assertEquals(mime, image.mime)
            assertTrue(bytes.contentEquals(image.bytes))
        }
    }

    @Test
    fun `mime may be omitted and is then detected from the signature`() {
        val check = BridgeValidation.decodeImage(b64(png), null)
        assertEquals("image/png", (check as ImageCheck.Ok).image.mime)
    }

    @Test
    fun `claimed type must match the content`() {
        assertTrue(BridgeValidation.decodeImage(b64(png), "image/jpeg") is ImageCheck.Rejected)
        assertTrue(BridgeValidation.decodeImage(b64(jpeg), "image/png") is ImageCheck.Rejected)
    }

    @Test
    fun `content that is not a supported image is rejected even with a good mime`() {
        val html = "<html><script>alert(1)</script></html>".toByteArray()
        assertTrue(BridgeValidation.decodeImage(b64(html), "image/png") is ImageCheck.Rejected)
        assertTrue(BridgeValidation.decodeImage(b64("GIF89a".toByteArray()), "image/png") is ImageCheck.Rejected)
    }

    @Test
    fun `malformed or empty base64 is rejected`() {
        assertTrue(BridgeValidation.decodeImage("!!!not base64!!!", "image/png") is ImageCheck.Rejected)
        assertTrue(BridgeValidation.decodeImage("", "image/png") is ImageCheck.Rejected)
        assertTrue(BridgeValidation.decodeImage(null, "image/png") is ImageCheck.Rejected)
        assertTrue(BridgeValidation.decodeImage("a", "image/png") is ImageCheck.Rejected) // impossible length
    }

    @Test
    fun `an image over the size cap is rejected before decoding`() {
        val huge = "A".repeat(BridgeValidation.MAX_BASE64_CHARS + 1)
        val check = BridgeValidation.decodeImage(huge, "image/png")
        assertTrue(check is ImageCheck.Rejected)
        assertEquals("image too large", (check as ImageCheck.Rejected).reason)
    }

    // ---- file names -----------------------------------------------------------------------------

    @Test
    fun `plain names keep their stem and get the extension of the mime type`() {
        assertEquals("shot-1.png", BridgeValidation.sanitizeFilename("shot-1.png", "image/png", now))
        assertEquals("my photo.jpg", BridgeValidation.sanitizeFilename("my photo.webp", "image/jpeg", now))
        assertEquals("a.webp", BridgeValidation.sanitizeFilename("a", "image/webp", now))
    }

    @Test
    fun `path separators and traversal never survive`() {
        assertEquals("passwd.png", BridgeValidation.sanitizeFilename("../../etc/passwd", "image/png", now))
        assertEquals("evil.png", BridgeValidation.sanitizeFilename("C:\\Windows\\evil.exe", "image/png", now))
        assertEquals("x.png", BridgeValidation.sanitizeFilename("/sdcard/Download/x.png", "image/png", now))
    }

    @Test
    fun `dangerous characters and control codes are replaced`() {
        val cleaned = BridgeValidation.sanitizeFilename("na<me>:\"|?*\u0000\n.png", "image/png", now)
        assertEquals("na_me.png", cleaned)
        assertTrue(cleaned.none { it.code < 0x20 || it in "<>:\"|?*\\/" })
    }

    @Test
    fun `the extension always follows the mime type, not the requested name`() {
        assertEquals("page.png", BridgeValidation.sanitizeFilename("page.html", "image/png", now))
        assertEquals("page_png.jpg", BridgeValidation.sanitizeFilename("page.png.exe", "image/jpeg", now))
    }

    @Test
    fun `empty or hostile names fall back to a timestamped default`() {
        assertEquals("polishot-20231114-221320.png", BridgeValidation.sanitizeFilename(null, "image/png", now))
        assertEquals("polishot-20231114-221320.png", BridgeValidation.sanitizeFilename("", "image/png", now))
        assertEquals("polishot-20231114-221320.jpg", BridgeValidation.sanitizeFilename("....", "image/jpeg", now))
        assertEquals("polishot-20231114-221320.png", BridgeValidation.sanitizeFilename("///", "image/png", now))
        assertEquals("polishot-20231114-221320.png", BridgeValidation.sanitizeFilename("\u30b9\u30af\u30ea\u30fc\u30f3.png", "image/png", now))
    }

    @Test
    fun `long names are truncated`() {
        val name = BridgeValidation.sanitizeFilename("a".repeat(500) + ".png", "image/png", now)
        assertEquals(BridgeValidation.MAX_FILENAME_STEM + ".png".length, name.length)
    }

    // ---- text and documents ---------------------------------------------------------------------

    @Test
    fun `clipboard text is bounded and blank text is dropped`() {
        assertNull(BridgeValidation.sanitizeText(null))
        assertNull(BridgeValidation.sanitizeText("   \n"))
        assertEquals("hello", BridgeValidation.sanitizeText("hello"))
        val long = "x".repeat(BridgeValidation.MAX_TEXT_CHARS + 50)
        assertEquals(BridgeValidation.MAX_TEXT_CHARS, BridgeValidation.sanitizeText(long)?.length)
    }

    @Test
    fun `a document must be version 1 JSON for the same capture`() {
        val doc = """{"version":1,"image":{"id":"abc-123","width":10,"height":10},"annotations":[]}"""
        assertEquals(doc, BridgeValidation.validateDocJson("abc-123", doc))
        assertNull(BridgeValidation.validateDocJson("other-id", doc))
        assertNull(BridgeValidation.validateDocJson("abc-123", """{"version":2,"image":{"id":"abc-123"}}"""))
        assertNull(BridgeValidation.validateDocJson("abc-123", "not json"))
        assertNull(BridgeValidation.validateDocJson("abc-123", "[]"))
        assertNull(BridgeValidation.validateDocJson("../bad", doc))
        assertNull(BridgeValidation.validateDocJson("abc-123", ""))
        assertNull(BridgeValidation.validateDocJson("abc-123", "x".repeat(BridgeValidation.MAX_DOC_JSON_CHARS + 1)))
    }

    @Test
    fun `detectMime returns null for short or unknown input`() {
        assertNull(BridgeValidation.detectMime(byteArrayOf()))
        assertNull(BridgeValidation.detectMime(byteArrayOf(1, 2, 3)))
        assertNotNull(BridgeValidation.detectMime(png))
    }
}
