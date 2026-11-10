package app.polishot.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureIdsTest {
    @Test
    fun `valid ids use letters digits underscore and hyphen`() {
        for (ok in listOf("a", "abc123", "m3k9x2ab-9f31c07e", "A_B-c", "x".repeat(64))) {
            assertTrue("expected valid: $ok", CaptureIds.isValid(ok))
        }
    }

    @Test
    fun `anything that could escape the captures directory is invalid`() {
        for (bad in listOf("", " ", "../x", "a/b", "a\\b", "a.b", "a b", "x".repeat(65), "a\u0000b", "%2e%2e", "a:b", "ü")) {
            assertFalse("expected invalid: $bad", CaptureIds.isValid(bad))
        }
        assertFalse(CaptureIds.isValid(null))
    }

    @Test
    fun `generated ids are valid and unique`() {
        val ids = (1..200).map { CaptureIds.generate() }.toSet()
        assertEquals(200, ids.size)
        assertTrue(ids.all { CaptureIds.isValid(it) })
    }

    @Test
    fun `generated ids start with the base 36 timestamp`() {
        assertTrue(CaptureIds.generate(nowMillis = 36L).startsWith("10-"))
        assertNotEquals(CaptureIds.generate(1L), CaptureIds.generate(1L)) // random suffix differs
    }

    @Test
    fun `png file names map back to ids`() {
        assertEquals("abc-1", CaptureIds.fromPngFileName("abc-1.png"))
        assertNull(CaptureIds.fromPngFileName("abc-1.jpg"))
        assertNull(CaptureIds.fromPngFileName("abc-1.png.tmp"))
        assertNull(CaptureIds.fromPngFileName("../abc.png"))
        assertNull(CaptureIds.fromPngFileName(".png"))
    }
}
