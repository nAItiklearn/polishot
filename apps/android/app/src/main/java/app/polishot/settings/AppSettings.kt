package app.polishot.settings

/** Light/dark follows the system unless the user picks one. */
enum class ThemeMode(val id: String) {
    System("system"),
    Light("light"),
    Dark("dark");

    fun isDark(systemIsDark: Boolean): Boolean =
        when (this) {
            System -> systemIsDark
            Light -> false
            Dark -> true
        }

    companion object {
        fun fromId(id: String?): ThemeMode = entries.firstOrNull { it.id == id } ?: System
    }
}

enum class ExportFormat(val id: String, val mime: String, val extension: String, val label: String) {
    Png("png", "image/png", "png", "PNG"),
    Jpeg("jpeg", "image/jpeg", "jpg", "JPEG"),
    Webp("webp", "image/webp", "webp", "WebP");

    companion object {
        fun fromId(id: String?): ExportFormat = entries.firstOrNull { it.id == id } ?: Png
    }
}

/** Canvas size presets offered as a default (the editor's `PresetId` without `custom`). */
object PresetIds {
    val all: List<String> = listOf("auto", "x", "linkedin", "ig-square", "ig-story", "youtube")

    /** Display names; the sizes match packages/editor `PRESETS`. */
    val labels: Map<String, String> = mapOf(
        "auto" to "Auto",
        "x" to "X post, 1600 x 900",
        "linkedin" to "LinkedIn, 1200 x 627",
        "ig-square" to "Instagram square, 1080 x 1080",
        "ig-story" to "Instagram story, 1080 x 1920",
        "youtube" to "YouTube thumbnail, 1280 x 720",
    )

    fun isValid(id: String?): Boolean = id != null && id in all
}

/** User-facing preferences (Settings screen). Defaults aim at "good output with zero configuration". */
data class AppSettings(
    val exportFormat: ExportFormat = ExportFormat.Png,
    /** JPEG/WebP quality, 40..100 (ignored for PNG). */
    val exportQuality: Int = 92,
    /** Output scale: 1x, 2x or 3x of the layout size. */
    val exportScale: Int = 2,
    val defaultPreset: String = "auto",
    val theme: ThemeMode = ThemeMode.System,
    /** Show the floating capture bubble during a capture session. */
    val bubbleEnabled: Boolean = true,
    /** Pro only: what replaces the watermark. Ignored while the licence is not Pro. */
    val brandMarkMode: BrandMarkMode = BrandMarkMode.Off,
    val brandMarkText: String = "",
) {
    /** Clamps every field into its valid range; used before anything is persisted. */
    fun sanitized(): AppSettings =
        copy(
            exportQuality = exportQuality.coerceIn(MIN_QUALITY, 100),
            exportScale = exportScale.coerceIn(1, 3),
            defaultPreset = if (PresetIds.isValid(defaultPreset)) defaultPreset else "auto",
            brandMarkText = BrandMarkRules.limitWhileTyping(brandMarkText),
        )

    /**
     * The brand mark to hand to the editor page, or null when there is none to draw: mode Off, empty text, or a
     * logo that is not stored. [logoDataUrl] is only called in Logo mode.
     */
    fun brandMarkPayload(logoDataUrl: () -> String?): BrandMarkPayload? =
        when (brandMarkMode) {
            BrandMarkMode.Off -> null
            BrandMarkMode.Text ->
                BrandMarkRules.cleanText(brandMarkText).takeIf { it.isNotEmpty() }?.let { BrandMarkPayload.Text(it) }
            BrandMarkMode.Logo -> logoDataUrl()?.let { BrandMarkPayload.Image(it) }
        }

    companion object {
        const val MIN_QUALITY = 40
    }
}
