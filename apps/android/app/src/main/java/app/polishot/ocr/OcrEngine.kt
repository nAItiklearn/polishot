package app.polishot.ocr

import android.graphics.Bitmap
import android.graphics.BitmapFactory
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
 * On-device text recognition with ML Kit's bundled Latin model: no network, no Play Services download.
 * Output is mapped to the `OcrWord[]` contract by [OcrMapping]. Recognised text is never logged.
 */
object OcrEngine {
    /** Longest side handed to ML Kit; larger images are downscaled and the boxes scaled back up. */
    private const val MAX_OCR_SIDE = 4096

    private val recognizer: TextRecognizer by lazy {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }

    /** Recognises the PNG at [file]; [sourceWidth]/[sourceHeight] are its pixel size. */
    suspend fun recognize(file: File, sourceWidth: Int, sourceHeight: Int): List<OcrWord> {
        val decoded = withContext(Dispatchers.IO) { decodeForOcr(file, sourceWidth, sourceHeight) } ?: return emptyList()
        val (bitmap, scale) = decoded
        try {
            val text = process(bitmap)
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
            return OcrMapping.toWords(lines, sourceWidth, sourceHeight, scale)
        } finally {
            bitmap.recycle()
        }
    }

    private fun decodeForOcr(file: File, sourceWidth: Int, sourceHeight: Int): Pair<Bitmap, Double>? {
        val longest = maxOf(sourceWidth, sourceHeight)
        var sample = 1
        while (longest / sample > MAX_OCR_SIDE) sample *= 2
        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val bitmap = BitmapFactory.decodeFile(file.absolutePath, options) ?: return null
        // Boxes come back in the decoded bitmap's pixels; scale them to the real source size.
        val scale = sourceWidth.toDouble() / bitmap.width.toDouble()
        return bitmap to scale
    }

    private suspend fun process(bitmap: Bitmap): Text =
        suspendCancellableCoroutine { cont ->
            recognizer.process(InputImage.fromBitmap(bitmap, 0))
                .addOnSuccessListener { text -> cont.resume(text) }
                .addOnFailureListener { error -> cont.resumeWithException(error) }
        }
}
