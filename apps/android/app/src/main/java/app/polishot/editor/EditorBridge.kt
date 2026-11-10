package app.polishot.editor

import android.util.Log
import android.webkit.JavascriptInterface
import app.polishot.capture.CaptureIds
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * The `PolishotAndroid` object the editor page talks to (CONTRACTS section 6). Every method receives untrusted
 * strings: they are validated by [BridgeValidation] on a single worker thread (so a 30 MB image never blocks the
 * WebView's JavaBridge thread, and saves stay in order) and only then handed to the [Host] as typed values.
 *
 * Methods return nothing; results come back asynchronously through `window.polishot.notify`.
 * Nothing is logged except the method name and a fixed rejection reason, never image data or recognised text.
 */
class EditorBridge(private val host: Host) {
    /** Callbacks run on the bridge's worker thread. Hop to the main thread for UI work. */
    interface Host {
        fun onReady()
        fun onRequestOcr(id: String)
        fun onSaveImage(image: DecodedImage, filename: String)
        fun onShareImage(image: DecodedImage)
        fun onCopyImage(image: DecodedImage)
        fun onCopyText(text: String)
        fun onSaveDoc(id: String, docJson: String)
        fun onQuickSend(image: DecodedImage)
        fun onClose()
        fun onBatchProgress(done: Int, total: Int, failed: Int)
    }

    private val worker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "polishot-bridge").apply { isDaemon = true }
    }

    @JavascriptInterface
    fun ready() = submit("ready") { host.onReady() }

    @JavascriptInterface
    fun requestOcr(id: String?) = submit("requestOcr") {
        if (CaptureIds.isValid(id)) host.onRequestOcr(requireNotNull(id)) else reject("requestOcr", "bad id")
    }

    @JavascriptInterface
    fun saveImage(base64: String?, mime: String?, filename: String?) = submit("saveImage") {
        val normalized = BridgeValidation.normalizeMime(mime)
        if (normalized == null) {
            reject("saveImage", "unsupported type")
            return@submit
        }
        when (val check = BridgeValidation.decodeImage(base64, normalized)) {
            is ImageCheck.Ok -> {
                val name = BridgeValidation.sanitizeFilename(filename, check.image.mime, System.currentTimeMillis())
                host.onSaveImage(check.image, name)
            }
            is ImageCheck.Rejected -> reject("saveImage", check.reason)
        }
    }

    @JavascriptInterface
    fun shareImage(base64: String?, mime: String?) = submit("shareImage") {
        val normalized = BridgeValidation.normalizeMime(mime)
        if (normalized == null) {
            reject("shareImage", "unsupported type")
            return@submit
        }
        when (val check = BridgeValidation.decodeImage(base64, normalized)) {
            is ImageCheck.Ok -> host.onShareImage(check.image)
            is ImageCheck.Rejected -> reject("shareImage", check.reason)
        }
    }

    /** The contract passes PNG bytes only. */
    @JavascriptInterface
    fun copyImage(base64: String?) = submit("copyImage") {
        when (val check = BridgeValidation.decodeImage(base64, "image/png")) {
            is ImageCheck.Ok -> host.onCopyImage(check.image)
            is ImageCheck.Rejected -> reject("copyImage", check.reason)
        }
    }

    @JavascriptInterface
    fun copyText(text: String?) = submit("copyText") {
        val clean = BridgeValidation.sanitizeText(text)
        if (clean != null) host.onCopyText(clean) else reject("copyText", "empty text")
    }

    @JavascriptInterface
    fun saveDoc(id: String?, docJson: String?) = submit("saveDoc") {
        val valid = BridgeValidation.validateDocJson(id, docJson)
        if (valid != null) host.onSaveDoc(requireNotNull(id), valid) else reject("saveDoc", "invalid document")
    }

    @JavascriptInterface
    fun quickSend(base64: String?) = submit("quickSend") {
        when (val check = BridgeValidation.decodeImage(base64, "image/png")) {
            is ImageCheck.Ok -> host.onQuickSend(check.image)
            is ImageCheck.Rejected -> reject("quickSend", check.reason)
        }
    }

    @JavascriptInterface
    fun close() = submit("close") { host.onClose() }

    /** Added for batch beautify (see docs/CONTRACT-CHANGES.md): progress of `window.polishot.batch`. */
    @JavascriptInterface
    fun batchProgress(done: Int, total: Int, failed: Int) = submit("batchProgress") {
        val sane = total in 1..MAX_BATCH && done in 0..total && failed in 0..total
        if (sane) host.onBatchProgress(done, total, failed) else reject("batchProgress", "bad counts")
    }

    /** Lets queued jobs finish (a save in flight must not be cut off), then stops the worker. */
    fun shutdown() {
        worker.shutdown()
    }

    private fun submit(method: String, job: () -> Unit) {
        try {
            worker.execute {
                try {
                    job()
                } catch (e: Exception) {
                    // A failing host callback must never take the app down through the bridge thread.
                    Log.w(TAG, "$method failed: ${e.javaClass.simpleName}")
                }
            }
        } catch (e: RejectedExecutionException) {
            // The activity is gone; late calls from a dying page are ignored.
        }
    }

    private fun reject(method: String, reason: String) {
        Log.w(TAG, "rejected $method: $reason")
    }

    companion object {
        private const val TAG = "PolishotBridge"
        const val MAX_BATCH = 100
    }
}
