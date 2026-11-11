package app.polishot

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import app.polishot.capture.CaptureService
import app.polishot.capture.CaptureSession
import app.polishot.editor.EditorActivity
import app.polishot.quicksend.QuickSendController
import app.polishot.quicksend.QuickSendEvent
import app.polishot.quicksend.problemMessage
import app.polishot.ui.quicksend.QuickSendScreen
import app.polishot.ui.capture.OverlayPermissionScreen
import app.polishot.ui.home.FileThumbnailLoader
import app.polishot.ui.home.HomeScreen
import app.polishot.ui.home.HomeState
import app.polishot.ui.license.LicenseScreen
import app.polishot.settings.BrandMarkMode
import app.polishot.ui.settings.SettingsScreen
import app.polishot.ui.theme.PolishotTheme
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private enum class Screen { Home, Settings, License, Overlay, QuickSend }

/**
 * Home: Capture, Open image, history. Settings, License and the explanation for the overlay permission are
 * screens inside this one activity.
 *
 * Capture flow: overlay permission (only when the floating button is on) -> notification permission (Android 13+)
 * -> the system screen-capture consent dialog -> a foreground capture session. The consent is asked again for every
 * session, as Android 14 and later require.
 */
class MainActivity : ComponentActivity() {
    private var screen by mutableStateOf(Screen.Home)
    private var localNetworkGranted by mutableStateOf(true)
    private var hasLogo by mutableStateOf(false)

    private val pickImage = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        if (uri != null) importAndOpen(uri)
    }

    private val pickLogo = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        if (uri != null) importLogo(uri)
    }

    private val consent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        onConsentResult(result.resultCode, result.data)
    }

    // Whatever the user answers, the capture itself does not need the notification permission.
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        requestConsent()
    }

    // Android 17 and later: reaching devices on the local network needs this runtime permission.
    private val localNetworkPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        localNetworkGranted = granted
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = polishotApp
        localNetworkGranted = !QuickSendController.needsLocalNetworkPermission ||
            ContextCompat.checkSelfPermission(this, QuickSendController.LOCAL_NETWORK_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED
        if (intent.getBooleanExtra(EXTRA_OPEN_QUICK_SEND, false)) screen = Screen.QuickSend
        val thumbnails = FileThumbnailLoader(app.captures)
        hasLogo = app.brandLogo.exists()

        setContent {
            val settings by app.settings.settings.collectAsStateWithLifecycle()
            val entitlement by app.license.entitlement.collectAsStateWithLifecycle()
            val sessionActive by CaptureSession.active.collectAsStateWithLifecycle()
            var query by rememberSaveable { mutableStateOf("") }
            val history = remember(query) { app.history.observe(query) }
            val items by history.collectAsStateWithLifecycle(initialValue = emptyList())
            val dark = settings.theme.isDark(isSystemInDarkTheme())

            DisposableEffect(dark) {
                val bars = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark }
                enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
                onDispose { }
            }
            BackHandler(enabled = screen != Screen.Home) { screen = Screen.Home }

            PolishotTheme(darkTheme = dark) {
                when (screen) {
                    Screen.Home -> HomeScreen(
                        state = HomeState(items = items, query = query, sessionActive = sessionActive),
                        thumbnails = thumbnails,
                        onCapture = this@MainActivity::startCaptureFlow,
                        onStopSession = { CaptureService.stop(this@MainActivity) },
                        onOpenImage = {
                            pickImage.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        },
                        onQuickSend = { screen = Screen.QuickSend },
                        onOpenItem = { id -> startActivity(EditorActivity.intentFor(this@MainActivity, id)) },
                        onDeleteItem = { id -> app.appScope.launch(Dispatchers.IO) { app.history.delete(id) } },
                        onClearAll = { app.appScope.launch(Dispatchers.IO) { app.history.clearAll() } },
                        onQueryChange = { query = it },
                        onSettings = { screen = Screen.Settings },
                        onLicense = { screen = Screen.License },
                    )
                    Screen.Settings -> SettingsScreen(
                        settings = settings,
                        pro = entitlement.pro,
                        hasLogo = hasLogo,
                        onChange = app.settings::update,
                        onPickLogo = {
                            pickLogo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        },
                        onRemoveLogo = {
                            app.brandLogo.remove()
                            hasLogo = false
                        },
                        onOpenLicense = { screen = Screen.License },
                        onBack = { screen = Screen.Home },
                    )
                    Screen.License -> LicenseScreen(
                        entitlement = entitlement,
                        onActivate = app.license::activate,
                        onDeactivate = app.license::deactivate,
                        onBack = { screen = Screen.Home },
                    )
                    Screen.QuickSend -> QuickSendRoute(
                        controller = app.quickSend,
                        permissionGranted = localNetworkGranted,
                        onRequestPermission = {
                            localNetworkPermission.launch(QuickSendController.LOCAL_NETWORK_PERMISSION)
                        },
                        onBack = { screen = Screen.Home },
                        onEvent = this@MainActivity::onQuickSendEvent,
                    )
                    Screen.Overlay -> OverlayPermissionScreen(
                        onAllow = this@MainActivity::openOverlaySettings,
                        onUseNotification = {
                            app.settings.update { it.copy(bubbleEnabled = false) }
                            screen = Screen.Home
                            startCaptureFlow()
                        },
                        onBack = { screen = Screen.Home },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_QUICK_SEND, false)) screen = Screen.QuickSend
    }

    override fun onResume() {
        super.onResume()
        // Back from the system "display over other apps" page with the permission granted: carry on capturing.
        if (screen == Screen.Overlay && Settings.canDrawOverlays(this)) {
            screen = Screen.Home
            startCaptureFlow()
        }
    }

    /* ---------------------------------------------------------------------------------------- */
    /* Capture                                                                                    */
    /* ---------------------------------------------------------------------------------------- */

    private fun startCaptureFlow() {
        val needsBubble = polishotApp.settings.settings.value.bubbleEnabled
        if (needsBubble && !Settings.canDrawOverlays(this)) {
            screen = Screen.Overlay
            return
        }
        val needsNotificationPermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        if (needsNotificationPermission) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            requestConsent()
        }
    }

    private fun requestConsent() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        consent.launch(manager.createScreenCaptureIntent())
    }

    private fun onConsentResult(resultCode: Int, data: Intent?) {
        if (resultCode != Activity.RESULT_OK || data == null) return
        CaptureService.start(this, resultCode, data)
        // Hand the screen back to whatever the user wants to capture.
        moveTaskToBack(true)
    }

    private fun openOverlaySettings() {
        val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
        try {
            startActivity(intent)
        } catch (e: RuntimeException) {
            Toast.makeText(this, R.string.overlay_settings_unavailable, Toast.LENGTH_LONG).show()
        }
    }

    /* ---------------------------------------------------------------------------------------- */
    /* Quick send                                                                                 */
    /* ---------------------------------------------------------------------------------------- */

    private fun onQuickSendEvent(event: QuickSendEvent) {
        when (event) {
            is QuickSendEvent.Received -> {
                toast(getString(R.string.quicksend_received, event.peerName))
                startActivity(EditorActivity.intentFor(this, event.captureId))
            }
            is QuickSendEvent.Paired -> {
                polishotApp.quickSend.setPairingOpen(false)
                toast(getString(R.string.quicksend_paired_with, event.peerName))
            }
            is QuickSendEvent.Sent -> toast(getString(R.string.quicksend_sent, event.peerName))
            is QuickSendEvent.Problem -> toast(getString(problemMessage(event.kind)))
        }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    /* ---------------------------------------------------------------------------------------- */
    /* Open image                                                                                 */
    /* ---------------------------------------------------------------------------------------- */

    private fun importAndOpen(uri: Uri) {
        val app = polishotApp
        lifecycleScope.launch {
            val saved = withContext(Dispatchers.IO) {
                try {
                    val s = app.captures.importFrom(contentResolver, uri)
                    app.history.register(s.id, s.width, s.height)
                    s
                } catch (e: IOException) {
                    null
                }
            }
            if (saved == null) {
                Toast.makeText(this@MainActivity, R.string.open_image_failed, Toast.LENGTH_LONG).show()
            } else {
                startActivity(EditorActivity.intentFor(this@MainActivity, saved.id))
            }
        }
    }

    /** Stores the picked image as the Pro brand-mark logo (scaled down, PNG) and switches the mark to it. */
    private fun importLogo(uri: Uri) {
        val app = polishotApp
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { app.brandLogo.import(contentResolver, uri) }
            if (ok) {
                hasLogo = true
                app.settings.update { it.copy(brandMarkMode = BrandMarkMode.Logo) }
            } else {
                Toast.makeText(this@MainActivity, R.string.brand_logo_failed, Toast.LENGTH_LONG).show()
            }
        }
    }

    companion object {
        /** Set by the "Send to" sheet when there is nobody to send to yet. */
        const val EXTRA_OPEN_QUICK_SEND = "app.polishot.extra.OPEN_QUICK_SEND"
    }
}

/**
 * The Quick send screen plus its lifecycle: the controller listens and advertises only while this screen is on
 * screen (between onStart and onStop) and the local-network permission is granted.
 */
@Composable
private fun QuickSendRoute(
    controller: QuickSendController,
    permissionGranted: Boolean,
    onRequestPermission: () -> Unit,
    onBack: () -> Unit,
    onEvent: (QuickSendEvent) -> Unit,
) {
    val state by controller.state.collectAsStateWithLifecycle()
    LifecycleStartEffect(permissionGranted) {
        if (permissionGranted) controller.acquire()
        onStopOrDispose { if (permissionGranted) controller.release() }
    }
    LaunchedEffect(controller) { controller.events.collect { onEvent(it) } }
    QuickSendScreen(
        state = state,
        needsPermission = !permissionGranted,
        onRequestPermission = onRequestPermission,
        onBack = onBack,
        onPairingOpen = controller::setPairingOpen,
        onPairWith = controller::pairWith,
        onRemove = controller::removePair,
        onRename = controller::rename,
        onAnswerOffer = controller::answerOffer,
        onAnswerPairing = controller::answerPairing,
    )
}
