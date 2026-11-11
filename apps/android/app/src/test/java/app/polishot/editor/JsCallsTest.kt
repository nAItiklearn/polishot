package app.polishot.editor

import app.polishot.ocr.OcrBox
import app.polishot.ocr.OcrWord
import app.polishot.settings.BrandMarkPayload
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class JsCallsTest {
    @Test
    fun `strings are quoted and escaped`() {
        assertEquals("\"plain\"", JsCalls.string("plain"))
        val tricky = "he said \"hi\"\n</script><img src=x onerror=alert(1)>\\"
        val literal = JsCalls.string(tricky)
        assertFalse("raw newline must not appear in a literal", literal.contains('\n'))
        assertEquals(tricky, JSONArray("[$literal]").getString(0)) // round trip through a JSON parser
    }

    @Test
    fun `line and paragraph separators are escaped`() {
        val literal = JsCalls.string("a\u2028b\u2029c")
        assertFalse(literal.contains('\u2028'))
        assertFalse(literal.contains('\u2029'))
        assertTrue(literal.contains("\\u2028"))
        assertTrue(literal.contains("\\u2029"))
    }

    @Test
    fun `call guards against a missing API and rejects odd function names`() {
        assertEquals(
            "window.polishot&&window.polishot.setLicensed&&window.polishot.setLicensed(true)",
            JsCalls.setLicensed(true),
        )
        assertThrows(IllegalArgumentException::class.java) { JsCalls.call("load);alert(1);//", "{}") }
        assertThrows(IllegalArgumentException::class.java) { JsCalls.call("a.b") }
    }

    @Test
    fun `load payload carries every field and keeps the document as a string`() {
        val words = listOf(OcrWord("a@b.co", OcrBox(1.0, 2.0, 30.0, 10.0), 0))
        val doc = """{"version":1,"image":{"id":"x1"}}"""
        val js = JsCalls.load(
            LoadPayload(
                id = "x1",
                imageUrl = "https://appassets.androidplatform.net/capture/x1.png",
                width = 1080,
                height = 2400,
                licensed = false,
                theme = "dark",
                words = words,
                docJson = doc,
                exportDefaults = ExportDefaults("png", 0.92, 2),
                defaultPreset = "auto",
            ),
        )
        val prefix = "window.polishot&&window.polishot.load&&window.polishot.load("
        assertTrue(js.startsWith(prefix))
        assertTrue(js.endsWith(")"))
        val obj = JSONObject(js.removePrefix(prefix).removeSuffix(")"))
        assertEquals("x1", obj.getString("id"))
        assertEquals(1080, obj.getInt("width"))
        assertEquals("dark", obj.getString("theme"))
        assertEquals(doc, obj.getString("docJson"))
        assertEquals("a@b.co", obj.getJSONArray("words").getJSONObject(0).getString("text"))
        assertEquals(2, obj.getJSONObject("exportDefaults").getInt("scale"))
    }

    @Test
    fun `optional load fields are left out when absent`() {
        val js = JsCalls.load(
            LoadPayload("x1", "/capture/x1.png", 10, 10, true, "light", null, null, ExportDefaults("jpeg", 0.8, 1), "x"),
        )
        val obj = JSONObject(js.substringAfter("load(").removeSuffix(")"))
        assertFalse(obj.has("words"))
        assertFalse(obj.has("docJson"))
        assertTrue(obj.getBoolean("licensed"))
    }

    @Test
    fun `notify and batch produce parseable JSON`() {
        val notify = JsCalls.notify(NotifyKind.Saved, "Saved to \"Pictures\"")
        val n = JSONObject(notify.substringAfter("notify(").removeSuffix(")"))
        assertEquals("saved", n.getString("kind"))
        assertEquals("Saved to \"Pictures\"", n.getString("message"))

        val batch = JsCalls.batch(
            listOf(BatchItem("a1", "/capture/a1.png", 100, 200)),
            lookJson = """{"padding":0.1}""",
            licensed = false,
            theme = "light",
            defaults = ExportDefaults("png", 0.9, 2),
        )
        val b = JSONObject(batch.substringAfter("batch(").removeSuffix(")"))
        assertEquals(1, b.getJSONArray("items").length())
        assertEquals("""{"padding":0.1}""", b.getString("lookJson"))
    }

    private fun payload(words: List<OcrWord>? = null, binary: Boolean? = null, mark: BrandMarkPayload? = null) =
        if (binary == null) {
            LoadPayload("x1", "/capture/x1.png", 10, 10, true, "light", words, null, ExportDefaults("png", 0.9, 1), "auto", brandMark = mark)
        } else {
            LoadPayload(
                "x1", "/capture/x1.png", 10, 10, true, "light", words, null, ExportDefaults("png", 0.9, 1), "auto",
                brandMark = mark, binaryImages = binary,
            )
        }

    private fun loadObject(js: String) = JSONObject(js.substringAfter("polishot.load(").removeSuffix(")"))

    @Test
    fun `binaryImages is false unless the page can use the binary transport`() {
        assertFalse(loadObject(JsCalls.load(payload())).getBoolean("binaryImages"))
        assertTrue(loadObject(JsCalls.load(payload(binary = true))).getBoolean("binaryImages"))
        assertFalse(loadObject(JsCalls.load(payload(binary = false))).getBoolean("binaryImages"))

        val defaults = ExportDefaults("png", 0.9, 1)
        val plain = JsCalls.batch(emptyList(), null, false, "light", defaults)
        assertFalse(JSONObject(plain.substringAfter("batch(").removeSuffix(")")).getBoolean("binaryImages"))
        val binary = JsCalls.batch(emptyList(), null, false, "light", defaults, binaryImages = true)
        assertTrue(JSONObject(binary.substringAfter("batch(").removeSuffix(")")).getBoolean("binaryImages"))
    }

    @Test
    fun `words travel as a JSON array inside the payload not as an escaped string`() {
        val words = listOf(OcrWord("say \"hi\"", OcrBox(1.0, 2.0, 3.0, 4.0), 0), OcrWord("x\u2028y", OcrBox(5.0, 6.0, 7.0, 8.0), 1))
        val js = JsCalls.load(payload(words))
        val array = loadObject(js).getJSONArray("words")
        assertEquals(2, array.length())
        assertEquals("say \"hi\"", array.getJSONObject(0).getString("text"))
        assertEquals("x\u2028y", array.getJSONObject(1).getString("text"))
        assertFalse("U+2028 must not appear raw in script text", js.contains('\u2028'))
    }

    @Test
    fun `an empty word list is sent as an empty array so the page knows OCR ran`() {
        val array = loadObject(JsCalls.load(payload(emptyList()))).getJSONArray("words")
        assertEquals(0, array.length())
    }

    @Test
    fun `setWords round trips through the JSON the page parses`() {
        val words = listOf(OcrWord("a", OcrBox(1.0, 2.0, 3.0, 4.0), 0))
        val js = JsCalls.setWords(words)
        val array = org.json.JSONArray(js.substringAfter("polishot.setWords(").removeSuffix(")"))
        assertEquals("a", array.getJSONObject(0).getString("text"))
        assertEquals(4.0, array.getJSONObject(0).getJSONObject("box").getDouble("h"), 0.0)
    }

    @Test
    fun `flush and onBack are guarded calls without arguments`() {
        assertEquals("window.polishot&&window.polishot.flush&&window.polishot.flush()", JsCalls.flush())
        assertEquals("window.polishot&&window.polishot.onBack&&window.polishot.onBack()", JsCalls.onBack())
    }

    @Test
    fun `a brand mark is included only when there is one`() {
        assertFalse(loadObject(JsCalls.load(payload())).has("brandMark"))

        val text = loadObject(JsCalls.load(payload(mark = BrandMarkPayload.Text("Jane \"J\" Doe")))).getJSONObject("brandMark")
        assertEquals("text", text.getString("type"))
        assertEquals("Jane \"J\" Doe", text.getString("text"))

        val image = loadObject(JsCalls.load(payload(mark = BrandMarkPayload.Image("data:image/png;base64,AAAA")))).getJSONObject("brandMark")
        assertEquals("image", image.getString("type"))
        assertEquals("data:image/png;base64,AAAA", image.getString("src"))
    }
}
