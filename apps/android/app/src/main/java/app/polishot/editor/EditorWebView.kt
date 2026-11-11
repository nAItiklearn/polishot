package app.polishot.editor

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.polishot.capture.CaptureIds
import app.polishot.capture.CaptureStore
import java.io.ByteArrayInputStream
import java.io.FileInputStream
import java.io.IOException
import java.util.Locale

/** URLs of the editor page and the images it loads. Only this one origin is ever reachable from the WebView. */
object EditorUrls {
    const val HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://$HOST"
    const val EDITOR_PAGE = "$ORIGIN/assets/editor/index.html"

    /** Content Security Policy of the editor page; see [EditorCsp] (a unit test keeps it equal to index.html). */
    const val CSP = EditorCsp.POLICY

    fun captureUrl(id: String): String {
        require(CaptureIds.isValid(id)) { "invalid capture id" }
        return "$ORIGIN/capture/$id.png"
    }

    fun isTrusted(uri: Uri): Boolean = uri.scheme == "https" && uri.host == HOST
}

/** Response headers common to everything we serve to the editor. */
private fun secureHeaders(extra: Map<String, String> = emptyMap()): Map<String, String> =
    mapOf("X-Content-Type-Options" to "nosniff", "Referrer-Policy" to "no-referrer") + extra

/**
 * Serves the `editor` folder of the APK's assets (URL prefix `/assets/editor/`). Unlike the stock
 * `AssetsPathHandler` this one has an explicit extension to MIME table, because `<script type="module">` is only
 * executed with a JavaScript MIME type, and it refuses anything outside `editor/` or containing traversal
 * sequences. (Kotlin block comments nest, so never write a slash followed by a star inside a comment.)
 */
class EditorAssetsHandler(private val context: Context) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        if (!isSafePath(path)) return null
        val mime = mimeFor(path) ?: return null
        return try {
            val stream = context.assets.open(path)
            val extra = if (mime == "text/html") mapOf("Content-Security-Policy" to EditorUrls.CSP) else emptyMap()
            WebResourceResponse(mime, if (isText(mime)) "utf-8" else null, 200, "OK", secureHeaders(extra), stream)
        } catch (e: IOException) {
            null
        }
    }

    companion object {
        private val SAFE_PATH = Regex("^editor/[A-Za-z0-9._/-]{1,200}$")

        fun isSafePath(path: String): Boolean =
            SAFE_PATH.matches(path) && !path.contains("..") && !path.contains("//")

        fun mimeFor(path: String): String? =
            when (path.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
                "html" -> "text/html"
                "js", "mjs" -> "text/javascript"
                "css" -> "text/css"
                "json" -> "application/json"
                "png" -> "image/png"
                "svg" -> "image/svg+xml"
                "webp" -> "image/webp"
                "ico" -> "image/x-icon"
                "ttf" -> "font/ttf"
                "otf" -> "font/otf"
                "woff" -> "font/woff"
                "woff2" -> "font/woff2"
                "txt" -> "text/plain"
                else -> null
            }

        private fun isText(mime: String): Boolean =
            mime.startsWith("text/") || mime == "application/json" || mime == "image/svg+xml"
    }
}

/** Serves `/capture/<id>.png` from app-private storage; ids are validated before any file is touched. */
class CapturePathHandler(private val store: CaptureStore) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        val id = CaptureIds.fromPngFileName(path) ?: return null
        val file = store.imageFile(id)
        if (!file.isFile) return null
        return try {
            WebResourceResponse(
                "image/png",
                null,
                200,
                "OK",
                secureHeaders(mapOf("Cache-Control" to "no-store")),
                FileInputStream(file),
            )
        } catch (e: IOException) {
            null
        }
    }
}

/**
 * Locks the WebView to [EditorUrls.ORIGIN]: every request to another host gets a 403 (so even a bug in the page
 * cannot reach the network), navigation is never allowed, and a crashed renderer is reported instead of killing
 * the app.
 */
class EditorWebViewClient(
    private val assetLoader: WebViewAssetLoader,
    private val onRendererGone: (didCrash: Boolean) -> Unit,
) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (!EditorUrls.isTrusted(uri)) return plainResponse(403, "Blocked")
        return assetLoader.shouldInterceptRequest(uri) ?: plainResponse(404, "Not Found")
    }

    // Links never navigate: the editor is a single page and has nothing to open externally.
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

    override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
        onRendererGone(detail.didCrash())
        return true
    }

    private fun plainResponse(status: Int, reason: String): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", status, reason, secureHeaders(), ByteArrayInputStream(ByteArray(0)))
}

/**
 * Receives `PolishotNative.postMessage(...)` from the editor page and forwards it to the [EditorBridge].
 *
 * The WebView only delivers messages from the origins this listener was registered for, and this class checks again:
 * the frame must be the main frame and the origin exactly the app's asset origin. Strings are JSON calls, array
 * buffers are images with a small header (see [BridgeMessages]); anything else is ignored.
 */
class EditorMessageListener(private val bridge: EditorBridge) : WebViewCompat.WebMessageListener {
    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        if (!isMainFrame || !EditorUrls.isTrusted(sourceOrigin)) return
        when (message.type) {
            WebMessageCompat.TYPE_STRING -> message.data?.let { bridge.onMessage(it) }
            WebMessageCompat.TYPE_ARRAY_BUFFER ->
                if (EditorWebViewFactory.supportsBinary()) bridge.onBinary(message.arrayBuffer)
        }
    }
}

object EditorWebViewFactory {
    /** Name of the JavaScript object the page uses to reach the app: `window.PolishotNative.postMessage(...)`. */
    const val NATIVE_NAME = "PolishotNative"

    /** Name of the legacy JavaScript interface, used only when the WebView cannot do web message listeners. */
    const val LEGACY_NAME = "PolishotAndroid"

    /** True when the WebView can deliver an ArrayBuffer (an image without base64) to a message listener. */
    fun supportsBinary(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)

    /**
     * Connects the page to [bridge]. Preferred: a web message listener restricted to the app's own origin, so only
     * pages served by [EditorAssetsHandler] can call the app, and only in the main frame. A WebView too old for that
     * gets the legacy `@JavascriptInterface` object instead. Returns true when the listener was installed.
     * Call before the first page load.
     */
    fun installBridge(webView: WebView, bridge: EditorBridge): Boolean {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, NATIVE_NAME, setOf(EditorUrls.ORIGIN), EditorMessageListener(bridge))
            return true
        }
        webView.addJavascriptInterface(bridge, LEGACY_NAME)
        return false
    }

    fun assetLoader(context: Context, store: CaptureStore): WebViewAssetLoader =
        WebViewAssetLoader.Builder()
            .setDomain(EditorUrls.HOST)
            .addPathHandler("/assets/", EditorAssetsHandler(context.applicationContext))
            .addPathHandler("/capture/", CapturePathHandler(store))
            .build()

    /** Applies the locked-down settings. JavaScript is on, but the only page that can ever load is ours. */
    @SuppressLint("SetJavaScriptEnabled")
    fun configure(webView: WebView, backgroundColor: Int, debuggable: Boolean) {
        webView.setBackgroundColor(backgroundColor)
        webView.overScrollMode = WebView.OVER_SCROLL_NEVER
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        with(webView.settings) {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // localStorage keeps the user's saved looks; it is scoped to the asset origin.
            domStorageEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            textZoom = 100
        }
        WebView.setWebContentsDebuggingEnabled(debuggable)
    }
}
