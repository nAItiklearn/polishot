package app.polishot.ocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OcrMappingTest {
    private fun el(text: String, l: Int, t: Int, r: Int, b: Int) = RawElement(text, l, t, r, b)

    @Test
    fun `elements become words with source pixel boxes and a reading order line index`() {
        val lines = listOf(
            RawLine(listOf(el("Email:", 10, 20, 60, 40), el("jane@example.com", 70, 20, 230, 40))),
            RawLine(listOf(el("Card", 10, 50, 50, 70), el("4242", 60, 50, 100, 70))),
        )
        val words = OcrMapping.toWords(lines, 400, 300)
        assertEquals(listOf("Email:", "jane@example.com", "Card", "4242"), words.map { it.text })
        assertEquals(listOf(0, 0, 1, 1), words.map { it.line })
        assertEquals(OcrBox(70.0, 20.0, 160.0, 20.0), words[1].box)
    }

    @Test
    fun `words inside a line are ordered left to right`() {
        val line = RawLine(listOf(el("world", 60, 0, 100, 10), el("hello", 0, 0, 50, 10)))
        assertEquals(listOf("hello", "world"), OcrMapping.toWords(listOf(line), 200, 100).map { it.text })
    }

    @Test
    fun `scale maps boxes from the downscaled image back to source pixels`() {
        val lines = listOf(RawLine(listOf(el("x", 10, 10, 20, 20))))
        val words = OcrMapping.toWords(lines, imageWidth = 1000, imageHeight = 1000, scale = 2.0)
        assertEquals(OcrBox(20.0, 20.0, 20.0, 20.0), words.single().box)
    }

    @Test
    fun `boxes are clamped to the image and degenerate ones dropped`() {
        val lines = listOf(
            RawLine(
                listOf(
                    el("edge", -20, -5, 30, 15),
                    el("outside", 500, 500, 600, 600),
                    el("flat", 10, 10, 10, 20),
                    el("tall", 10, 10, 20, 10),
                ),
            ),
        )
        val words = OcrMapping.toWords(lines, 100, 100)
        assertEquals(listOf("edge"), words.map { it.text })
        assertEquals(OcrBox(0.0, 0.0, 30.0, 15.0), words.single().box)
    }

    @Test
    fun `blank text and control characters are removed`() {
        val lines = listOf(
            RawLine(listOf(el("  ", 0, 0, 10, 10), el("a\u0000b\u0007", 20, 0, 40, 10), el("\n", 50, 0, 60, 10))),
            RawLine(listOf(el(" ok ", 0, 20, 20, 30))),
        )
        val words = OcrMapping.toWords(lines, 100, 100)
        assertEquals(listOf("ab", "ok"), words.map { it.text })
        // Line indexes stay contiguous even though the blank elements were skipped.
        assertEquals(listOf(0, 1), words.map { it.line })
    }

    @Test
    fun `lines without usable words do not consume an index`() {
        val lines = listOf(
            RawLine(emptyList()),
            RawLine(listOf(el(" ", 0, 0, 10, 10))),
            RawLine(listOf(el("first", 0, 0, 40, 10))),
        )
        assertEquals(listOf(0), OcrMapping.toWords(lines, 100, 100).map { it.line })
    }

    @Test
    fun `invalid image sizes or scales give an empty result`() {
        val lines = listOf(RawLine(listOf(el("x", 0, 0, 10, 10))))
        assertTrue(OcrMapping.toWords(lines, 0, 100).isEmpty())
        assertTrue(OcrMapping.toWords(lines, 100, -1).isEmpty())
        assertTrue(OcrMapping.toWords(lines, 100, 100, scale = 0.0).isEmpty())
        assertTrue(OcrMapping.toWords(lines, 100, 100, scale = Double.NaN).isEmpty())
    }

    @Test
    fun `the word count is capped`() {
        val elements = (0 until OcrMapping.MAX_WORDS + 500).map { el("w$it", 0, 0, 10, 10) }
        val words = OcrMapping.toWords(listOf(RawLine(elements)), 100, 100)
        assertEquals(OcrMapping.MAX_WORDS, words.size)
    }

    @Test
    fun `plain text joins words with spaces and lines with newlines`() {
        val words = listOf(
            OcrWord("one", OcrBox(0.0, 0.0, 1.0, 1.0), 0),
            OcrWord("two", OcrBox(0.0, 0.0, 1.0, 1.0), 0),
            OcrWord("three", OcrBox(0.0, 0.0, 1.0, 1.0), 1),
        )
        assertEquals("one two\nthree", OcrMapping.toPlainText(words))
        assertEquals("", OcrMapping.toPlainText(emptyList()))
    }

    @Test
    fun `json round trip keeps every field`() {
        val words = listOf(
            OcrWord("a\"b", OcrBox(1.5, 2.0, 30.25, 10.0), 0),
            OcrWord("über", OcrBox(40.0, 2.0, 50.0, 10.0), 3),
        )
        val restored = OcrMapping.fromJson(OcrMapping.toJson(words))
        assertNotNull(restored)
        assertEquals(words, restored)
    }

    @Test
    fun `malformed json is rejected`() {
        assertNull(OcrMapping.fromJson("not json"))
        assertNull(OcrMapping.fromJson("{}"))
        assertNull(OcrMapping.fromJson("""[{"text":"x"}]"""))
    }
}
