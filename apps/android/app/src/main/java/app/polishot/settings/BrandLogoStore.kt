package app.polishot.settings

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.util.Base64
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The Pro brand-mark logo: one small PNG in app-private storage. A picked image is decoded by the platform
 * [ImageDecoder] (so it is validated and cannot be SVG or anything executable), scaled down to
 * [BrandMarkRules.MAX_LOGO_SIDE_PX] and re-encoded as PNG, which keeps transparency. Nothing is uploaded; the
 * editor page receives the bytes as a `data:` URL, the only image source its CSP allows besides the app itself.
 */
class BrandLogoStore(context: Context) {
    private val dir = File(context.applicationContext.filesDir, DIR_NAME)
    private val file = File(dir, FILE_NAME)

    fun exists(): Boolean = file.isFile && file.length() in 1..BrandMarkRules.MAX_LOGO_BYTES

    /** Copies the picked image in. Returns false (and keeps any previous logo) when it cannot be used. */
    fun import(resolver: ContentResolver, uri: Uri): Boolean {
        var bitmap: Bitmap? = null
        val tmp = File(dir, "$FILE_NAME.tmp")
        return try {
            val decoded = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                val longest = max(info.size.width, info.size.height)
                if (longest > BrandMarkRules.MAX_LOGO_SIDE_PX) {
                    val scale = BrandMarkRules.MAX_LOGO_SIDE_PX.toFloat() / longest
                    decoder.setTargetSize(
                        max(1, (info.size.width * scale).roundToInt()),
                        max(1, (info.size.height * scale).roundToInt()),
                    )
                }
            }
            if (!dir.isDirectory && !dir.mkdirs()) return false
            bitmap = decoded
            val written = tmp.outputStream().buffered().use { out -> decoded.compress(Bitmap.CompressFormat.PNG, 100, out) }
            if (!written || tmp.length() !in 1..BrandMarkRules.MAX_LOGO_BYTES) return false
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            true
        } catch (e: IOException) {
            false
        } catch (e: SecurityException) {
            false
        } finally {
            bitmap?.recycle()
            tmp.delete()
        }
    }

    /** `data:image/png;base64,...` for the editor page, or null when there is no (usable) logo. */
    fun dataUrl(): String? {
        if (!exists()) return null
        return try {
            "data:image/png;base64," + Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
        } catch (e: IOException) {
            null
        }
    }

    fun remove() {
        file.delete()
    }

    private companion object {
        const val DIR_NAME = "brand"
        const val FILE_NAME = "logo.png"
    }
}
