package app.polishot.history

import org.json.JSONException
import org.json.JSONObject

/**
 * Pulls the reusable "look" (padding, background, radius, shadow, frame, preset, custom size) out of a saved
 * EditorDoc JSON. The next batch beautify run applies it to every shared image, so the user's last-used
 * styling carries over. The image, crop and annotations are intentionally not part of a look.
 */
object LookExtractor {
    private val KEYS = listOf("padding", "background", "radius", "shadow", "frame", "preset", "custom")

    /** A background image can embed a large data URL; looks bigger than this fall back to the auto background. */
    private const val MAX_LOOK_CHARS = 300_000

    /** Returns a compact JSON object string, or null when [docJson] is not a usable document. */
    fun fromDocJson(docJson: String): String? {
        val doc = try {
            JSONObject(docJson)
        } catch (e: JSONException) {
            return null
        }
        if (doc.optInt("version", 0) != 1) return null

        val look = JSONObject()
        for (key in KEYS) {
            if (doc.has(key) && !doc.isNull(key)) look.put(key, doc.get(key))
        }
        if (look.toString().length > MAX_LOOK_CHARS) look.remove("background")
        return if (look.length() == 0) null else look.toString()
    }
}
