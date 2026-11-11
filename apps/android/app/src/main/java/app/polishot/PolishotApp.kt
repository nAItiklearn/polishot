package app.polishot

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import app.polishot.capture.CaptureStore
import app.polishot.history.HistoryDatabase
import app.polishot.history.HistoryRepository
import app.polishot.license.KeystoreSecretStore
import app.polishot.license.LicenseManager
import app.polishot.license.LicenseVerifier
import app.polishot.ocr.OcrEngine
import app.polishot.quicksend.QuickSendController
import app.polishot.quicksend.QuickSendStore
import app.polishot.settings.BrandLogoStore
import app.polishot.settings.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Process-wide singletons, created lazily so a cold start only pays for what the first screen needs.
 * Plain `lazy` properties instead of a DI framework: the graph is five objects.
 */
class PolishotApp : Application() {
    /** Outlives activities: used for persistence that must finish even while an editor is closing. */
    val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val settings: SettingsRepository by lazy { SettingsRepository(this) }
    val captures: CaptureStore by lazy { CaptureStore(this) }
    val history: HistoryRepository by lazy {
        HistoryRepository(HistoryDatabase.create(this).dao(), captures)
    }
    /** The Pro brand-mark logo (a small PNG in app-private storage). */
    val brandLogo: BrandLogoStore by lazy { BrandLogoStore(this) }
    // The stored key is read from the Keystore and verified on a background thread (appScope + IO); until that is
    // done the app is Free. Code that needs the real answer calls license.awaitPro().
    val license: LicenseManager by lazy {
        LicenseManager(LicenseVerifier(), KeystoreSecretStore(this), BuildConfig.BUILD_DAYS, appScope)
    }

    /** Quick send: identity and pairs in a Keystore-wrapped blob; listens only while a quick-send screen is visible. */
    val quickSend: QuickSendController by lazy {
        QuickSendController(
            context = this,
            store = QuickSendStore(
                KeystoreSecretStore(this, KeystoreSecretStore.QUICKSEND_ALIAS, KeystoreSecretStore.QUICKSEND_PREFS),
            ),
            captures = captures,
            history = history,
            scope = appScope,
            deviceName = { settings.deviceName },
            saveDeviceName = { settings.deviceName = it },
        )
    }

    override fun onCreate() {
        super.onCreate()
        prewarmWebView()
        appScope.launch(Dispatchers.IO) {
            // Start the slow, lazy parts away from the main thread: the licence check (Keystore, crypto), the
            // history database, and the text recognizer, so the first screen and the first capture find them ready.
            runCatching { license.entitlement.value }
            runCatching { history.sweepOrphans() }
            runCatching { OcrEngine.warmUp() }
        }
    }

    /**
     * The first WebView in a process pays for loading Chromium (about 250 ms). Creating one when the main thread has
     * nothing else to do, a moment after start-up, means the editor opens at warm speed when the first capture
     * arrives, without delaying the first frame of the home screen.
     */
    private fun prewarmWebView() {
        val handler = Handler(Looper.getMainLooper())
        handler.postDelayed(
            {
                // addIdleHandler runs the block when the message queue has drained, and only once (returns false).
                Looper.myQueue().addIdleHandler {
                    try {
                        WebView(this).destroy()
                    } catch (e: RuntimeException) {
                        // No WebView provider (or a test environment): the editor will report it when opened.
                    }
                    false
                }
            },
            PREWARM_DELAY_MILLIS,
        )
    }

    private companion object {
        const val PREWARM_DELAY_MILLIS = 400L
    }
}

/** The application object, from any context. */
val Context.polishotApp: PolishotApp
    get() = applicationContext as PolishotApp
