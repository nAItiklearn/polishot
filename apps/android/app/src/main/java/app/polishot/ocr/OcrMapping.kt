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

    /** Largest JSON text kept per screenshot; a database cursor window holds about 2 MB per row. */
    const val MAX_STORED_JSON_CHARS = 1_000_000

    /** Rough JSON size of one word: the box, the field names and the line number, plus the text itself. */
    private const val WORD_JSON_OVERHEAD = 96

    /**
     * The longest prefix of [words] whose JSON stays under [maxJsonChars], so the history row can always be read
     * back. Words are in reading order, so what is dropped is the end of the page.
     */
    fun fitForStorage(words: List<OcrWord>, maxJsonChars: Int = MAX_STORED_JSON_CHARS): List<OcrWord> {
        var size = 2L
        for ((index, word) in words.withIndex()) {
            size += word.text.length + WORD_JSON_OVERHEAD
            if (size > maxJsonChars) return words.subList(0, index)
        }
        return words
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

    fun toJson(words: List<OcrWord>): String = toJsonArray(words).toString()

    /** The words as a JSON array object, for embedding in a larger object without serialising twice. */
    fun toJsonArray(words: List<OcrWord>): JSONArray {
        val arr = JSONArray()
        for (w in words) {
            val box = JSONObject()
                .put("x", w.box.x)
                .put("y", w.box.y)
                .put("w", w.box.w)
                .put("h", w.box.h)
            arr.put(JSONObject().put("text", w.text).put("box", box).put("line", w.line))
        }
        return arr
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

/**
 * How a tall screenshot is cut up for text recognition. ML Kit works best on images up to about 4096 pixels on the
 * longest side; a long scrolling capture shrunk to that would turn its text into mush. A narrow, tall image is
 * therefore recognised in overlapping horizontal bands at full resolution, and each band only keeps the lines that
 * are centred in its own share, so a line cut by one band is read whole by its neighbour and is never counted twice.
 * Pure arithmetic, no Android types.
 */
object OcrTiling {
    /** Longest side handed to ML Kit in one piece. */
    const val MAX_SIDE = 4096
    const val TILE_HEIGHT = 3072

    /** Rows shared by two neighbouring bands; larger than two text lines at any plausible size. */
    const val OVERLAP = 192

    /**
     * One band: pixel rows `[top, bottom)` of the source are recognised; an element whose vertical centre lies in
     * `[keepFrom, keepTo)` is kept.
     */
    data class Tile(val top: Int, val bottom: Int, val keepFrom: Int, val keepTo: Int) {
        fun keeps(centerY: Double): Boolean = centerY >= keepFrom && centerY < keepTo
    }

    /** The bands for a [width] x [height] image, or null when it can be recognised in one (possibly shrunk) piece. */
    fun tiles(width: Int, height: Int): List<Tile>? {
        if (width <= 0 || height <= MAX_SIDE || width > MAX_SIDE) return null
        val out = ArrayList<Tile>()
        var top = 0
        while (true) {
            val bottom = minOf(top + TILE_HEIGHT, height)
            val last = bottom >= height
            val keepFrom = if (top == 0) 0 else top + OVERLAP / 2
            val keepTo = if (last) height else bottom - OVERLAP / 2
            out.add(Tile(top, bottom, keepFrom, keepTo))
            if (last) break
            top = bottom - OVERLAP
        }
        return out
    }

    /** Keeps only the elements of [lines] that [tile] owns, moved down by the tile's top row; drops empty lines. */
    fun ownedLines(lines: List<RawLine>, tile: Tile): List<RawLine> {
        val out = ArrayList<RawLine>()
        for (line in lines) {
            val kept = line.elements.filter { tile.keeps(tile.top + (it.top + it.bottom) / 2.0) }
            if (kept.isNotEmpty()) {
                out.add(RawLine(kept.map { it.copy(top = it.top + tile.top, bottom = it.bottom + tile.top) }))
            }
        }
        return out
    }
}
