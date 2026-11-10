package app.polishot.quicksend

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import android.text.format.Formatter
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.polishot.APP_SLUG
import app.polishot.MainActivity
import app.polishot.R
import app.polishot.capture.CaptureStore
import app.polishot.editor.EditorActivity
import app.polishot.history.HistoryRepository
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

data class PairedDevice(val id: DeviceId, val name: String, val nearby: Boolean)
data class NearbyDevice(val id: DeviceId, val name: String)
data class OfferPrompt(val peerName: String, val fileName: String, val sizeBytes: Long)
data class PairingPrompt(val code: String, val peerName: String)
data class SendProgress(val peerName: String, val done: Long, val total: Long)

/** Everything the quick-send screens draw. */
data class QuickSendState(
    val ownName: String,
    /** True while the listener is up and the device is advertised (a quick-send screen is visible). */
    val listening: Boolean = false,
    /** True while the pairing screen is open: only then can another device start pairing with this one. */
    val pairingOpen: Boolean = false,
    val paired: List<PairedDevice> = emptyList(),
    val nearby: List<NearbyDevice> = emptyList(),
    val offer: OfferPrompt? = null,
    val pairing: PairingPrompt? = null,
    val sending: SendProgress? = null,
)

/** One-off results to show as a toast and, for a received image, to open. */
sealed interface QuickSendEvent {
    data class Received(val captureId: String, val peerName: String) : QuickSendEvent
    data class Paired(val peerName: String) : QuickSendEvent
    data class Sent(val peerName: String) : QuickSendEvent
    data class Problem(val kind: ProblemKind) : QuickSendEvent
}

/**
 * Glue between the quick-send engine and the app: lifecycle (listen and advertise only while a quick-send screen is
 * visible), mDNS discovery, user prompts as state, and what happens to a received image (decoded by the platform,
 * stored privately, added to the history). One instance per process, owned by [app.polishot.PolishotApp].
 *
 * Why a visible-screen listener and no foreground service: the protocol only wants the device reachable while the
 * receive or pairing screen is open (docs/QUICKSEND.md section 4), and a visible screen keeps the process in the
 * foreground by itself.
 */
class QuickSendController(
    context: Context,
    private val store: QuickSendStore,
    private val captures: CaptureStore,
    private val history: HistoryRepository,
    private val scope: CoroutineScope,
    private val deviceName: () -> String,
    private val saveDeviceName: (String) -> Unit,
) : QuickSendEngine.Prompts, QuickSendDiscovery.Listener {
    private val context: Context = context.applicationContext
    private val engine = QuickSendEngine(store, this, ownName = { deviceName() })
    private val discovery = QuickSendDiscovery(this.context)

    private val mutableState = MutableStateFlow(QuickSendState(ownName = deviceName()))
    val state: StateFlow<QuickSendState> = mutableState.asStateFlow()

    private val mutableEvents = MutableSharedFlow<QuickSendEvent>(extraBufferCapacity = 16)
    val events: SharedFlow<QuickSendEvent> = mutableEvents.asSharedFlow()

    private val peers = LinkedHashMap<DeviceId, DiscoveredPeer>()
    @Volatile private var offerAnswer: CompletableFuture<Boolean>? = null
    @Volatile private var pairingAnswer: CompletableFuture<Boolean>? = null
    private var visibleScreens = 0

    /* ------------------------------------------------------------------------------------ lifecycle */

    /** A quick-send screen became visible: start listening, advertising and browsing (counted per screen). */
    @Synchronized
    fun acquire() {
        visibleScreens++
        if (visibleScreens > 1) return
        ensureChannel()
        try {
            val port = engine.startListening()
            val identity = store.identity()
            discovery.advertise(identity, Content.cleanDeviceName(deviceName()), port)
            discovery.startBrowsing(identity.id, this)
            mutableState.update { it.copy(listening = true, ownName = deviceName()) }
        } catch (e: IOException) {
            mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.Failed))
        } catch (e: RuntimeException) {
            mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.Failed))
        }
        refresh()
    }

    /** The matching screen went away: stop everything when the last one has. */
    @Synchronized
    fun release() {
        if (visibleScreens == 0) return
        visibleScreens--
        if (visibleScreens > 0) return
        engine.pairingOpen = false
        engine.stopListening()
        discovery.stop()
        synchronized(peers) { peers.clear() }
        answerOffer(false)
        answerPairing(false)
        mutableState.update { it.copy(listening = false, pairingOpen = false, nearby = emptyList()) }
        refresh()
    }

    fun setPairingOpen(open: Boolean) {
        engine.pairingOpen = open
        mutableState.update { it.copy(pairingOpen = open) }
    }

    fun rename(name: String) {
        val clean = Content.cleanDeviceName(name)
        saveDeviceName(clean)
        mutableState.update { it.copy(ownName = clean) }
        // The advertisement carries the name, so republish it.
        if (mutableState.value.listening) engine.port?.let { discovery.advertise(store.identity(), clean, it) }
    }

    /* ------------------------------------------------------------------------------------ actions */

    fun pairWith(id: DeviceId) {
        val peer = synchronized(peers) { peers[id] } ?: return
        scope.launch(Dispatchers.IO) { engine.pairWith(peer.host, peer.port) }
    }

    fun removePair(id: DeviceId) {
        store.removePair(id)
        refresh()
    }

    fun answerOffer(accept: Boolean) {
        offerAnswer?.complete(accept)
    }

    fun answerPairing(codesMatch: Boolean) {
        pairingAnswer?.complete(codesMatch)
    }

    /** Sends a PNG to the paired device [id], which must currently be visible on the network. */
    fun send(id: DeviceId, png: ByteArray) {
        scope.launch(Dispatchers.IO) {
            val peer = synchronized(peers) { peers[id] }
            val pair = store.pairFor(id)
            if (peer == null || pair == null) {
                mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.Unreachable))
                return@launch
            }
            mutableState.update { it.copy(sending = SendProgress(pair.peerName, 0L, png.size.toLong())) }
            val name = "$APP_SLUG-${System.currentTimeMillis()}.png"
            val outcome = engine.send(peer.host, peer.port, pair, name, "image/png", png)
            mutableState.update { it.copy(sending = null) }
            mutableEvents.tryEmit(
                when (outcome) {
                    SendOutcome.Sent -> QuickSendEvent.Sent(pair.peerName)
                    is SendOutcome.Failed -> QuickSendEvent.Problem(outcome.kind)
                },
            )
        }
    }

    /* ------------------------------------------------------------------------------------ discovery */

    override fun onPeerFound(peer: DiscoveredPeer) {
        synchronized(peers) { peers[peer.id] = peer }
        refresh()
    }

    override fun onPeerLost(id: DeviceId) {
        synchronized(peers) { peers.remove(id) }
        refresh()
    }

    private fun refresh() {
        val snapshot = synchronized(peers) { LinkedHashMap(peers) }
        val pairs = store.pairs()
        val pairedIds = pairs.map { it.peerId }.toSet()
        mutableState.update {
            it.copy(
                paired = pairedList(snapshot),
                nearby = snapshot.values.filter { p -> p.id !in pairedIds }.map { p -> NearbyDevice(p.id, p.name) },
            )
        }
    }

    private fun pairedList(visible: Map<DeviceId, DiscoveredPeer>): List<PairedDevice> =
        store.pairs().map { PairedDevice(it.peerId, it.peerName, visible.containsKey(it.peerId)) }

    /* ------------------------------------------------------------------------------------ engine prompts (worker threads) */

    override fun confirmOffer(offer: OfferInfo): Boolean {
        val answer = CompletableFuture<Boolean>()
        offerAnswer = answer
        mutableState.update { it.copy(offer = OfferPrompt(offer.peerName, offer.name, offer.size)) }
        notifyOffer(offer)
        return try {
            answer.get(OFFER_WAIT_SECONDS, TimeUnit.SECONDS)
        } catch (e: TimeoutException) {
            false
        } catch (e: ExecutionException) {
            false
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        } finally {
            offerAnswer = null
            mutableState.update { it.copy(offer = null) }
            NotificationManagerCompat.from(context).cancel(NOTIFICATION_OFFER)
        }
    }

    override fun confirmPairing(sas: String, peerName: String, peerId: DeviceId): Boolean {
        val answer = CompletableFuture<Boolean>()
        pairingAnswer = answer
        mutableState.update { it.copy(pairing = PairingPrompt(groupCode(sas), peerName)) }
        return try {
            answer.get(PAIRING_WAIT_SECONDS, TimeUnit.SECONDS)
        } catch (e: TimeoutException) {
            false
        } catch (e: ExecutionException) {
            false
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        } finally {
            pairingAnswer = null
            mutableState.update { it.copy(pairing = null) }
        }
    }

    override fun onPaired(record: PairRecord) {
        refresh()
        mutableEvents.tryEmit(QuickSendEvent.Paired(record.peerName))
    }

    override fun onProblem(kind: ProblemKind) {
        mutableEvents.tryEmit(QuickSendEvent.Problem(kind))
    }

    override fun onSendProgress(done: Long, total: Long) {
        mutableState.update { s -> s.sending?.let { s.copy(sending = it.copy(done = done, total = total)) } ?: s }
    }

    override fun onReceived(file: ReceivedFile) {
        // The bytes passed the library's checks but are still untrusted: the platform decoder is the gatekeeper.
        val bitmap = BitmapFactory.decodeByteArray(file.data, 0, file.data.size)
        if (bitmap == null) {
            mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.BadFile))
            return
        }
        try {
            val saved = captures.save(bitmap)
            runBlocking { history.register(saved.id, saved.width, saved.height) }
            val peerName = store.pairFor(file.peerId)?.peerName ?: context.getString(R.string.quicksend_unknown_device)
            notifyReceived(saved.id, peerName)
            mutableEvents.tryEmit(QuickSendEvent.Received(saved.id, peerName))
        } catch (e: IOException) {
            mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.Failed))
        } finally {
            bitmap.recycle()
        }
    }

    /* ------------------------------------------------------------------------------------ notifications */

    private fun ensureChannel() {
        NotificationManagerCompat.from(context).createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName(context.getString(R.string.quicksend_channel))
                .build(),
        )
    }

    @SuppressLint("MissingPermission") // guarded by areNotificationsEnabled()
    private fun notifyOffer(offer: OfferInfo) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        val open = PendingIntent.getActivity(
            context,
            10,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        manager.notify(
            NOTIFICATION_OFFER,
            NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_capture)
                .setContentTitle(context.getString(R.string.quicksend_offer_title))
                .setContentText(
                    context.getString(
                        R.string.quicksend_offer_body,
                        offer.peerName,
                        offer.name,
                        Formatter.formatShortFileSize(context, offer.size),
                    ),
                )
                .setContentIntent(open)
                .setAutoCancel(true)
                .setTimeoutAfter(OFFER_WAIT_SECONDS * 1000L)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .build(),
        )
    }

    @SuppressLint("MissingPermission") // guarded by areNotificationsEnabled()
    private fun notifyReceived(captureId: String, peerName: String) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        val open = PendingIntent.getActivity(
            context,
            11,
            EditorActivity.intentFor(context, captureId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        manager.notify(
            NOTIFICATION_RECEIVED,
            NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_capture)
                .setContentTitle(context.getString(R.string.quicksend_received, peerName))
                .setContentText(context.getString(R.string.capture_ready_text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .build(),
        )
    }

    companion object {
        private const val CHANNEL = "quicksend"
        private const val NOTIFICATION_OFFER = 2001
        private const val NOTIFICATION_RECEIVED = 2002

        /** The sender gives up after 60 s; answer "decline" before that. */
        private const val OFFER_WAIT_SECONDS = 45L

        /** The peer waits 120 s for the pairing decision. */
        private const val PAIRING_WAIT_SECONDS = 110L

        /** `123456` -> `123 456`, the form the protocol asks apps to show. */
        fun groupCode(sas: String): String = if (sas.length == 6) sas.substring(0, 3) + " " + sas.substring(3) else sas

        /** Android 17 (API 37) added a runtime permission for reaching devices on the local network. */
        val needsLocalNetworkPermission: Boolean get() = Build.VERSION.SDK_INT >= 37

        const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}
