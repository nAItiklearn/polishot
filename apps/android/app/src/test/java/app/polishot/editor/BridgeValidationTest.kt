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

    // ---- the streaming base64 decoder -------------------------------------------------------------

    @Test
    fun `decodedSize predicts the byte count and refuses impossible shapes`() {
        assertEquals(0, BridgeValidation.decodedSize(""))
        assertEquals(1, BridgeValidation.decodedSize("QQ=="))
        assertEquals(1, BridgeValidation.decodedSize("QQ"))
        assertEquals(2, BridgeValidation.decodedSize("QUI="))
        assertEquals(2, BridgeValidation.decodedSize("QUI"))
        assertEquals(3, BridgeValidation.decodedSize("QUJD"))
        assertEquals(6, BridgeValidation.decodedSize("QUJDREVG"))
        assertEquals("one leftover character cannot be a byte", -1, BridgeValidation.decodedSize("Q"))
        assertEquals(-1, BridgeValidation.decodedSize("QUJDR"))
        assertEquals("padding that does not complete a quantum", -1, BridgeValidation.decodedSize("QQ="))
    }

    @Test
    fun `every length decodes to exactly the original bytes with or without padding`() {
        val random = java.util.Random(42)
        for (extra in 0..70) {
            val payload = png + ByteArray(extra).also { random.nextBytes(it) }
            val padded = b64(payload)
            for (text in listOf(padded, padded.trimEnd('='))) {
                val check = BridgeValidation.decodeImage(text, "image/png")
                assertTrue("extra=$extra text=$text -> $check", check is ImageCheck.Ok)
                assertTrue("extra=$extra", payload.contentEquals((check as ImageCheck.Ok).image.bytes))
            }
        }
    }

    @Test
    fun `a large image decodes correctly`() {
        val payload = png + ByteArray(6 * 1024 * 1024).also { java.util.Random(7).nextBytes(it) }
        val check = BridgeValidation.decodeImage(b64(payload), "image/png")
        assertTrue(check is ImageCheck.Ok)
        assertTrue(payload.contentEquals((check as ImageCheck.Ok).image.bytes))
    }

    @Test
    fun `text that is not plain base64 is rejected whatever its length`() {
        val good = b64(png)
        val bad = listOf(
            good.substring(0, 8) + "\n" + good.substring(8), // the basic decoder takes no line breaks
            good.substring(0, 8) + " " + good.substring(8),
            good.substring(0, 4) + "-" + good.substring(5), // URL-safe alphabet
            good.substring(0, 4) + "é" + good.substring(5), // non-ASCII
            good.substring(0, 4) + "\u0000" + good.substring(5),
            "QQ==QQ==", // padding in the middle
            "====",
            "data:image/png;base64,$good",
        )
        for (text in bad) {
            assertTrue("should reject: $text", BridgeValidation.decodeImage(text, "image/png") is ImageCheck.Rejected)
        }
    }

    // ---- byte limits ------------------------------------------------------------------------------

    @Test
    fun `binary images are checked for size signature and claimed type`() {
        assertTrue(BridgeValidation.checkImageBytes(png, "image/png") is ImageCheck.Ok)
        assertTrue("type may be omitted", BridgeValidation.checkImageBytes(jpeg, null) is ImageCheck.Ok)
        assertEquals("empty image", (BridgeValidation.checkImageBytes(ByteArray(0), null) as ImageCheck.Rejected).reason)
        assertEquals("unsupported type", (BridgeValidation.checkImageBytes(png, "image/gif") as ImageCheck.Rejected).reason)
        assertEquals("type does not match content", (BridgeValidation.checkImageBytes(png, "image/jpeg") as ImageCheck.Rejected).reason)
        assertEquals("not a PNG, JPEG or WebP image", (BridgeValidation.checkImageBytes("hello world!".toByteArray(), null) as ImageCheck.Rejected).reason)
    }

    @Test
    fun `the binary image cap is exact`() {
        val atCap = png.copyOf(BridgeValidation.MAX_IMAGE_BYTES)
        assertTrue(BridgeValidation.checkImageBytes(atCap, "image/png") is ImageCheck.Ok)
        val overCap = png.copyOf(BridgeValidation.MAX_IMAGE_BYTES + 1)
        assertEquals("image too large", (BridgeValidation.checkImageBytes(overCap, "image/png") as ImageCheck.Rejected).reason)
    }

    @Test
    fun `the base64 cap matches the byte cap`() {
        // 4 characters carry 3 bytes, so the text cap is the byte cap plus the base64 overhead.
        assertEquals(BridgeValidation.MAX_IMAGE_BYTES / 3 * 4, BridgeValidation.MAX_BASE64_CHARS)
    }

    // ---- documents --------------------------------------------------------------------------------

    @Test
    fun `utf8Length matches the real encoding`() {
        for (text in listOf("", "abc", "é", "€", "😀", "aé€😀z", "\u0000\u007f\u0080߿ࠀ")) {
            assertEquals("for ${text.map { it.code }}", text.toByteArray(Charsets.UTF_8).size, BridgeValidation.utf8Length(text))
        }
    }

    @Test
    fun `utf8Length never undercounts a broken surrogate`() {
        for (text in listOf("\ud83d", "\ude00", "a\ud83d", "\ude00\ud83d")) {
            assertTrue(BridgeValidation.utf8Length(text) >= text.toByteArray(Charsets.UTF_8).size)
        }
    }

    private fun docWith(pad: String) = """{"version":1,"image":{"id":"abc-1"},"pad":"$pad"}"""

    @Test
    fun `a document is bounded by characters and by bytes`() {
        // 1,000,000 plain characters: inside both limits.
        val fine = docWith("x".repeat(1_000_000))
        assertEquals(fine, BridgeValidation.validateDocJson("abc-1", fine))

        // 600,000 euro signs: under the character limit but 1.8 million bytes, over the byte limit.
        val heavy = docWith("€".repeat(600_000))
        assertTrue(heavy.length < BridgeValidation.MAX_DOC_JSON_CHARS)
        assertNull(BridgeValidation.validateDocJson("abc-1", heavy))
    }

    @Test
    fun `the document limits stay under the database window`() {
        // A cursor window holds about 2 MB per row; the document shares its row with the OCR text and some metadata.
        assertTrue(BridgeValidation.MAX_DOC_JSON_BYTES <= 1_500_000)
        assertTrue(BridgeValidation.MAX_DOC_JSON_CHARS <= BridgeValidation.MAX_DOC_JSON_BYTES)
    }
}
