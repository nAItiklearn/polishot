package app.polishot.settings

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Persists [AppSettings] in a private SharedPreferences file and exposes them as a StateFlow. */
class SettingsRepository(private val prefs: SharedPreferences) {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE),
    )

    private val mutable = MutableStateFlow(read())
    val settings: StateFlow<AppSettings> = mutable.asStateFlow()

    fun update(transform: (AppSettings) -> AppSettings) {
        val next = transform(mutable.value).sanitized()
        prefs.edit()
            .putString(KEY_FORMAT, next.exportFormat.id)
            .putInt(KEY_QUALITY, next.exportQuality)
            .putInt(KEY_SCALE, next.exportScale)
            .putString(KEY_PRESET, next.defaultPreset)
            .putString(KEY_THEME, next.theme.id)
            .putBoolean(KEY_BUBBLE, next.bubbleEnabled)
            .putString(KEY_BRAND_MODE, next.brandMarkMode.id)
            .putString(KEY_BRAND_TEXT, next.brandMarkText)
            .apply()
        mutable.value = next
    }

    /** The look (padding, background, ...) of the last edited document, used by batch beautify. */
    var lastLookJson: String?
        get() = prefs.getString(KEY_LAST_LOOK, null)
        set(value) {
            val editor = prefs.edit()
            if (value == null) editor.remove(KEY_LAST_LOOK) else editor.putString(KEY_LAST_LOOK, value)
            editor.apply()
        }

    /** Name this device shows to quick-send peers; defaults to the phone model. */
    var deviceName: String
        get() = prefs.getString(KEY_DEVICE_NAME, null)?.takeIf { it.isNotBlank() }
            ?: Build.MODEL.orEmpty().ifBlank { "Android phone" }
        set(value) {
            prefs.edit().putString(KEY_DEVICE_NAME, value).apply()
        }

    private fun read(): AppSettings {
        val defaults = AppSettings()
        return AppSettings(
            exportFormat = ExportFormat.fromId(prefs.getString(KEY_FORMAT, null)),
            exportQuality = prefs.getInt(KEY_QUALITY, defaults.exportQuality),
            exportScale = prefs.getInt(KEY_SCALE, defaults.exportScale),
            defaultPreset = prefs.getString(KEY_PRESET, null) ?: defaults.defaultPreset,
            theme = ThemeMode.fromId(prefs.getString(KEY_THEME, null)),
            bubbleEnabled = prefs.getBoolean(KEY_BUBBLE, defaults.bubbleEnabled),
            brandMarkMode = BrandMarkMode.fromId(prefs.getString(KEY_BRAND_MODE, null)),
            brandMarkText = prefs.getString(KEY_BRAND_TEXT, null).orEmpty(),
        ).sanitized()
    }

    companion object {
        const val PREFS_NAME = "polishot_settings"
        private const val KEY_FORMAT = "export_format"
        private const val KEY_QUALITY = "export_quality"
        private const val KEY_SCALE = "export_scale"
        private const val KEY_PRESET = "default_preset"
        private const val KEY_THEME = "theme"
        private const val KEY_BUBBLE = "bubble_enabled"
        private const val KEY_BRAND_MODE = "brand_mark_mode"
        private const val KEY_BRAND_TEXT = "brand_mark_text"
        private const val KEY_LAST_LOOK = "last_look_json"
        private const val KEY_DEVICE_NAME = "quicksend_device_name"
    }
}
