package app.polishot.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppSettingsTest {
    @Test
    fun `defaults are sensible`() {
        val s = AppSettings()
        assertEquals(ExportFormat.Png, s.exportFormat)
        assertEquals(2, s.exportScale)
        assertEquals("auto", s.defaultPreset)
        assertTrue(s.bubbleEnabled)
        assertEquals(ThemeMode.System, s.theme)
    }

    @Test
    fun `sanitized clamps ranges and repairs unknown presets`() {
        val s = AppSettings(exportQuality = 5, exportScale = 9, defaultPreset = "nope").sanitized()
        assertEquals(AppSettings.MIN_QUALITY, s.exportQuality)
        assertEquals(3, s.exportScale)
        assertEquals("auto", s.defaultPreset)
        assertEquals(100, AppSettings(exportQuality = 400).sanitized().exportQuality)
        assertEquals(1, AppSettings(exportScale = 0).sanitized().exportScale)
    }

    @Test
    fun `enum ids round trip and unknown ids fall back`() {
        for (f in ExportFormat.entries) assertEquals(f, ExportFormat.fromId(f.id))
        for (t in ThemeMode.entries) assertEquals(t, ThemeMode.fromId(t.id))
        assertEquals(ExportFormat.Png, ExportFormat.fromId("bmp"))
        assertEquals(ThemeMode.System, ThemeMode.fromId(null))
    }

    @Test
    fun `theme resolves against the system setting`() {
        assertTrue(ThemeMode.System.isDark(true))
        assertFalse(ThemeMode.System.isDark(false))
        assertFalse(ThemeMode.Light.isDark(true))
        assertTrue(ThemeMode.Dark.isDark(false))
    }

    @Test
    fun `every preset id has a label`() {
        for (id in PresetIds.all) assertTrue("missing label for $id", PresetIds.labels.containsKey(id))
        assertFalse(PresetIds.isValid("custom"))
        assertTrue(PresetIds.isValid("ig-story"))
    }
}
