package app.polishot.ui.home

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import app.polishot.capture.CaptureStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Decodes the small JPEG next to each capture and keeps the most recent ones in memory. */
class FileThumbnailLoader(private val store: CaptureStore) : ThumbnailLoader {
    private val cache = LruCache<String, ImageBitmap>(MAX_CACHED)

    override suspend fun load(id: String): ImageBitmap? {
        cache.get(id)?.let { return it }
        val decoded = withContext(Dispatchers.IO) {
            val file = runCatching { store.thumbFile(id) }.getOrNull()
            if (file == null || !file.isFile) null else BitmapFactory.decodeFile(file.absolutePath)?.asImageBitmap()
        }
        if (decoded != null) cache.put(id, decoded)
        return decoded
    }

    private companion object {
        const val MAX_CACHED = 64
    }
}
