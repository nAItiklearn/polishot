package app.polishot.editor

import android.util.Log
import android.webkit.JavascriptInterface
import app.polishot.capture.CaptureIds
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import org.json.JSONException
import org.json.JSONObject

/**
 * What the editor page can ask the app to do (CONTRACTS section 6). Every call receives untrusted values: they are
 * validated by [BridgeValidation] on a single worker thread (so a large image never blocks the WebView's own thread,
 * and saves stay in order) and only then handed to the [Host] as typed values.
 *
 * Two transports reach the same code:
 *  - **messages** (preferred): the page calls `PolishotNative.postMessage(...)`; [EditorMessageListener] checks the
 *    origin and frame and forwards to [onMessage] (a JSON string) or [onBinary] (an ArrayBuffer carrying an image
 *    without base64 overhead). Only `https://appassets.androidplatform.net` can reach it.
 *  - **JavaScript interface** (fallback for a WebView too old for web message listeners): the `@JavascriptInterface`
 *    methods below, the original contract.
 *
 * Methods return nothing; results come back asynchronously through `window.polishot.notify`. A call that is
 * rejected, or fails, for an action the user is waiting on (save, share, copy, send) is reported to the host so the
 * page is told immediately and never spins.
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

        /** A call was rejected or failed. [method] is the bridge method name; the page may be waiting for an answer. */
        fun onRejected(method: String)
    }

    private val worker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "polishot-bridge").apply { isDaemon = true }
    }

    /* ---------------------------------------------------------------------------------------- */
    /* Transport 1: web messages                                                                  */
    /* ---------------------------------------------------------------------------------------- */

    /** A JSON message from `PolishotNative.postMessage(string)`. */
    fun onMessage(json: String) = submit("message") {
        val message = BridgeMessages.parse(json)
        if (message == null) {
            reject("message", "malformed message")
            return@submit
        }
        dispatch(message)
    }

    /** A binary message (header and image bytes) from `PolishotNative.postMessage(ArrayBuffer)`. */
    fun onBinary(bytes: ByteArray) = submit("binary") {
        val message = BridgeMessages.parseBinary(bytes)
        if (message == null) {
            reject("binary", "malformed message")
            return@submit
        }
        dispatch(message)
    }

    private fun dispatch(message: BridgeMessage) {
        when (message) {
            is BridgeMessage.Ready -> host.onReady()
            is BridgeMessage.RequestOcr -> handleRequestOcr(message.id)
            is BridgeMessage.SaveImage -> handleSaveImage(message.image, message.mime, message.filename)
            is BridgeMessage.ShareImage -> handleShareImage(message.image, message.mime)
            is BridgeMessage.CopyImage -> handleCopyImage(message.image)
            is BridgeMessage.CopyText -> handleCopyText(message.text)
            is BridgeMessage.SaveDoc -> handleSaveDoc(message.id, message.doc)
            is BridgeMessage.QuickSend -> handleQuickSend(message.image)
            is BridgeMessage.Close -> host.onClose()
            is BridgeMessage.BatchProgress -> handleBatchProgress(message.done, message.total, message.failed)
        }
    }

    /* ---------------------------------------------------------------------------------------- */
    /* Transport 2: JavaScript interface (fallback)                                               */
    /* ---------------------------------------------------------------------------------------- */

    @JavascriptInterface
    fun ready() = submit("ready") { host.onReady() }

    @JavascriptInterface
    fun requestOcr(id: String?) = submit("requestOcr") { handleRequestOcr(id) }

    @JavascriptInterface
    fun saveImage(base64: String?, mime: String?, filename: String?) =
        submit("saveImage") { handleSaveImage(ImagePayload.Base64(base64), mime, filename) }

    @JavascriptInterface
    fun shareImage(base64: String?, mime: String?) =
        submit("shareImage") { handleShareImage(ImagePayload.Base64(base64), mime) }

    /** The contract passes PNG bytes only. */
    @JavascriptInterface
    fun copyImage(base64: String?) = submit("copyImage") { handleCopyImage(ImagePayload.Base64(base64)) }

    @JavascriptInterface
    fun copyText(text: String?) = submit("copyText") { handleCopyText(text) }

    @JavascriptInterface
    fun saveDoc(id: String?, docJson: String?) = submit("saveDoc") { handleSaveDoc(id, docJson) }

    @JavascriptInterface
    fun quickSend(base64: String?) = submit("quickSend") { handleQuickSend(ImagePayload.Base64(base64)) }

    @JavascriptInterface
    fun close() = submit("close") { host.onClose() }

    /** Added for batch beautify (see docs/CONTRACT-CHANGES.md): progress of `window.polishot.batch`. */
    @JavascriptInterface
    fun batchProgress(done: Int, total: Int, failed: Int) =
        submit("batchProgress") { handleBatchProgress(done, total, failed) }

    /* ---------------------------------------------------------------------------------------- */
    /* Handlers (worker thread; both transports end up here)                                      */
    /* ---------------------------------------------------------------------------------------- */

    private fun handleRequestOcr(id: String?) {
        if (CaptureIds.isValid(id)) host.onRequestOcr(requireNotNull(id)) else reject("requestOcr", "bad id")
    }

    private fun handleSaveImage(image: ImagePayload, mime: String?, filename: String?) {
        val normalized = BridgeValidation.normalizeMime(mime)
        if (normalized == null) {
            reject("saveImage", "unsupported type")
            return
        }
        when (val check = image.check(normalized)) {
            is ImageCheck.Ok -> {
                val name = BridgeValidation.sanitizeFilename(filename, check.image.mime, System.currentTimeMillis())
                host.onSaveImage(check.image, name)
            }
            is ImageCheck.Rejected -> reject("saveImage", check.reason)
        }
    }

    private fun handleShareImage(image: ImagePayload, mime: String?) {
        val normalized = BridgeValidation.normalizeMime(mime)
        if (normalized == null) {
            reject("shareImage", "unsupported type")
            return
        }
        when (val check = image.check(normalized)) {
            is ImageCheck.Ok -> host.onShareImage(check.image)
            is ImageCheck.Rejected -> reject("shareImage", check.reason)
        }
    }

    private fun handleCopyImage(image: ImagePayload) {
        when (val check = image.check("image/png")) {
            is ImageCheck.Ok -> host.onCopyImage(check.image)
            is ImageCheck.Rejected -> reject("copyImage", check.reason)
        }
    }

    private fun handleCopyText(text: String?) {
        val clean = BridgeValidation.sanitizeText(text)
        if (clean != null) host.onCopyText(clean) else reject("copyText", "empty text")
    }

    private fun handleSaveDoc(id: String?, docJson: String?) {
        val valid = BridgeValidation.validateDocJson(id, docJson)
        if (valid != null) host.onSaveDoc(requireNotNull(id), valid) else reject("saveDoc", "invalid document")
    }

    private fun handleQuickSend(image: ImagePayload) {
        when (val check = image.check("image/png")) {
            is ImageCheck.Ok -> host.onQuickSend(check.image)
            is ImageCheck.Rejected -> reject("quickSend", check.reason)
        }
    }

    private fun handleBatchProgress(done: Int, total: Int, failed: Int) {
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
                } catch (e: OutOfMemoryError) {
                    // A very large image on a low-memory phone: tell the page instead of dying.
                    fail(method, "out of memory")
                } catch (e: Exception) {
                    // A failing host callback must never take the app down through the bridge thread.
                    fail(method, e.javaClass.simpleName)
                }
            }
        } catch (e: RejectedExecutionException) {
            // The activity is gone; late calls from a dying page are ignored.
        }
    }

    private fun fail(method: String, reason: String) {
        Log.w(TAG, "$method failed: $reason")
        notifyRejected(method)
    }

    private fun reject(method: String, reason: String) {
        Log.w(TAG, "rejected $method: $reason")
        notifyRejected(method)
    }

    private fun notifyRejected(method: String) {
        // Only calls the user is waiting on get an answer; a refused autosave or progress report is not news.
        if (method !in USER_WAITING_METHODS && method != "message" && method != "binary") return
        try {
            host.onRejected(method)
        } catch (e: Exception) {
            // Reporting must never throw back into the worker.
        }
    }

    companion object {
        private const val TAG = "PolishotBridge"
        const val MAX_BATCH = 100

        /** Bridge methods the user is waiting on; a rejection of one of these is shown to the user. */
        val USER_WAITING_METHODS: Set<String> = setOf("saveImage", "shareImage", "copyImage", "copyText", "quickSend")
    }
}

/** Where an image came from: base64 text (JavaScript interface, JSON message) or raw bytes (binary message). */
internal sealed interface ImagePayload {
    fun check(mime: String?): ImageCheck

    class Base64(private val text: String?) : ImagePayload {
        override fun check(mime: String?): ImageCheck = BridgeValidation.decodeImage(text, mime)
    }

    class Bytes(private val bytes: ByteArray) : ImagePayload {
        override fun check(mime: String?): ImageCheck = BridgeValidation.checkImageBytes(bytes, mime)
    }
}

/** A decoded call from the page. Image payloads are not validated yet; that happens in the handlers. */
internal sealed interface BridgeMessage {
    data object Ready : BridgeMessage
    data class RequestOcr(val id: String?) : BridgeMessage
    class SaveImage(val image: ImagePayload, val mime: String?, val filename: String?) : BridgeMessage
    class ShareImage(val image: ImagePayload, val mime: String?) : BridgeMessage
    class CopyImage(val image: ImagePayload) : BridgeMessage
    data class CopyText(val text: String?) : BridgeMessage
    data class SaveDoc(val id: String?, val doc: String?) : BridgeMessage
    class QuickSend(val image: ImagePayload) : BridgeMessage
    data object Close : BridgeMessage
    data class BatchProgress(val done: Int, val total: Int, val failed: Int) : BridgeMessage
}

/**
 * Wire format of the web-message transport. Pure Kotlin so it is unit tested without a WebView.
 *
 * Text message: a JSON object `{"m": "<method>", ...}` with the same arguments as the interface methods, using the
 * field names `id`, `mime`, `filename`, `base64`, `text`, `doc`, `done`, `total`, `failed`.
 *
 * Binary message (images without base64): `u32 big-endian header length | header | image bytes`, where the header is
 * UTF-8 JSON `{"m": "saveImage"|"shareImage"|"copyImage"|"quickSend", "mime": "...", "filename": "..."}`.
 */
internal object BridgeMessages {
    /** The largest text message: an image as base64 plus a little framing. */
    const val MAX_MESSAGE_CHARS: Int = BridgeValidation.MAX_BASE64_CHARS + 64 * 1024
    const val MAX_HEADER_BYTES: Int = 2048

    fun parse(json: String): BridgeMessage? {
        if (json.length > MAX_MESSAGE_CHARS) return null
        val obj = try {
            JSONObject(json)
        } catch (e: JSONException) {
            return null
        }
        val method = obj.optString("m", "")
        return when (method) {
            "ready" -> BridgeMessage.Ready
            "requestOcr" -> BridgeMessage.RequestOcr(obj.optStringOrNull("id"))
            "saveImage" -> BridgeMessage.SaveImage(
                ImagePayload.Base64(obj.optStringOrNull("base64")),
                obj.optStringOrNull("mime"),
                obj.optStringOrNull("filename"),
            )
            "shareImage" -> BridgeMessage.ShareImage(ImagePayload.Base64(obj.optStringOrNull("base64")), obj.optStringOrNull("mime"))
            "copyImage" -> BridgeMessage.CopyImage(ImagePayload.Base64(obj.optStringOrNull("base64")))
            "copyText" -> BridgeMessage.CopyText(obj.optStringOrNull("text"))
            "saveDoc" -> BridgeMessage.SaveDoc(obj.optStringOrNull("id"), obj.optStringOrNull("doc"))
            "quickSend" -> BridgeMessage.QuickSend(ImagePayload.Base64(obj.optStringOrNull("base64")))
            "close" -> BridgeMessage.Close
            "batchProgress" -> BridgeMessage.BatchProgress(
                obj.optInt("done", -1),
                obj.optInt("total", -1),
                obj.optInt("failed", -1),
            )
            else -> null
        }
    }

    fun parseBinary(bytes: ByteArray): BridgeMessage? {
        if (bytes.size < 4) return null
        val headerLength = ((bytes[0].toInt() and 0xFF) shl 24) or ((bytes[1].toInt() and 0xFF) shl 16) or
            ((bytes[2].toInt() and 0xFF) shl 8) or (bytes[3].toInt() and 0xFF)
        if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || 4L + headerLength >= bytes.size) return null
        val header = try {
            JSONObject(String(bytes, 4, headerLength, Charsets.UTF_8))
        } catch (e: JSONException) {
            return null
        }
        val image = ImagePayload.Bytes(bytes.copyOfRange(4 + headerLength, bytes.size))
        val mime = header.optStringOrNull("mime")
        return when (header.optString("m", "")) {
            "saveImage" -> BridgeMessage.SaveImage(image, mime, header.optStringOrNull("filename"))
            "shareImage" -> BridgeMessage.ShareImage(image, mime)
            "copyImage" -> BridgeMessage.CopyImage(image)
            "quickSend" -> BridgeMessage.QuickSend(image)
            else -> null
        }
    }

    private fun JSONObject.optStringOrNull(name: String): String? =
        if (has(name) && !isNull(name)) optString(name) else null
}
