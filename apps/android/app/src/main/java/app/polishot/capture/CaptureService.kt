package app.polishot.capture

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import app.polishot.MainActivity
import app.polishot.R
import app.polishot.editor.EditorActivity
import app.polishot.polishotApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * One screen-capture session. The user grants MediaProjection once (the system consent dialog), the foreground
 * service holds it, and the floating bubble (or the notification's Capture action) grabs a single frame on demand.
 *
 * Android 14 and later rules, all handled here:
 *  - the token from the consent dialog works for one session only: a new session always asks for consent again,
 *    and `createVirtualDisplay` is called exactly once per projection (the display stays open for the session and
 *    frames are picked from it);
 *  - `MediaProjection.registerCallback` happens before `createVirtualDisplay`;
 *  - the mediaProjection foreground service is started before `getMediaProjection`.
 *
 * Pixels never leave the device: the frame is written to app-private storage and opened in the editor.
 */
class CaptureService : Service() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var workerThread: HandlerThread
    private lateinit var worker: Handler
    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    @Volatile private var projection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null
    @Volatile private var virtualDisplay: VirtualDisplay? = null
    @Volatile private var imageReader: ImageReader? = null
    private var displaySize = ScreenSize(0, 0, 0)
    private var visibilityJob: Job? = null

    private val frameLock = Any()
    private var latestImage: Image? = null
    private var latestAtMillis = 0L

    private var bubble: CaptureBubble? = null
    private var capturing = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        workerThread = HandlerThread("polishot-capture").also { it.start() }
        worker = Handler(workerThread.looper)
        NotificationManagerCompat.from(this).apply {
            createNotificationChannel(
                NotificationChannelCompat.Builder(CHANNEL_SESSION, NotificationManagerCompat.IMPORTANCE_LOW)
                    .setName(getString(R.string.capture_channel_session))
                    .setShowBadge(false)
                    .build(),
            )
            createNotificationChannel(
                NotificationChannelCompat.Builder(CHANNEL_READY, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                    .setName(getString(R.string.capture_channel_ready))
                    .build(),
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            stopSelf() // restarted by the system without a consent token: nothing to resume
            return START_NOT_STICKY
        }
        when (intent.action) {
            ACTION_START -> startSession(intent)
            ACTION_CAPTURE -> mainHandler.post { captureNow() }
            ACTION_STOP -> endSession()
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseProjection()
        bubble?.detach()
        bubble = null
        CaptureSession.setActive(false)
        uiScope.cancel()
        ioScope.cancel()
        workerThread.quitSafely()
        super.onDestroy()
    }

    /* ---------------------------------------------------------------------------------------- */
    /* Session                                                                                    */
    /* ---------------------------------------------------------------------------------------- */

    private fun startSession(intent: Intent) {
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
        val data = IntentCompat.getParcelableExtra(intent, EXTRA_CONSENT_DATA, Intent::class.java)
        if (resultCode != Activity.RESULT_OK || data == null) {
            stopSelf()
            return
        }

        try {
            // Must come first: on Android 14+ getMediaProjection() requires the running mediaProjection service.
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_SESSION,
                buildSessionNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } catch (e: RuntimeException) {
            Log.w(TAG, "foreground start refused: ${e.javaClass.simpleName}")
            toast(R.string.capture_failed)
            stopSelf()
            return
        }

        releaseProjection() // a second consent while a session runs replaces it
        try {
            val manager = getSystemService(MediaProjectionManager::class.java)
            // The framework annotates the result @Nullable on newer API levels; treat null like any other failure.
            val p = manager.getMediaProjection(resultCode, data)
                ?: throw IllegalStateException("MediaProjection unavailable")
            val callback = object : MediaProjection.Callback() {
                override fun onStop() {
                    // The user ended sharing from the system chip, or the system revoked it.
                    mainHandler.post { endSession() }
                }
            }
            p.registerCallback(callback, worker) // before createVirtualDisplay
            projection = p
            projectionCallback = callback
            openDisplay(p)
        } catch (e: RuntimeException) {
            Log.w(TAG, "projection setup failed: ${e.javaClass.simpleName}")
            toast(R.string.capture_failed)
            endSession()
            return
        }

        CaptureSession.setActive(true)
        showBubbleIfEnabled()
        visibilityJob?.cancel()
        visibilityJob = uiScope.launch {
            CaptureSession.editorVisible.collect { visible ->
                if (visible) {
                    bubble?.detach()
                } else if (!capturing) {
                    showBubbleIfEnabled()
                }
            }
        }
    }

    private fun endSession() {
        visibilityJob?.cancel()
        visibilityJob = null
        releaseProjection()
        bubble?.detach()
        bubble = null
        CaptureSession.setActive(false)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun releaseProjection() {
        synchronized(frameLock) {
            latestImage?.close()
            latestImage = null
            latestAtMillis = 0L
        }
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.setOnImageAvailableListener(null, null)
        imageReader?.close()
        imageReader = null
        val p = projection
        val cb = projectionCallback
        projection = null
        projectionCallback = null
        if (p != null) {
            if (cb != null) runCatching { p.unregisterCallback(cb) }
            runCatching { p.stop() }
        }
    }

    /* ---------------------------------------------------------------------------------------- */
    /* Display and frames                                                                         */
    /* ---------------------------------------------------------------------------------------- */

    private fun openDisplay(p: MediaProjection) {
        val size = ScreenMetrics.real(this)
        val reader = newReader(size)
        // createVirtualDisplay is called once per projection (Android 14+); later rotations resize it.
        virtualDisplay = p.createVirtualDisplay(
            "polishot-capture",
            size.width,
            size.height,
            size.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null,
            worker,
        )
        imageReader = reader
        displaySize = size
    }

    private fun newReader(size: ScreenSize): ImageReader {
        val reader = ImageReader.newInstance(size.width, size.height, PixelFormat.RGBA_8888, READER_BUFFERS)
        reader.setOnImageAvailableListener({ r -> onFrame(r) }, worker)
        return reader
    }

    /** Keeps only the newest frame; older ones are closed so the producer never stalls. */
    private fun onFrame(reader: ImageReader) {
        val image = try {
            reader.acquireLatestImage()
        } catch (e: IllegalStateException) {
            null
        } ?: return
        synchronized(frameLock) {
            latestImage?.close()
            latestImage = image
            latestAtMillis = SystemClock.uptimeMillis()
        }
    }

    /** After a rotation or fold the virtual display must match the screen again. Runs on the worker thread. */
    private fun resizeIfNeeded(): Boolean {
        val size = ScreenMetrics.real(this)
        if (size == displaySize || size.width <= 0 || size.height <= 0) return false
        val display = virtualDisplay ?: return false
        val oldReader = imageReader
        val reader = newReader(size)
        display.resize(size.width, size.height, size.densityDpi)
        display.surface = reader.surface
        imageReader = reader
        displaySize = size
        synchronized(frameLock) {
            latestImage?.close()
            latestImage = null
            latestAtMillis = 0L
        }
        oldReader?.setOnImageAvailableListener(null, null)
        oldReader?.close()
        return true
    }

    /* ---------------------------------------------------------------------------------------- */
    /* Capture                                                                                    */
    /* ---------------------------------------------------------------------------------------- */

    /** Main thread. Hides the bubble, waits for a frame without it, then saves and opens the editor. */
    private fun captureNow() {
        if (capturing || projection == null) return
        capturing = true
        bubble?.hideForCapture()
        val hiddenAt = SystemClock.uptimeMillis()
        worker.postDelayed({ grabFrame(hiddenAt, 0) }, SETTLE_MILLIS)
    }

    private fun grabFrame(hiddenAt: Long, attempt: Int) {
        if (projection == null) {
            finishCapture(null)
            return
        }
        if (resizeIfNeeded()) {
            // Frames from the old size are gone; wait for fresh ones.
            worker.postDelayed({ grabFrame(SystemClock.uptimeMillis(), attempt + 1) }, SETTLE_MILLIS)
            return
        }
        val bitmap: Bitmap? = synchronized(frameLock) {
            val image = latestImage
            val fresh = image != null && latestAtMillis >= hiddenAt + FRESH_GUARD_MILLIS
            // After the last attempt any frame is better than none (a perfectly static screen sends no new frame).
            if (image != null && (fresh || attempt >= MAX_ATTEMPTS)) FrameConverter.toBitmap(image) else null
        }
        if (bitmap != null) {
            saveAndOpen(bitmap)
        } else if (attempt < MAX_ATTEMPTS) {
            worker.postDelayed({ grabFrame(hiddenAt, attempt + 1) }, POLL_MILLIS)
        } else {
            finishCapture(null)
        }
    }

    private fun saveAndOpen(bitmap: Bitmap) {
        val app = polishotApp
        ioScope.launch {
            val id = try {
                val saved = app.captures.save(bitmap)
                app.history.register(saved.id, saved.width, saved.height)
                saved.id
            } catch (e: Exception) {
                Log.w(TAG, "saving the capture failed: ${e.javaClass.simpleName}")
                null
            } finally {
                bitmap.recycle()
            }
            mainHandler.post { finishCapture(id) }
        }
    }

    /** Main thread. [id] is the saved capture, or null when the grab failed. */
    private fun finishCapture(id: String?) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { finishCapture(id) }
            return
        }
        capturing = false
        if (id == null) {
            toast(R.string.capture_failed)
            bubble?.showAgain()
            return
        }
        try {
            // The (invisible) overlay window is still attached here, which is what lets a background service
            // start an activity on current Android versions.
            startActivity(EditorActivity.intentFor(this, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: RuntimeException) {
            Log.w(TAG, "editor launch refused: ${e.javaClass.simpleName}")
        }
        // Safety net: if the editor did not come to the front (background launch blocked), say so with a notification.
        mainHandler.postDelayed({
            if (!CaptureSession.editorVisible.value) postReadyNotification(id)
            bubble?.showAgain()
        }, FALLBACK_MILLIS)
    }

    private fun showBubbleIfEnabled() {
        if (projection == null) return
        val enabled = polishotApp.settings.settings.value.bubbleEnabled
        if (!enabled || !Settings.canDrawOverlays(this)) return
        val b = bubble ?: CaptureBubble(
            this,
            getSharedPreferences(BUBBLE_PREFS, Context.MODE_PRIVATE),
        ) { mainHandler.post { captureNow() } }.also { bubble = it }
        if (!b.attach()) {
            bubble = null
            toast(R.string.capture_bubble_unavailable)
        }
    }

    /* ---------------------------------------------------------------------------------------- */
    /* Notifications and toasts                                                                   */
    /* ---------------------------------------------------------------------------------------- */

    private fun buildSessionNotification(): Notification {
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            flags,
        )
        val capture = PendingIntent.getService(
            this,
            1,
            Intent(this, CaptureService::class.java).setAction(ACTION_CAPTURE),
            flags,
        )
        val stop = PendingIntent.getService(
            this,
            2,
            Intent(this, CaptureService::class.java).setAction(ACTION_STOP),
            flags,
        )
        val bubbleOn = polishotApp.settings.settings.value.bubbleEnabled
        return NotificationCompat.Builder(this, CHANNEL_SESSION)
            .setSmallIcon(R.drawable.ic_stat_capture)
            .setContentTitle(getString(R.string.capture_notification_title))
            .setContentText(
                getString(if (bubbleOn) R.string.capture_notification_text else R.string.capture_notification_text_no_bubble),
            )
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, getString(R.string.capture_action_capture), capture)
            .addAction(0, getString(R.string.capture_action_stop), stop)
            .build()
    }

    @SuppressLint("MissingPermission") // guarded by areNotificationsEnabled()
    private fun postReadyNotification(id: String) {
        val manager = NotificationManagerCompat.from(this)
        if (!manager.areNotificationsEnabled()) return
        val open = PendingIntent.getActivity(
            this,
            3,
            EditorActivity.intentFor(this, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_READY)
            .setSmallIcon(R.drawable.ic_stat_capture)
            .setContentTitle(getString(R.string.capture_ready_title))
            .setContentText(getString(R.string.capture_ready_text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        manager.notify(NOTIFICATION_READY, notification)
    }

    private fun toast(message: Int) {
        mainHandler.post { Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show() }
    }

    companion object {
        private const val TAG = "PolishotCapture"

        const val ACTION_START = "app.polishot.action.START_CAPTURE_SESSION"
        const val ACTION_CAPTURE = "app.polishot.action.CAPTURE_NOW"
        const val ACTION_STOP = "app.polishot.action.STOP_CAPTURE_SESSION"
        private const val EXTRA_RESULT_CODE = "app.polishot.extra.RESULT_CODE"
        private const val EXTRA_CONSENT_DATA = "app.polishot.extra.CONSENT_DATA"

        private const val CHANNEL_SESSION = "capture_session"
        private const val CHANNEL_READY = "capture_ready"
        private const val NOTIFICATION_SESSION = 1001
        private const val NOTIFICATION_READY = 1002
        private const val BUBBLE_PREFS = "polishot_bubble"

        private const val READER_BUFFERS = 3
        private const val SETTLE_MILLIS = 170L
        private const val POLL_MILLIS = 60L
        private const val FRESH_GUARD_MILLIS = 70L
        private const val MAX_ATTEMPTS = 8
        private const val FALLBACK_MILLIS = 1600L

        /**
         * Starts a session from the result of `MediaProjectionManager.createScreenCaptureIntent()`. Call from an
         * activity result callback (the app is in the foreground there, which Android 14+ requires).
         */
        fun start(context: Context, resultCode: Int, consentData: Intent) {
            val intent = Intent(context, CaptureService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_CONSENT_DATA, consentData)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, CaptureService::class.java).setAction(ACTION_STOP))
        }
    }
}
