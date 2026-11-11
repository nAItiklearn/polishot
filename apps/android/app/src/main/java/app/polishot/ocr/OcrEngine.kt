package app.polishot.ocr

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/**
 * On-device text recognition with ML Kit's bundled Latin model: no model download, works offline. Output is mapped
 * to the `OcrWord[]` contract by [OcrMapping]. Recognised text is never logged.
 *
 * An image whose longest side is within [OcrTiling.MAX_SIDE] is recognised in one piece; a wider one is shrunk by
 * powers of two; a narrow, tall one (a long scrolling capture) is recognised in full-resolution bands ([OcrTiling]),
 * so its text stays readable.
 */
object OcrEngine {
    private val recognizer: TextRecognizer by lazy {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }

    /** Creates the recognizer now (call off the main thread) so the first screenshot does not pay for it. */
    fun warmUp() {
        recognizer
    }

    /** Recognises the PNG at [file]; [sourceWidth]/[sourceHeight] are its pixel size. */
    suspend fun recognize(file: File, sourceWidth: Int, sourceHeight: Int): List<OcrWord> {
        val tiles = OcrTiling.tiles(sourceWidth, sourceHeight)
        return if (tiles != null) {
            recognizeTiled(file, sourceWidth, sourceHeight, tiles)
        } else {
            recognizeWhole(file, sourceWidth, sourceHeight)
        }
    }

    private suspend fun recognizeWhole(file: File, sourceWidth: Int, sourceHeight: Int): List<OcrWord> {
        val decoded = withContext(Dispatchers.IO) { decodeWhole(file, sourceWidth, sourceHeight) } ?: return emptyList()
        val (bitmap, scale) = decoded
        // The bitmap is recycled by process() when ML Kit has finished with it, even if this coroutine is cancelled.
        val text = process(bitmap)
        return OcrMapping.toWords(linesOf(text), sourceWidth, sourceHeight, scale)
    }

    @Suppress("DEPRECATION") // the one-argument newInstance needs API 31; this works on every supported release
    private fun openRegionDecoder(file: File): BitmapRegionDecoder? =
        try {
            BitmapRegionDecoder.newInstance(file.absolutePath, false)
        } catch (e: java.io.IOException) {
            null
        }

    private suspend fun recognizeTiled(
        file: File,
        sourceWidth: Int,
        sourceHeight: Int,
        tiles: List<OcrTiling.Tile>,
    ): List<OcrWord> {
        val decoder = withContext(Dispatchers.IO) { openRegionDecoder(file) } ?: return emptyList()
        try {
            val lines = ArrayList<RawLine>()
            for (tile in tiles) {
                val bitmap = withContext(Dispatchers.IO) {
                    val options = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
                    decoder.decodeRegion(Rect(0, tile.top, sourceWidth, tile.bottom), options)
                } ?: continue
                lines.addAll(OcrTiling.ownedLines(linesOf(process(bitmap)), tile))
                if (lines.sumOf { it.elements.size } >= OcrMapping.MAX_WORDS) break
            }
            return OcrMapping.toWords(lines, sourceWidth, sourceHeight, 1.0)
        } finally {
            withContext(kotlinx.coroutines.NonCancellable) { decoder.recycle() }
        }
    }

    private fun decodeWhole(file: File, sourceWidth: Int, sourceHeight: Int): Pair<Bitmap, Double>? {
        val longest = maxOf(sourceWidth, sourceHeight)
        var sample = 1
        while (longest / sample > OcrTiling.MAX_SIDE) sample *= 2
        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val bitmap = BitmapFactory.decodeFile(file.absolutePath, options) ?: return null
        // Boxes come back in the decoded bitmap's pixels; scale them to the real source size.
        val scale = sourceWidth.toDouble() / bitmap.width.toDouble()
        return bitmap to scale
    }

    private fun linesOf(text: Text): List<RawLine> {
        val lines = ArrayList<RawLine>()
        for (block in text.textBlocks) {
            for (line in block.lines) {
                val elements = line.elements.mapNotNull { el ->
                    val r = el.boundingBox ?: return@mapNotNull null
                    RawElement(el.text, r.left, r.top, r.right, r.bottom)
                }
                if (elements.isNotEmpty()) lines.add(RawLine(elements))
            }
        }
        return lines
    }

    /**
     * Runs recognition on [bitmap] and recycles it once the task has completed (success, failure or abandoned by a
     * cancelled caller). Recycling any earlier would pull the pixels out from under ML Kit.
     */
    private suspend fun process(bitmap: Bitmap): Text =
        suspendCancellableCoroutine { cont ->
            val task = try {
                recognizer.process(InputImage.fromBitmap(bitmap, 0))
            } catch (e: Exception) {
                bitmap.recycle()
                throw e
            }
            task.addOnCompleteListener { bitmap.recycle() }
            task.addOnSuccessListener { text -> cont.resume(text) }
            task.addOnFailureListener { error -> cont.resumeWithException(error) }
        }
}
