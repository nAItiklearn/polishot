package app.polishot.editor

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
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
import app.polishot.ocr.OcrMapping
import app.polishot.ocr.OcrWord
import app.polishot.polishotApp
import app.polishot.quicksend.QuickSendOutbox
import app.polishot.quicksend.SendToDeviceActivity
import app.polishot.settings.AppSettings
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Hosts the shared editor (apps/android/editor-host, built from packages/editor) in a locked-down WebView.
 *
 * Flow: the page loads from the asset origin and calls `PolishotAndroid.ready()`; native then sends the image URL,
 * the cached OCR words and the saved document with `window.polishot.load`, runs OCR if it has not run yet and
 * pushes the words with `setWords`. Exports come back through the bridge as validated base64 and are saved with
 * MediaStore, shared through FileProvider or copied to the clipboard.
 *
 * With [EXTRA_BATCH_IDS] the same page runs the batch beautify loop instead and reports progress.
 */
class EditorActivity : ComponentActivity(), EditorBridge.Host {
    private lateinit var webView: WebView
    private lateinit var bridge: EditorBridge
    private lateinit var exporter: ExportActions

    private var pageReady = false
    private var currentId: String? = null
    private var batchIds: List<String> = emptyList()
    private var currentWords: List<OcrWord>? = null
    private var ocrJob: Job? = null
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

        exporter = ExportActions(this)
        bridge = EditorBridge(this)

        val background = if (dark) BACKGROUND_DARK else BACKGROUND_LIGHT
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
        webView.addJavascriptInterface(bridge, BRIDGE_NAME)

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
                    if (pageReady) evaluate(JsCalls.setLicensed(entitlement.pro))
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
        val settings = app.settings.settings.value
        val dark = isDark(settings)
        val licensed = app.license.isPro
        lifecycleScope.launch {
            if (batchIds.isNotEmpty()) {
                val items = withContext(Dispatchers.IO) {
                    batchIds.mapNotNull { id ->
                        app.captures.readSize(id)?.let { (w, h) -> BatchItem(id, EditorUrls.captureUrl(id), w, h) }
                    }
                }
                if (items.isEmpty()) {
                    Toast.makeText(this@EditorActivity, R.string.editor_open_failed, Toast.LENGTH_LONG).show()
                    finish()
                    return@launch
                }
                evaluate(JsCalls.batch(items, app.settings.lastLookJson, licensed, themeName(dark), exportDefaults(settings)))
                return@launch
            }

            val id = currentId ?: return@launch
            val payload = withContext(Dispatchers.IO) { buildLoadPayload(id, settings, dark, licensed) }
            if (payload == null) {
                Toast.makeText(this@EditorActivity, R.string.editor_open_failed, Toast.LENGTH_LONG).show()
                finish()
                return@launch
            }
            currentWords = payload.words
            evaluate(JsCalls.load(payload))
            if (payload.words == null) startOcr(id)
        }
    }

    private suspend fun buildLoadPayload(id: String, settings: AppSettings, dark: Boolean, licensed: Boolean): LoadPayload? {
        val app = polishotApp
        val (width, height) = app.captures.readSize(id) ?: return null
        var entity = app.history.get(id)
        if (entity == null) {
            app.history.register(id, width, height)
            entity = app.history.get(id)
        }
        return LoadPayload(
            id = id,
            imageUrl = EditorUrls.captureUrl(id),
            width = width,
            height = height,
            licensed = licensed,
            theme = themeName(dark),
            words = entity?.wordsJson?.let { OcrMapping.fromJson(it) },
            docJson = entity?.docJson,
            exportDefaults = exportDefaults(settings),
            defaultPreset = settings.defaultPreset,
            quickSendAvailable = true,
        )
    }

    private fun startOcr(id: String) {
        ocrJob?.cancel()
        val app = polishotApp
        ocrJob = lifecycleScope.launch {
            val words: List<OcrWord> = try {
                val size = withContext(Dispatchers.IO) { app.captures.readSize(id) }
                if (size == null) {
                    emptyList()
                } else {
                    OcrEngine.recognize(app.captures.imageFile(id), size.first, size.second)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "OCR failed: ${e.javaClass.simpleName}") // never log recognised text
                emptyList()
            }
            if (currentId == id) {
                currentWords = words
                evaluate(JsCalls.setWords(words))
            }
            app.appScope.launch(Dispatchers.IO) { app.history.saveOcr(id, words) }
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
                cached != null -> evaluate(JsCalls.setWords(cached))
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
            runOnUiThread { startActivity(chooser) }
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
            app.history.saveDoc(id, docJson)
            LookExtractor.fromDocJson(docJson)?.let { app.settings.lastLookJson = it }
        }
    }

    override fun onQuickSend(image: DecodedImage) {
        // The "Send to" sheet takes the PNG from the outbox, lists paired devices and sends it.
        QuickSendOutbox.put(image.bytes)
        runOnUiThread { startActivity(SendToDeviceActivity.intent(this)) }
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

    companion object {
        private const val TAG = "PolishotEditor"
        private const val BRIDGE_NAME = "PolishotAndroid"
        private const val EXTRA_CAPTURE_ID = "app.polishot.extra.CAPTURE_ID"
        private const val EXTRA_BATCH_IDS = "app.polishot.extra.BATCH_IDS"

        /** Window colours from the brand palette (packages/brand), so no white flash while the page loads. */
        private const val BACKGROUND_LIGHT = 0xFFFAFAF9.toInt()
        private const val BACKGROUND_DARK = 0xFF0C0C0B.toInt()

        /** Opens one stored capture (already registered in the history). */
        fun intentFor(context: Context, captureId: String): Intent =
            Intent(context, EditorActivity::class.java).putExtra(EXTRA_CAPTURE_ID, captureId)

        /** Runs batch beautify over stored captures with the last-used look. */
        fun batchIntent(context: Context, captureIds: List<String>): Intent =
            Intent(context, EditorActivity::class.java).putStringArrayListExtra(EXTRA_BATCH_IDS, ArrayList(captureIds))
    }
}
