package app.polishot.share

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat

/** Reads the images out of an ACTION_SEND / ACTION_SEND_MULTIPLE intent, accepting only content URIs. */
object ShareImport {
    /** More than this in one intent is treated as abuse and cut off before any limit message. */
    const val HARD_CAP = 500

    /**
     * Content URIs from the intent (`EXTRA_STREAM` and the clip data), de-duplicated, in order. `file://` URIs are
     * refused: a sender could point one at this app's private files, and every legitimate sender uses content URIs.
     * URIs owned by this app are refused for the same reason.
     */
    fun uris(intent: Intent, ownPackage: String): List<Uri> {
        val found = LinkedHashSet<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> {
                IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { found.add(it) }
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                    ?.let { found.addAll(it) }
            }
            else -> return emptyList()
        }
        intent.clipData?.let { clip -> addClip(clip, found) }
        return found.filter { isAcceptable(it, ownPackage) }.take(HARD_CAP)
    }

    private fun addClip(clip: ClipData, into: MutableSet<Uri>) {
        for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { into.add(it) }
    }

    fun isAcceptable(uri: Uri, ownPackage: String): Boolean {
        if (uri.scheme != "content") return false
        val authority = uri.authority ?: return false
        return !authority.startsWith(ownPackage)
    }
}
