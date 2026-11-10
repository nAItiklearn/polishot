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
import app.polishot.quicksend.QuickSendController
import app.polishot.quicksend.QuickSendStore
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
    val license: LicenseManager by lazy {
        LicenseManager(LicenseVerifier(), KeystoreSecretStore(this), BuildConfig.BUILD_DAYS)
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
        appScope.launch(Dispatchers.IO) { runCatching { history.sweepOrphans() } }
    }

    /**
     * The first WebView in a process pays for loading Chromium (about 250 ms). Creating one while the main thread
     * is idle at start-up means the editor opens at warm speed when the first capture arrives.
     */
    private fun prewarmWebView() {
        Handler(Looper.getMainLooper()).postDelayed(
            {
                try {
                    WebView(this).destroy()
                } catch (e: RuntimeException) {
                    // No WebView provider (or a test environment): the editor will report it when opened.
                }
            },
            PREWARM_DELAY_MILLIS,
        )
    }

    private companion object {
        const val PREWARM_DELAY_MILLIS = 800L
    }
}

/** The application object, from any context. */
val Context.polishotApp: PolishotApp
    get() = applicationContext as PolishotApp
