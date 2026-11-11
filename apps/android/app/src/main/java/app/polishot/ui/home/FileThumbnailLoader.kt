package app.polishot.ui.home

import android.content.ComponentCallbacks2
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import app.polishot.capture.CaptureStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Decodes the small JPEG next to each capture and keeps recent ones in memory. The cache is bounded by bytes, not by
 * count (thumbnails differ in size), and it empties when the system asks for memory ([trim]).
 */
class FileThumbnailLoader(
    private val store: CaptureStore,
    maxCacheBytes: Int = budgetBytes(Runtime.getRuntime().maxMemory()),
) : ThumbnailLoader {
    private val cache = object : LruCache<String, ImageBitmap>(maxCacheBytes) {
        override fun sizeOf(key: String, value: ImageBitmap): Int = value.asAndroidBitmap().byteCount
    }

    override suspend fun load(id: String): ImageBitmap? {
        cache.get(id)?.let { return it }
        val decoded = withContext(Dispatchers.IO) {
            val file = runCatching { store.thumbFile(id) }.getOrNull()
            if (file == null || !file.isFile) {
                null
            } else {
                try {
                    BitmapFactory.decodeFile(file.absolutePath)?.asImageBitmap()
                } catch (e: OutOfMemoryError) {
                    null // a missing tile is better than a crash; the grid shows a plain tile
                }
            }
        }
        if (decoded != null) cache.put(id, decoded)
        return decoded
    }

    /**
     * Drops cached thumbnails when the system is short of memory. [level] is the value passed to
     * `onTrimMemory`: the app's UI just went away (20), it sits in the background list (40), or it is a likely
     * candidate to be killed (60 and above).
     */
    fun trim(level: Int) {
        when {
            level >= LEVEL_KILL_CANDIDATE -> cache.evictAll()
            level >= LEVEL_UI_HIDDEN -> cache.trimToSize(cache.maxSize() / 2)
        }
    }

    companion object {
        // ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN and TRIM_MEMORY_MODERATE; the named constants for the higher levels
        // are deprecated since Android 14, but the numbers are still what the system sends.
        private const val LEVEL_UI_HIDDEN = ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN
        private const val LEVEL_KILL_CANDIDATE = 60
        private const val MIN_BYTES = 4 * 1024 * 1024
        private const val MAX_BYTES = 48 * 1024 * 1024

        /** An eighth of the app's heap, between 4 and 48 MB: enough for a few screens of tiles, never a risk. */
        fun budgetBytes(maxMemory: Long): Int = (maxMemory / 8).coerceIn(MIN_BYTES.toLong(), MAX_BYTES.toLong()).toInt()
    }
}
