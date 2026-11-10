package app.polishot.editor

import app.polishot.ocr.OcrMapping
import app.polishot.ocr.OcrWord
import app.polishot.settings.BrandMarkPayload
import org.json.JSONObject

/** The export defaults the editor page starts with (the Settings screen values). */
data class ExportDefaults(val format: String, val quality: Double, val scale: Int)

/** Payload of `window.polishot.load(...)` (CONTRACTS section 6, plus the optional fields listed in CONTRACT-CHANGES). */
data class LoadPayload(
    val id: String,
    val imageUrl: String,
    val width: Int,
    val height: Int,
    val licensed: Boolean,
    val theme: String,
    val words: List<OcrWord>?,
    val docJson: String?,
    val exportDefaults: ExportDefaults,
    val defaultPreset: String,
    /** Whether the "Send to PC" action should be offered (false until quick send is wired up). */
    val quickSendAvailable: Boolean = false,
    /** Pro brand mark; null for Free, for Pro without a mark, and whenever the licence is not Pro. */
    val brandMark: BrandMarkPayload? = null,
)

/** One image in a batch beautify run. */
data class BatchItem(val id: String, val imageUrl: String, val width: Int, val height: Int)

/** Notification kinds understood by `window.polishot.notify`. */
enum class NotifyKind(val id: String) { Saved("saved"), Copied("copied"), Shared("shared"), Sent("sent"), Error("error") }

/**
 * Builders for the JavaScript snippets passed to `WebView.evaluateJavascript`. Every value is serialised with
 * `org.json` (so strings are quoted and escaped) and never concatenated into code as text. Pure Kotlin so the
 * escaping is unit tested.
 */
object JsCalls {
    private val IDENTIFIER = Regex("^[A-Za-z_][A-Za-z0-9_]*$")

    /** `window.polishot.<function>(<json args>)`, guarded so a page that has not installed the API yet is a no-op. */
    fun call(function: String, vararg jsonArgs: String): String {
        require(IDENTIFIER.matches(function)) { "invalid function name" }
        val args = jsonArgs.joinToString(",")
        return "window.polishot&&window.polishot.$function&&window.polishot.$function($args)"
    }

    /** A JSON string literal that is also a valid JavaScript string literal (U+2028/2029 escaped). */
    fun string(value: String): String = escapeSeparators(JSONObject.quote(value))

    fun load(payload: LoadPayload): String {
        val obj = JSONObject()
            .put("id", payload.id)
            .put("imageUrl", payload.imageUrl)
            .put("width", payload.width)
            .put("height", payload.height)
            .put("licensed", payload.licensed)
            .put("theme", payload.theme)
            .put("exportDefaults", exportDefaults(payload.exportDefaults))
            .put("defaultPreset", payload.defaultPreset)
            .put("quickSendAvailable", payload.quickSendAvailable)
        if (payload.words != null) obj.put("words", org.json.JSONArray(OcrMapping.toJson(payload.words)))
        if (payload.docJson != null) obj.put("docJson", payload.docJson)
        if (payload.brandMark != null) obj.put("brandMark", brandMarkJson(payload.brandMark))
        return call("load", escapeSeparators(obj.toString()))
    }

    fun setWords(words: List<OcrWord>): String = call("setWords", escapeSeparators(OcrMapping.toJson(words)))

    fun setLicensed(licensed: Boolean): String = call("setLicensed", if (licensed) "true" else "false")

    fun notify(kind: NotifyKind, message: String): String {
        val obj = JSONObject().put("kind", kind.id).put("message", message)
        return call("notify", escapeSeparators(obj.toString()))
    }

    fun batch(
        items: List<BatchItem>,
        lookJson: String?,
        licensed: Boolean,
        theme: String,
        defaults: ExportDefaults,
        brandMark: BrandMarkPayload? = null,
    ): String {
        val list = org.json.JSONArray()
        for (item in items) {
            list.put(
                JSONObject()
                    .put("id", item.id)
                    .put("imageUrl", item.imageUrl)
                    .put("width", item.width)
                    .put("height", item.height),
            )
        }
        val obj = JSONObject()
            .put("items", list)
            .put("licensed", licensed)
            .put("theme", theme)
            .put("export", exportDefaults(defaults))
        if (lookJson != null) obj.put("lookJson", lookJson)
        if (brandMark != null) obj.put("brandMark", brandMarkJson(brandMark))
        return call("batch", escapeSeparators(obj.toString()))
    }

    /** `window.polishot.onBack()` returns true when the page consumed the back press (it closed a sheet). */
    fun onBack(): String = call("onBack")

    private fun brandMarkJson(mark: BrandMarkPayload): JSONObject =
        when (mark) {
            is BrandMarkPayload.Text -> JSONObject().put("type", "text").put("text", mark.text)
            is BrandMarkPayload.Image -> JSONObject().put("type", "image").put("src", mark.dataUrl)
        }

    private fun exportDefaults(d: ExportDefaults): JSONObject =
        JSONObject().put("format", d.format).put("quality", d.quality).put("scale", d.scale)

    /** JSON allows U+2028/2029 inside strings; older JavaScript engines treat them as line terminators. */
    private fun escapeSeparators(json: String): String =
        json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
}
