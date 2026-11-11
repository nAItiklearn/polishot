package app.polishot.quicksend

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.text.format.Formatter
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.polishot.APP_SLUG
import app.polishot.MainActivity
import app.polishot.R
import app.polishot.capture.CaptureStore
import app.polishot.capture.ImageRejectedException
import app.polishot.capture.ImageUnreadableException
import app.polishot.editor.EditorActivity
import app.polishot.history.HistoryRepository
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
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
 * A question waiting for the user, with the future that answers it. A prompt only ever clears itself: the identity
 * check in [PromptSlot.finish] means a prompt that timed out can never wipe the screen of the one that replaced it.
 */
internal class PromptSlot {
    private val lock = Any()
    private var current: CompletableFuture<Boolean>? = null

    /** Claims the slot. Returns null when another prompt is already waiting (the caller must refuse its request). */
    fun begin(): CompletableFuture<Boolean>? = synchronized(lock) {
        if (current != null) {
            null
        } else {
            CompletableFuture<Boolean>().also { current = it }
        }
    }

    /** Answers the waiting prompt, if any. */
    fun answer(value: Boolean) {
        val waiting = synchronized(lock) { current }
        waiting?.complete(value)
    }

    /** Releases the slot if [mine] still owns it. Returns true when it did. */
    fun finish(mine: CompletableFuture<Boolean>): Boolean = synchronized(lock) {
        if (current === mine) {
            current = null
            true
        } else {
            false
        }
    }
}

/**
 * Glue between the quick-send engine and the app: lifecycle (listen and advertise only while a quick-send screen is
 * visible), mDNS discovery, user prompts as state, and what happens to a received image (decoded by the platform
 * with size limits, stored privately, added to the history). One instance per process, owned by
 * [app.polishot.PolishotApp].
 *
 * Why a visible-screen listener and no foreground service: the protocol only wants the device reachable while the
 * receive or pairing screen is open (docs/QUICKSEND.md section 4), and a visible screen keeps the process in the
 * foreground by itself.
 *
 * Threading: nothing here blocks the main thread. Starting and stopping the listener, the Keystore reads and the key
 * generation behind them, and mDNS registration all run on one serialized background dispatcher; the screens only
 * count themselves in and out ([acquire], [release]) and the dispatcher reconciles the real state with the count.
 */
@OptIn(ExperimentalCoroutinesApi::class)
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
    private val offerSlot = PromptSlot()
    private val pairingSlot = PromptSlot()
    private val sendGate = AtomicBoolean(false)

    /** Runs lifecycle work one task at a time, in order, off the main thread. */
    private val serial = Dispatchers.IO.limitedParallelism(1)

    private var visibleScreens = 0
    private var running = false // only touched on [serial]

    /* ------------------------------------------------------------------------------------ lifecycle */

    /** A quick-send screen became visible: start listening, advertising and browsing (counted per screen). */
    @Synchronized
    fun acquire() {
        visibleScreens++
        reconcile()
    }

    /** The matching screen went away: stop everything when the last one has. */
    @Synchronized
    fun release() {
        if (visibleScreens == 0) return
        visibleScreens--
        if (visibleScreens == 0) {
            // Take effect at once, even before the background stop runs.
            engine.pairingOpen = false
            answerOffer(false)
            answerPairing(false)
        }
        reconcile()
    }

    @Synchronized
    private fun wanted(): Boolean = visibleScreens > 0

    /** Brings the real state (listener up or down) in line with the number of visible screens. */
    private fun reconcile() {
        scope.launch(serial) {
            val want = wanted()
            if (want && !running) startNow() else if (!want && running) stopNow()
        }
    }

    private fun startNow() {
        try {
            ensureChannel()
            val port = engine.startListening()
            val identity = store.identity()
            discovery.advertise(identity, Content.cleanDeviceName(deviceName()), port)
            discovery.startBrowsing(identity.id, this)
            running = true
            mutableState.update { it.copy(listening = true, ownName = deviceName()) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Bind failure, Keystore trouble, an NSD error: leave nothing half-started.
            engine.stopListening()
            discovery.stop()
            mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.Failed))
        }
        refresh()
    }

    private fun stopNow() {
        running = false
        engine.pairingOpen = false
        engine.stopListening()
        discovery.stop()
        synchronized(peers) { peers.clear() }
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
        // The advertisement carries the name, so republish it (off the main thread: it reads the identity).
        scope.launch(serial) {
            val port = engine.port ?: return@launch
            try {
                if (running) discovery.advertise(store.identity(), clean, port)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The old name stays advertised until the next start.
            }
        }
    }

    /* ------------------------------------------------------------------------------------ actions */

    fun pairWith(id: DeviceId) {
        val peer = synchronized(peers) { peers[id] } ?: return
        scope.launch(Dispatchers.IO) { engine.pairWith(peer.host, peer.port) }
    }

    fun removePair(id: DeviceId) {
        scope.launch(Dispatchers.IO) {
            try {
                store.removePair(id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.Failed))
            }
            refresh()
        }
    }

    fun answerOffer(accept: Boolean) = offerSlot.answer(accept)

    fun answerPairing(codesMatch: Boolean) = pairingSlot.answer(codesMatch)

    /**
     * Sends a PNG to the paired device [id], which must currently be visible on the network. The "sending" state is
     * set before this returns, so a second tap on the same button is ignored instead of starting a second transfer.
     */
    fun send(id: DeviceId, png: ByteArray) {
        if (!sendGate.compareAndSet(false, true)) return
        val name = mutableState.value.paired.firstOrNull { it.id == id }?.name.orEmpty()
        mutableState.update { it.copy(sending = SendProgress(name, 0L, png.size.toLong())) }
        scope.launch(Dispatchers.IO) {
            try {
                val peer = synchronized(peers) { peers[id] }
                val pair = store.pairFor(id)
                if (peer == null || pair == null) {
                    mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.Unreachable))
                    return@launch
                }
                val fileName = "$APP_SLUG-${System.currentTimeMillis()}.png"
                val outcome = engine.send(peer.host, peer.port, pair, fileName, "image/png", png)
                mutableEvents.tryEmit(
                    when (outcome) {
                        SendOutcome.Sent -> QuickSendEvent.Sent(pair.peerName)
                        is SendOutcome.Failed -> QuickSendEvent.Problem(outcome.kind)
                    },
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: OutOfMemoryError) {
                mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.TooLarge))
            } catch (e: Exception) {
                mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.Failed))
            } finally {
                mutableState.update { it.copy(sending = null) }
                sendGate.set(false)
            }
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
        val pairs = try {
            store.pairs()
        } catch (e: Exception) {
            return // secrets unavailable for the moment: keep what the screen shows
        }
        val pairedIds = pairs.map { it.peerId }.toSet()
        mutableState.update {
            it.copy(
                paired = pairs.map { p -> PairedDevice(p.peerId, p.peerName, snapshot.containsKey(p.peerId)) },
                nearby = snapshot.values.filter { p -> p.id !in pairedIds }.map { p -> NearbyDevice(p.id, p.name) },
            )
        }
    }

    /* ------------------------------------------------------------------------------------ engine prompts (worker threads) */

    override fun confirmOffer(offer: OfferInfo): Boolean {
        // Another offer is already on screen: decline this one rather than replace the prompt the user is reading.
        val answer = offerSlot.begin() ?: return false
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
            if (offerSlot.finish(answer)) {
                mutableState.update { it.copy(offer = null) }
                NotificationManagerCompat.from(context).cancel(NOTIFICATION_OFFER)
            }
        }
    }

    override fun confirmPairing(sas: String, peerName: String, peerId: DeviceId): Boolean {
        // A pairing is already waiting for its user: refuse this one (the peer sees a rejection).
        val answer = pairingSlot.begin() ?: return false
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
            if (pairingSlot.finish(answer)) mutableState.update { it.copy(pairing = null) }
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
        // The bytes passed the library's checks but are still untrusted: the platform decoder, with the size limits
        // in CaptureStore, is the gatekeeper. Nothing here may throw: this runs on a connection thread.
        try {
            val saved = captures.importBytes(file.data)
            runBlocking { history.register(saved.id, saved.width, saved.height) }
            val peerName = peerNameOf(file)
            notifyReceived(saved.id, peerName)
            mutableEvents.tryEmit(QuickSendEvent.Received(saved.id, peerName))
        } catch (e: ImageRejectedException) {
            mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.TooLarge))
        } catch (e: ImageUnreadableException) {
            mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.BadFile))
        } catch (e: IOException) {
            mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.Failed))
        } catch (e: OutOfMemoryError) {
            mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.TooLarge))
        } catch (e: Exception) {
            mutableEvents.tryEmit(QuickSendEvent.Problem(ProblemKind.Failed))
        }
    }

    private fun peerNameOf(file: ReceivedFile): String =
        try {
            store.pairFor(file.peerId)?.peerName
        } catch (e: Exception) {
            null
        } ?: context.getString(R.string.quicksend_unknown_device)

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
            EditorActivity.intentFor(context, captureId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
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
