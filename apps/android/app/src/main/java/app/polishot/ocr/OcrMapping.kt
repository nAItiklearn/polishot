package app.polishot.ocr

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** Axis-aligned box in SOURCE image pixels (CONTRACTS section 2 `Box`). */
data class OcrBox(val x: Double, val y: Double, val w: Double, val h: Double)

/** CONTRACTS section 2 `OcrWord`: one recognised word, `line` is the reading-order line index. */
data class OcrWord(val text: String, val box: OcrBox, val line: Int)

/** One recognised element (word) as reported by the OCR engine, in the pixel space of the image it was run on. */
data class RawElement(val text: String, val left: Int, val top: Int, val right: Int, val bottom: Int)

/** One recognised text line, in the engine's reading order. */
data class RawLine(val elements: List<RawElement>)

/**
 * Pure mapping from OCR engine output to the `OcrWord[]` contract. Kept free of ML Kit and Android types so it
 * is covered by plain JVM tests; [OcrEngine] converts ML Kit's `Text` into [RawLine]s and calls this.
 */
object OcrMapping {
    /** Hard cap so a pathological image cannot flood the JS bridge. */
    const val MAX_WORDS = 6000
    private const val MIN_SIDE = 0.5

    /**
     * @param lines recognised lines in reading order.
     * @param imageWidth width of the SOURCE image (clamp bound).
     * @param imageHeight height of the SOURCE image.
     * @param scale factor from the pixel space OCR ran in to source pixels (greater than 1 when the image was
     *   downscaled before recognition).
     */
    fun toWords(lines: List<RawLine>, imageWidth: Int, imageHeight: Int, scale: Double = 1.0): List<OcrWord> {
        if (imageWidth <= 0 || imageHeight <= 0 || !(scale > 0.0)) return emptyList()
        val out = ArrayList<OcrWord>()
        var lineIndex = 0
        for (line in lines) {
            var produced = false
            for (el in line.elements.sortedBy { it.left }) {
                if (out.size >= MAX_WORDS) return out
                val text = cleanText(el.text)
                if (text.isEmpty()) continue
                val left = (el.left * scale).coerceIn(0.0, imageWidth.toDouble())
                val top = (el.top * scale).coerceIn(0.0, imageHeight.toDouble())
                val right = (el.right * scale).coerceIn(0.0, imageWidth.toDouble())
                val bottom = (el.bottom * scale).coerceIn(0.0, imageHeight.toDouble())
                val w = right - left
                val h = bottom - top
                if (w < MIN_SIDE || h < MIN_SIDE) continue
                out.add(OcrWord(text, OcrBox(round1(left), round1(top), round1(w), round1(h)), lineIndex))
                produced = true
            }
            if (produced) lineIndex++
        }
        return out
    }

    /** Reading-order text: words joined by spaces, lines by newlines (same as the editor's `wordsToText`). */
    fun toPlainText(words: List<OcrWord>): String {
        val sb = StringBuilder()
        var current = Int.MIN_VALUE
        for (w in words) {
            if (current != Int.MIN_VALUE) sb.append(if (w.line == current) ' ' else '\n')
            sb.append(w.text)
            current = w.line
        }
        return sb.toString()
    }

    fun toJson(words: List<OcrWord>): String {
        val arr = JSONArray()
        for (w in words) {
            val box = JSONObject()
                .put("x", w.box.x)
                .put("y", w.box.y)
                .put("w", w.box.w)
                .put("h", w.box.h)
            arr.put(JSONObject().put("text", w.text).put("box", box).put("line", w.line))
        }
        return arr.toString()
    }

    /** Parses what [toJson] produced; null when the text is not a valid word list. */
    fun fromJson(json: String): List<OcrWord>? {
        return try {
            val arr = JSONArray(json)
            val out = ArrayList<OcrWord>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val b = o.getJSONObject("box")
                out.add(
                    OcrWord(
                        text = o.getString("text"),
                        box = OcrBox(b.getDouble("x"), b.getDouble("y"), b.getDouble("w"), b.getDouble("h")),
                        line = o.getInt("line"),
                    ),
                )
            }
            out
        } catch (e: JSONException) {
            null
        }
    }

    private fun cleanText(raw: String): String {
        val sb = StringBuilder(raw.length)
        for (ch in raw) {
            if (ch.code >= 0x20 && ch.code != 0x7F) sb.append(ch)
        }
        return sb.toString().trim()
    }

    private fun round1(v: Double): Double = Math.round(v * 10.0) / 10.0
}
