package app.polishot.capture

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.sqrt

/** A capture that was written to private storage. */
data class SavedCapture(val id: String, val width: Int, val height: Int)

/** An image that cannot be decoded safely: it is far larger than any screenshot (a decompression bomb) or damaged. */
class ImageRejectedException(message: String) : IOException(message)

/** The platform decoder could not read the bytes as an image (damaged, truncated or not an image at all). */
class ImageUnreadableException(message: String, cause: Throwable? = null) : IOException(message, cause)

/**
 * Size rules for images that arrive from outside the app (picker, share sheet, quick send). Pure arithmetic, no
 * Android types, so it is covered by plain JVM tests.
 *
 * Three tiers: up to [MAX_IMPORT_PIXELS] an image is used as is; beyond that it is scaled down while decoding; beyond
 * [HARD_MAX_PIXELS] (or [HARD_MAX_SIDE] on one edge) it is refused before any pixel is decoded, because a small file
 * can describe an enormous image and the allocation would kill the process rather than throw.
 */
object ImageLimits {
    /** 24 megapixels: about 96 MB as ARGB_8888, the most a phone can comfortably hold. */
    const val MAX_IMPORT_PIXELS = 24_000_000L

    /** 120 megapixels: far beyond any camera or screen; anything larger is treated as hostile. */
    const val HARD_MAX_PIXELS = 120_000_000L
    const val HARD_MAX_SIDE = 32_768

    fun isAcceptable(width: Int, height: Int): Boolean =
        width in 1..HARD_MAX_SIDE && height in 1..HARD_MAX_SIDE && width.toLong() * height <= HARD_MAX_PIXELS

    /** The size to decode at, or null when the image is small enough to keep. Never returns a zero side. */
    fun targetSize(width: Int, height: Int): Pair<Int, Int>? {
        val pixels = width.toLong() * height.toLong()
        if (pixels <= MAX_IMPORT_PIXELS) return null
        val factor = sqrt(MAX_IMPORT_PIXELS.toDouble() / pixels.toDouble())
        return max(1, (width * factor).toInt()) to max(1, (height * factor).toInt())
    }
}

/**
 * App-private image storage under `filesDir`:
 *  - `captures/<id>.png`  the full-resolution original (also what the editor WebView loads)
 *  - `thumbs/<id>.jpg`    a small thumbnail for the history grid
 *
 * Nothing here is world readable; the editor receives images through the WebView asset loader and everything
 * leaving the app goes through MediaStore or a FileProvider copy.
 */
class CaptureStore(root: File) {
    constructor(context: Context) : this(context.filesDir)

    private val capturesDir = File(root, "captures")
    private val thumbsDir = File(root, "thumbs")

    init {
        capturesDir.mkdirs()
        thumbsDir.mkdirs()
    }

    fun imageFile(id: String): File {
        require(CaptureIds.isValid(id)) { "invalid capture id" }
        return File(capturesDir, "$id.png")
    }

    fun thumbFile(id: String): File {
        require(CaptureIds.isValid(id)) { "invalid capture id" }
        return File(thumbsDir, "$id.jpg")
    }

    fun exists(id: String): Boolean = CaptureIds.isValid(id) && imageFile(id).isFile

    /** Pixel size of the stored PNG, read from its header only. */
    fun readSize(id: String): Pair<Int, Int>? {
        if (!exists(id)) return null
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(imageFile(id).absolutePath, options)
        return if (options.outWidth > 0 && options.outHeight > 0) options.outWidth to options.outHeight else null
    }

    /**
     * Encodes [bitmap] losslessly as a new capture, without the thumbnail. The editor can open the capture as soon as
     * this returns; write the thumbnail afterwards with [writeThumbnail].
     */
    @Throws(IOException::class)
    fun savePng(bitmap: Bitmap): SavedCapture {
        val id = CaptureIds.generate()
        val target = imageFile(id)
        val temp = File(capturesDir, "$id.png.tmp")
        try {
            BufferedOutputStream(FileOutputStream(temp), 64 * 1024).use { out ->
                if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) throw IOException("PNG encoding failed")
            }
            if (!temp.renameTo(target)) throw IOException("Could not store the capture")
        } finally {
            if (temp.exists()) temp.delete()
        }
        return SavedCapture(id, bitmap.width, bitmap.height)
    }

    /** [savePng] plus the thumbnail. */
    @Throws(IOException::class)
    fun save(bitmap: Bitmap): SavedCapture {
        val saved = savePng(bitmap)
        writeThumbnail(saved.id, bitmap)
        return saved
    }

    /**
     * Imports an image the user picked or shared. Decoding goes through [ImageDecoder] (which also applies EXIF
     * rotation), always into software memory, and images beyond [ImageLimits.MAX_IMPORT_PIXELS] are downscaled.
     * Anything the platform cannot decode raises [IOException]; an absurdly large image raises
     * [ImageRejectedException] before it is decoded.
     */
    @Throws(IOException::class)
    fun importFrom(resolver: ContentResolver, uri: Uri): SavedCapture =
        saveDecoded { ImageDecoder.createSource(resolver, uri) }

    /**
     * Same as [importFrom] for bytes that are already in memory (an image received by quick send). The bytes are
     * untrusted: the platform decoder, with the size limits above, is the gatekeeper.
     */
    @Throws(IOException::class)
    fun importBytes(bytes: ByteArray): SavedCapture = saveDecoded { ImageDecoder.createSource(ByteBuffer.wrap(bytes)) }

    private fun saveDecoded(source: () -> ImageDecoder.Source): SavedCapture {
        val bitmap = try {
            ImageDecoder.decodeBitmap(source()) { decoder, info, _ ->
                val w = info.size.width
                val h = info.size.height
                if (!ImageLimits.isAcceptable(w, h)) throw ImageRejectedException("Image is too large ($w x $h)")
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                ImageLimits.targetSize(w, h)?.let { (tw, th) -> decoder.setTargetSize(tw, th) }
            }
        } catch (e: ImageDecoder.DecodeException) {
            throw ImageUnreadableException("Unsupported image", e)
        } catch (e: SecurityException) {
            throw IOException("Image is not readable", e)
        }
        try {
            return save(bitmap)
        } finally {
            bitmap.recycle()
        }
    }

    fun delete(id: String) {
        if (!CaptureIds.isValid(id)) return
        imageFile(id).delete()
        thumbFile(id).delete()
    }

    fun deleteAll() {
        capturesDir.listFiles()?.forEach { it.delete() }
        thumbsDir.listFiles()?.forEach { it.delete() }
    }

    /** Ids of every stored original, for orphan clean-up. */
    fun storedIds(): List<String> =
        capturesDir.listFiles().orEmpty().mapNotNull { CaptureIds.fromPngFileName(it.name) }

    /** Removes stored captures that are not in [keep] and are older than [olderThanMillis]. */
    fun sweepOrphans(keep: Set<String>, olderThanMillis: Long, nowMillis: Long = System.currentTimeMillis()) {
        for (file in capturesDir.listFiles().orEmpty()) {
            val id = CaptureIds.fromPngFileName(file.name)
            val stale = nowMillis - file.lastModified() > olderThanMillis
            if (stale && (id == null || id !in keep)) {
                file.delete()
                if (id != null) thumbFile(id).delete()
            }
        }
    }

    /** Writes the history-grid thumbnail for [id]; a failure leaves the grid with a plain tile. */
    fun writeThumbnail(id: String, source: Bitmap) {
        val longest = max(source.width, source.height)
        val factor = if (longest > THUMB_SIDE) THUMB_SIDE.toFloat() / longest else 1f
        val tw = max(1, (source.width * factor).toInt())
        val th = max(1, (source.height * factor).toInt())
        val scaled = if (factor < 1f) Bitmap.createScaledBitmap(source, tw, th, true) else source
        try {
            BufferedOutputStream(FileOutputStream(thumbFile(id))).use { out ->
                scaled.compress(Bitmap.CompressFormat.JPEG, 82, out)
            }
        } catch (e: IOException) {
            thumbFile(id).delete() // the grid falls back to a plain tile
        } finally {
            if (scaled !== source) scaled.recycle()
        }
    }

    companion object {
        const val MAX_IMPORT_PIXELS = ImageLimits.MAX_IMPORT_PIXELS
        private const val THUMB_SIDE = 480
    }
}
