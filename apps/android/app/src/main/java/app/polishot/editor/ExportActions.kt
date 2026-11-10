package app.polishot.editor

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.PersistableBundle
import android.provider.MediaStore
import androidx.core.content.FileProvider
import app.polishot.APP_NAME
import app.polishot.APP_SLUG
import java.io.File
import java.io.IOException

/**
 * Everything that leaves the app goes through here, and only as validated [DecodedImage]s:
 *  - save: MediaStore insert into `Pictures/Polishot` (no storage permission needed on Android 10+)
 *  - share: a copy in `cache/shared` exposed through FileProvider and sent with ACTION_SEND
 *  - clipboard: ClipData with a FileProvider content URI (images) or plain text (OCR text, flagged sensitive)
 */
class ExportActions(context: Context) {
    private val context: Context = context.applicationContext

    /** Writes [image] to `Pictures/Polishot/[displayName]`. Returns the MediaStore URI. */
    @Throws(IOException::class)
    fun saveToGallery(image: DecodedImage, displayName: String): Uri {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
            put(MediaStore.MediaColumns.MIME_TYPE, image.mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$APP_NAME")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = resolver.insert(collection, values) ?: throw IOException("MediaStore insert failed")
        try {
            val out = resolver.openOutputStream(uri) ?: throw IOException("Cannot open the new image")
            out.use { it.write(image.bytes) }
            val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            resolver.update(uri, done, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw if (e is IOException) e else IOException("Saving failed", e)
        }
        return uri
    }

    /** An ACTION_SEND chooser for [image]; start it from an activity. */
    @Throws(IOException::class)
    fun shareIntent(image: DecodedImage): Intent {
        val uri = shareUri(image)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = image.mime
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newUri(context.contentResolver, "$APP_NAME image", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return Intent.createChooser(send, null)
    }

    @Throws(IOException::class)
    fun copyImage(image: DecodedImage) {
        val uri = shareUri(image)
        clipboard().setPrimaryClip(ClipData.newUri(context.contentResolver, "$APP_NAME image", uri))
    }

    fun copyText(text: String) {
        val clip = ClipData.newPlainText("Recognised text", text)
        // Recognised text may be sensitive; keep it out of clipboard previews where the platform supports it.
        clip.description.extras = PersistableBundle().apply { putBoolean(EXTRA_IS_SENSITIVE, true) }
        clipboard().setPrimaryClip(clip)
    }

    private fun clipboard(): ClipboardManager = context.getSystemService(ClipboardManager::class.java)

    @Throws(IOException::class)
    private fun shareUri(image: DecodedImage): Uri {
        val dir = File(context.cacheDir, SHARE_DIR)
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Cannot create the share folder")
        prune(dir)
        val file = File(dir, "$APP_SLUG-${System.currentTimeMillis()}.${image.extension}")
        file.writeBytes(image.bytes)
        return FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    }

    /** Keeps the share folder small: drop anything older than an hour and all but the newest few files. */
    private fun prune(dir: File) {
        val files = dir.listFiles().orEmpty().sortedByDescending { it.lastModified() }
        val cutoff = System.currentTimeMillis() - MAX_AGE_MILLIS
        files.forEachIndexed { index, file ->
            if (index >= KEEP_NEWEST || file.lastModified() < cutoff) file.delete()
        }
    }

    private companion object {
        const val SHARE_DIR = "shared"
        const val KEEP_NEWEST = 6
        const val MAX_AGE_MILLIS = 60L * 60 * 1000

        /** `ClipDescription.EXTRA_IS_SENSITIVE` (API 33); the literal keeps this valid on every supported release. */
        const val EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"
    }
}
