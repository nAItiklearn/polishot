package app.polishot.history

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LookExtractorTest {
    private val doc = """
        {"version":1,"image":{"id":"abc","width":10,"height":20},"crop":{"x":1,"y":2,"w":3,"h":4},
         "padding":0.12,"background":{"type":"gradient","stops":["#111111","#222222"],"angle":45},
         "radius":16,"shadow":0.6,"frame":"browser-light","preset":"x","annotations":[{"id":"a1","type":"arrow"}]}
    """.trimIndent()

    @Test
    fun `keeps the look fields and drops image crop and annotations`() {
        val look = JSONObject(requireNotNull(LookExtractor.fromDocJson(doc)))
        assertEquals(0.12, look.getDouble("padding"), 1e-9)
        assertEquals(16, look.getInt("radius"))
        assertEquals("browser-light", look.getString("frame"))
        assertEquals("x", look.getString("preset"))
        assertEquals("gradient", look.getJSONObject("background").getString("type"))
        assertFalse(look.has("image"))
        assertFalse(look.has("crop"))
        assertFalse(look.has("annotations"))
    }

    @Test
    fun `invalid or foreign documents give null`() {
        assertNull(LookExtractor.fromDocJson("not json"))
        assertNull(LookExtractor.fromDocJson("""{"version":2,"padding":0.1}"""))
        assertNull(LookExtractor.fromDocJson("""{"version":1,"image":{}}"""))
    }

    @Test
    fun `an oversized background image is dropped but the rest of the look stays`() {
        val big = "x".repeat(400_000)
        val withImage = """{"version":1,"padding":0.1,"background":{"type":"image","src":"data:image/png;base64,$big","blur":4}}"""
        val look = JSONObject(requireNotNull(LookExtractor.fromDocJson(withImage)))
        assertFalse(look.has("background"))
        assertTrue(look.has("padding"))
        assertNotNull(look)
    }
}
