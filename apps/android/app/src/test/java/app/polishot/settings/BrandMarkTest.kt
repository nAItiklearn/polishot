package app.polishot.settings

import app.polishot.editor.ExportDefaults
import app.polishot.editor.JsCalls
import app.polishot.editor.LoadPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BrandMarkTest {
    @Test
    fun `clean text trims and collapses whitespace`() {
        assertEquals("Ada Lovelace", BrandMarkRules.cleanText("  Ada \t\n  Lovelace  "))
        assertEquals("a b", BrandMarkRules.cleanText("a  b")) // no-break and em space count as spaces
    }

    @Test
    fun `control and bidirectional override characters never survive`() {
        assertEquals("ab cd", BrandMarkRules.cleanText("ab‮cd"))
        assertEquals("a b", BrandMarkRules.cleanText("a\u0007b"))
        assertEquals("a b", BrandMarkRules.cleanText("a⁦b"))
        assertEquals("", BrandMarkRules.cleanText("‪‫‬"))
    }

    @Test
    fun `text is cut at forty characters, counting characters and not UTF-16 units`() {
        assertEquals(40, BrandMarkRules.cleanText("x".repeat(100)).length)
        val emoji = "😀" // one character, two UTF-16 units
        val cut = BrandMarkRules.cleanText(emoji.repeat(100))
        assertEquals(40, cut.codePointCount(0, cut.length))
        assertEquals("never splits a surrogate pair", 80, cut.length)
    }

    @Test
    fun `the final cut is trimmed again`() {
        val text = "a".repeat(39) + " " + "b".repeat(10)
        assertEquals("a".repeat(39), BrandMarkRules.cleanText(text))
    }

    @Test
    fun `typing keeps a trailing space so a two-word name can be entered`() {
        assertEquals("Ada ", BrandMarkRules.limitWhileTyping("Ada "))
        assertEquals("Ada L", BrandMarkRules.limitWhileTyping("Ada L"))
        assertEquals(40, BrandMarkRules.limitWhileTyping("y".repeat(300)).length)
    }

    @Test
    fun `mode ids round trip and unknown ids mean off`() {
        for (mode in BrandMarkMode.entries) assertEquals(mode, BrandMarkMode.fromId(mode.id))
        assertEquals(BrandMarkMode.Off, BrandMarkMode.fromId(null))
        assertEquals(BrandMarkMode.Off, BrandMarkMode.fromId("rainbow"))
    }

    @Test
    fun `settings default to no brand mark`() {
        val s = AppSettings()
        assertEquals(BrandMarkMode.Off, s.brandMarkMode)
        assertNull(s.brandMarkPayload { error("the logo must not be read when the mark is off") })
    }

    @Test
    fun `text mode produces a cleaned text payload and nothing when the text is blank`() {
        val named = AppSettings(brandMarkMode = BrandMarkMode.Text, brandMarkText = "  Studio  North ")
        assertEquals(BrandMarkPayload.Text("Studio North"), named.brandMarkPayload { error("no logo read in text mode") })
        val blank = AppSettings(brandMarkMode = BrandMarkMode.Text, brandMarkText = "   ")
        assertNull(blank.brandMarkPayload { null })
    }

    @Test
    fun `logo mode reads the logo lazily and yields nothing without one`() {
        val logo = AppSettings(brandMarkMode = BrandMarkMode.Logo, brandMarkText = "ignored")
        assertEquals(
            BrandMarkPayload.Image("data:image/png;base64,AAAA"),
            logo.brandMarkPayload { "data:image/png;base64,AAAA" },
        )
        assertNull(logo.brandMarkPayload { null })
    }

    @Test
    fun `sanitizing settings limits the stored text`() {
        val s = AppSettings(brandMarkMode = BrandMarkMode.Text, brandMarkText = "z".repeat(500)).sanitized()
        assertEquals(40, s.brandMarkText.length)
    }

    @Test
    fun `the load call carries a text mark as JSON`() {
        val js = JsCalls.load(payload(BrandMarkPayload.Text("Studio \"North\"")))
        assertTrue(js, js.contains("\"brandMark\":{"))
        assertTrue(js, js.contains("\"type\":\"text\""))
        assertTrue(js, js.contains("Studio \\\"North\\\""))
    }

    @Test
    fun `the load call carries a logo as a data URL`() {
        val js = JsCalls.load(payload(BrandMarkPayload.Image("data:image/png;base64,AAAA")))
        assertTrue(js, js.contains("\"type\":\"image\""))
        assertTrue(js, js.contains("\"src\":\"data:image/png;base64,AAAA\""))
    }

    @Test
    fun `no mark means no brandMark key at all`() {
        assertFalse(JsCalls.load(payload(null)).contains("brandMark"))
        val batch = JsCalls.batch(emptyList(), null, licensed = false, theme = "light", defaults = defaults)
        assertFalse(batch.contains("brandMark"))
    }

    @Test
    fun `the batch call carries the mark too`() {
        val js = JsCalls.batch(emptyList(), null, licensed = true, theme = "dark", defaults = defaults, brandMark = BrandMarkPayload.Text("Ada"))
        assertTrue(js, js.contains("\"brandMark\":{\"type\":\"text\",\"text\":\"Ada\"}") || js.contains("\"text\":\"Ada\""))
    }

    @Test
    fun `a text mark with line separators cannot break out of the script`() {
        val js = JsCalls.load(payload(BrandMarkPayload.Text("a b c")))
        assertFalse(js.contains(' '))
        assertFalse(js.contains(' '))
    }

    private val defaults = ExportDefaults("png", 0.92, 2)

    private fun payload(mark: BrandMarkPayload?) = LoadPayload(
        id = "abc",
        imageUrl = "https://appassets.androidplatform.net/capture/abc.png",
        width = 10,
        height = 10,
        licensed = true,
        theme = "light",
        words = null,
        docJson = null,
        exportDefaults = defaults,
        defaultPreset = "auto",
        brandMark = mark,
    )
}
