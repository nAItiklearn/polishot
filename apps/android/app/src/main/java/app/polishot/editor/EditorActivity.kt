package app.polishot.editor

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import app.polishot.R
import app.polishot.capture.CaptureIds
import app.polishot.capture.CaptureSession
import app.polishot.history.LookExtractor
import app.polishot.ocr.OcrEngine
import app.polishot.ocr.OcrWord
import app.polishot.polishotApp
import app.polishot.quicksend.QuickSendOutbox
import app.polishot.quicksend.SendToDeviceActivity
import app.polishot.settings.AppSettings
import app.polishot.settings.BrandMarkPayload
import app.polishot.ui.theme.WindowColors
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Hosts the shared editor (apps/android/editor-host, built from packages/editor) in a locked-down WebView.
 *
 * Flow: the page loads from the asset origin and calls `ready`; native then sends the image URL, the cached OCR words
 * and the saved document with `window.polishot.load`, runs OCR if it has not run yet and pushes the words with
 * `setWords`. Exports come back through the bridge as validated image bytes and are saved with MediaStore, shared
 * through FileProvider or copied to the clipboard.
 *
 * With [EXTRA_BATCH_IDS] the same page runs the batch beautify loop instead and reports progress.
 *
 * Nothing in here does disk, database or JSON work on the main thread: the request is assembled on background
 * dispatchers and only the final script is evaluated on the main thread. If the saved document or the cached words
 * cannot be read, the screenshot still opens (fresh, and OCR runs again).
 */
class EditorActivity : ComponentActivity(), EditorBridge.Host {
    private lateinit var webView: WebView
    private lateinit var bridge: EditorBridge
    private lateinit var exporter: ExportActions

    private var pageReady = false

    /** True when the page may send images as binary web messages instead of base64 text. */
    private var bridgeBinary = false
    private var currentId: String? = null
    private var batchIds: List<String> = emptyList()
    private var currentWords: List<OcrWord>? = null
    private var ocrJob: Job? = null
    private var deliverJob: Job? = null
    private var pendingChooser: ValueCallback<Array<Uri>>? = null

    private val imagePicker = registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        pendingChooser?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        pendingChooser = null
    }

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            if (!pageReady) {
                finish()
                return
            }
            // The page closes an open sheet first; only when it has nothing to close does back leave the editor.
            evaluate(JsCalls.onBack(), ValueCallback<String> { value -> if (value != "true") finish() })
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = polishotApp
        if (!readRequest(intent)) {
            Toast.makeText(this, R.string.editor_open_failed, Toast.LENGTH_LONG).show()
            finish()
            return
        }

        val dark = isDark(app.settings.settings.value)
        val bar = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark }
        enableEdgeToEdge(statusBarStyle = bar, navigationBarStyle = bar)
        val background = WindowColors.background(dark)
        window.setBackgroundDrawable(ColorDrawable(background))

        exporter = ExportActions(this)
        bridge = EditorBridge(this)

        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val loader = EditorWebViewFactory.assetLoader(this, app.captures)

        webView = WebView(this)
        EditorWebViewFactory.configure(webView, background, debuggable)
        webView.webViewClient = EditorWebViewClient(loader) { didCrash ->
            Log.w(TAG, "renderer gone, crashed=$didCrash")
            runOnUiThread {
                Toast.makeText(this, R.string.editor_renderer_gone, Toast.LENGTH_LONG).show()
                finish()
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            // The only file input in the page is the "background image" picker in the style inspector.
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                pendingChooser?.onReceiveValue(null)
                pendingChooser = filePathCallback
                imagePicker.launch("image/*")
                return true
            }
        }
        val usesMessages = EditorWebViewFactory.installBridge(webView, bridge)
        bridgeBinary = usesMessages && EditorWebViewFactory.supportsBinary()

        val root = FrameLayout(this)
        root.setBackgroundColor(background)
        root.addView(
            webView,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val types = WindowInsetsCompat.Type.systemBars() or
                WindowInsetsCompat.Type.displayCutout() or
                WindowInsetsCompat.Type.ime()
            val bars = insets.getInsets(types)
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        onBackPressedDispatcher.addCallback(this, backCallback)
        webView.loadUrl(EditorUrls.EDITOR_PAGE)

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                // `licensed` in the page means Pro: no watermark, brand mark, no free-tier limits (CONTRACTS 5b).
                app.license.entitlement.collect { entitlement ->
                    if (pageReady && app.license.isRestored) evaluate(JsCalls.setLicensed(entitlement.pro))
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (readRequest(intent) && pageReady) deliverRequest()
    }

    override fun onStart() {
        super.onStart()
        CaptureSession.setEditorVisible(true)
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) webView.onResume()
    }

    override fun onPause() {
        if (::webView.isInitialized) {
            // Let the page write a pending document edit before it is paused, then stop its extra processing.
            if (pageReady) evaluate(JsCalls.flush())
            webView.onPause()
        }
        super.onPause()
    }

    override fun onStop() {
        CaptureSession.setEditorVisible(false)
        super.onStop()
    }

    override fun onDestroy() {
        if (::bridge.isInitialized) bridge.shutdown()
        pendingChooser?.onReceiveValue(null)
        pendingChooser = null
        if (::webView.isInitialized) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    /* ---------------------------------------------------------------------------------------- */
    /* Native to page                                                                             */
    /* ---------------------------------------------------------------------------------------- */

    private fun readRequest(intent: Intent): Boolean {
        val batch = intent.getStringArrayListExtra(EXTRA_BATCH_IDS)
            ?.filter { CaptureIds.isValid(it) && polishotApp.captures.exists(it) }
            ?.take(EditorBridge.MAX_BATCH)
        if (!batch.isNullOrEmpty()) {
            batchIds = batch
            currentId = null
            currentWords = null
            return true
        }
        val id = intent.getStringExtra(EXTRA_CAPTURE_ID)
        if (id != null && CaptureIds.isValid(id) && polishotApp.captures.exists(id)) {
            batchIds = emptyList()
            currentId = id
            currentWords = null
            return true
        }
        return false
    }

    private fun evaluate(script: String, callback: ValueCallback<String>? = null) {
        if (isDestroyed || !::webView.isInitialized) return
        webView.evaluateJavascript(script, callback)
    }

    private fun deliverRequest() {
        val app = polishotApp
        deliverJob?.cancel()
        deliverJob = lifecycleScope.launch {
            try {
                val settings = app.settings.settings.value
                val dark = isDark(settings)
                // The stored key is checked off the main thread at start-up. Wait for the answer so the page never
                // gets a wrong "licensed" flag, which would put a watermark on a Pro export.
                val licensed = app.license.awaitPro()
                if (batchIds.isNotEmpty()) deliverBatch(settings, dark, licensed) else deliverSingle(settings, dark, licensed)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failToOpen(e.javaClass.simpleName)
            } catch (e: OutOfMemoryError) {
                failToOpen("OutOfMemoryError")
            }
        }
    }

    private suspend fun deliverBatch(settings: AppSettings, dark: Boolean, licensed: Boolean) {
        val app = polishotApp
        val ids = batchIds
        val script = withContext(Dispatchers.IO) {
            val items = ids.mapNotNull { id ->
                app.captures.readSize(id)?.let { (w, h) -> BatchItem(id, EditorUrls.captureUrl(id), w, h) }
            }
            if (items.isEmpty()) {
                null
            } else {
                JsCalls.batch(
                    items,
                    app.settings.lastLookJson,
                    licensed,
                    themeName(dark),
                    exportDefaults(settings),
                    brandMarkFor(settings, licensed),
                    bridgeBinary,
                )
            }
        }
        if (script == null) {
            failToOpen("no readable images")
            return
        }
        evaluate(script)
    }

    private suspend fun deliverSingle(settings: AppSettings, dark: Boolean, licensed: Boolean) {
        val id = currentId ?: return
        val payload = withContext(Dispatchers.IO) { buildLoadPayload(id, settings, dark, licensed) }
        if (payload == null) {
            failToOpen("unreadable capture")
            return
        }
        // JSON for the page can be a megabyte of words and a document: build it away from the main thread.
        val script = withContext(Dispatchers.Default) { JsCalls.load(payload) }
        currentWords = payload.words
        evaluate(script)
        if (payload.words == null) startOcr(id)
    }

    private fun failToOpen(reason: String) {
        Log.w(TAG, "could not open the capture: $reason")
        Toast.makeText(this, R.string.editor_open_failed, Toast.LENGTH_LONG).show()
        finish()
    }

    /**
     * Gathers everything the page needs, tolerating a damaged history row: an unreadable document or word list is
     * dropped (the repository clears it) and the screenshot opens fresh.
     */
    private suspend fun buildLoadPayload(id: String, settings: AppSettings, dark: Boolean, licensed: Boolean): LoadPayload? {
        val app = polishotApp
        val (width, height) = app.captures.readSize(id) ?: return null
        if (app.history.meta(id) == null) {
            try {
                app.history.register(id, width, height)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The screenshot is on disk; the history row can be added later.
            }
        }
        return LoadPayload(
            id = id,
            imageUrl = EditorUrls.captureUrl(id),
            width = width,
            height = height,
            licensed = licensed,
            theme = themeName(dark),
            words = app.history.words(id),
            docJson = app.history.docJson(id),
            exportDefaults = exportDefaults(settings),
            defaultPreset = settings.defaultPreset,
            quickSendAvailable = true,
            brandMark = brandMarkFor(settings, licensed),
            binaryImages = bridgeBinary,
        )
    }

    /** The Pro brand mark (name or logo) for the page, or null. Never sent unless the licence is Pro. Reads a file: call off the main thread. */
    private fun brandMarkFor(settings: AppSettings, licensed: Boolean): BrandMarkPayload? =
        if (licensed) settings.brandMarkPayload { polishotApp.brandLogo.dataUrl() } else null

    private fun startOcr(id: String) {
        ocrJob?.cancel()
        val app = polishotApp
        ocrJob = lifecycleScope.launch {
            // null = recognition failed; an empty list = it ran and found no text.
            val words: List<OcrWord>? = try {
                val size = withContext(Dispatchers.IO) { app.captures.readSize(id) }
                if (size == null) null else OcrEngine.recognize(app.captures.imageFile(id), size.first, size.second)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "OCR failed: ${e.javaClass.simpleName}") // never log recognised text
                null
            } catch (e: OutOfMemoryError) {
                Log.w(TAG, "OCR ran out of memory")
                null
            }
            if (currentId == id) {
                // The page stops waiting either way; on failure it simply finds no text.
                val shown = words ?: emptyList()
                currentWords = shown
                val script = withContext(Dispatchers.Default) { JsCalls.setWords(shown) }
                evaluate(script)
            }
            // Only a successful run is remembered: a failure is retried the next time the screenshot opens.
            if (words != null) {
                app.appScope.launch(Dispatchers.IO) {
                    try {
                        app.history.saveOcr(id, words)
                    } catch (e: Exception) {
                        Log.w(TAG, "could not store OCR words: ${e.javaClass.simpleName}")
                    }
                }
            }
        }
    }

    private fun notifyPage(kind: NotifyKind, message: String) {
        runOnUiThread { evaluate(JsCalls.notify(kind, message)) }
    }

    private fun isDark(settings: AppSettings): Boolean {
        val night = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return settings.theme.isDark(night == Configuration.UI_MODE_NIGHT_YES)
    }

    private fun themeName(dark: Boolean): String = if (dark) "dark" else "light"

    private fun exportDefaults(settings: AppSettings) =
        ExportDefaults(settings.exportFormat.id, settings.exportQuality / 100.0, settings.exportScale)

    /* ---------------------------------------------------------------------------------------- */
    /* Page to native (EditorBridge.Host, called on the bridge worker thread)                     */
    /* ---------------------------------------------------------------------------------------- */

    override fun onReady() {
        runOnUiThread {
            pageReady = true
            deliverRequest()
        }
    }

    override fun onRequestOcr(id: String) {
        runOnUiThread {
            if (id != currentId) return@runOnUiThread
            val cached = currentWords
            when {
                cached != null -> lifecycleScope.launch {
                    val script = withContext(Dispatchers.Default) { JsCalls.setWords(cached) }
                    evaluate(script)
                }
                ocrJob?.isActive != true -> startOcr(id)
            }
        }
    }

    override fun onSaveImage(image: DecodedImage, filename: String) {
        try {
            exporter.saveToGallery(image, filename)
            notifyPage(NotifyKind.Saved, getString(R.string.editor_saved))
        } catch (e: IOException) {
            notifyPage(NotifyKind.Error, getString(R.string.editor_save_failed))
        } catch (e: SecurityException) {
            notifyPage(NotifyKind.Error, getString(R.string.editor_save_failed))
        }
    }

    override fun onShareImage(image: DecodedImage) {
        try {
            val chooser = exporter.shareIntent(image)
            runOnUiThread {
                try {
                    startActivity(chooser)
                } catch (e: RuntimeException) {
                    notifyPage(NotifyKind.Error, getString(R.string.editor_share_failed))
                }
            }
            notifyPage(NotifyKind.Shared, "")
        } catch (e: IOException) {
            notifyPage(NotifyKind.Error, getString(R.string.editor_share_failed))
        }
    }

    override fun onCopyImage(image: DecodedImage) {
        try {
            exporter.copyImage(image)
            notifyPage(NotifyKind.Copied, getString(R.string.editor_copied_image))
        } catch (e: IOException) {
            notifyPage(NotifyKind.Error, getString(R.string.editor_copy_failed))
        }
    }

    override fun onCopyText(text: String) {
        try {
            exporter.copyText(text)
            notifyPage(NotifyKind.Copied, getString(R.string.editor_copied_text))
        } catch (e: RuntimeException) {
            notifyPage(NotifyKind.Error, getString(R.string.editor_copy_failed))
        }
    }

    override fun onSaveDoc(id: String, docJson: String) {
        val app = polishotApp
        app.appScope.launch(Dispatchers.IO) {
            try {
                app.history.saveDoc(id, docJson)
                LookExtractor.fromDocJson(docJson)?.let { app.settings.lastLookJson = it }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "could not store the document: ${e.javaClass.simpleName}")
            }
        }
    }

    override fun onQuickSend(image: DecodedImage) {
        // The "Send to" sheet takes the PNG from the outbox, lists paired devices and sends it.
        QuickSendOutbox.put(image.bytes)
        runOnUiThread {
            try {
                startActivity(SendToDeviceActivity.intent(this))
            } catch (e: RuntimeException) {
                QuickSendOutbox.clear()
                notifyPage(NotifyKind.Error, getString(R.string.editor_send_failed))
            }
        }
        notifyPage(NotifyKind.Shared, "") // lets the page leave its busy state
    }

    override fun onClose() {
        runOnUiThread { finish() }
    }

    override fun onBatchProgress(done: Int, total: Int, failed: Int) {
        if (done < total) return
        val app = polishotApp
        val ids = batchIds
        app.appScope.launch(Dispatchers.IO) { ids.forEach { app.captures.delete(it) } }
        runOnUiThread {
            val saved = total - failed
            val message = resources.getQuantityString(R.plurals.batch_done, saved, saved)
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            finish()
        }
    }

    /**
     * A call the user is waiting on was refused or failed. Tell the page right away so its busy state ends and it
     * shows a message, instead of spinning until its own timeout.
     */
    override fun onRejected(method: String) {
        val message = when (method) {
            "saveImage" -> R.string.editor_save_failed
            "shareImage" -> R.string.editor_share_failed
            "copyImage", "copyText" -> R.string.editor_copy_failed
            "quickSend" -> R.string.editor_send_failed
            else -> R.string.editor_generic_failed
        }
        notifyPage(NotifyKind.Error, getString(message))
    }

    companion object {
        private const val TAG = "PolishotEditor"
        private const val EXTRA_CAPTURE_ID = "app.polishot.extra.CAPTURE_ID"
        private const val EXTRA_BATCH_IDS = "app.polishot.extra.BATCH_IDS"

        /** Opens one stored capture (already registered in the history). */
        fun intentFor(context: Context, captureId: String): Intent =
            Intent(context, EditorActivity::class.java).putExtra(EXTRA_CAPTURE_ID, captureId)

        /** Runs batch beautify over stored captures with the last-used look. */
        fun batchIntent(context: Context, captureIds: List<String>): Intent =
            Intent(context, EditorActivity::class.java).putStringArrayListExtra(EXTRA_BATCH_IDS, ArrayList(captureIds))
    }
}
