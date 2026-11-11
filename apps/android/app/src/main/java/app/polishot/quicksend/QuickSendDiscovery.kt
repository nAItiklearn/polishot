package app.polishot.quicksend

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.net.Inet4Address
import java.net.InetAddress
import java.util.ArrayDeque

/** A device seen on the LAN. Everything here is an untrusted hint until a stored pair record vouches for it. */
data class DiscoveredPeer(val id: DeviceId, val name: String, val host: String, val port: Int)

/**
 * Chooses the address to connect to from what mDNS resolved. A device usually answers with several (IPv4, IPv6 with
 * and without a link-local scope); IPv4 is preferred because it needs no scope id and every home network has it.
 * Loopback, wildcard, multicast and link-local addresses are never used: a peer that advertises them is either broken
 * or trying to point us at this phone itself. Pure, so it is covered by JVM tests.
 */
internal object NsdAddresses {
    fun pick(candidates: List<InetAddress>): InetAddress? {
        val usable = candidates.filter { !it.isLoopbackAddress && !it.isAnyLocalAddress && !it.isMulticastAddress }
        usable.firstOrNull { it is Inet4Address && !it.isLinkLocalAddress }?.let { return it }
        return usable.firstOrNull { !it.isLinkLocalAddress }
    }
}

/**
 * mDNS / DNS-SD for quick send (docs/QUICKSEND.md section 4) on top of the platform [NsdManager]. The record layout
 * and its validation come from the protocol library ([Discovery]): service type `_polishot._tcp.`, instance name =
 * the device id string, TXT `v`, `id` and `name`. Records that fail validation, and our own, are ignored.
 *
 * Advertise only while the receive or pairing screen is open; browse only while a target is being chosen. While
 * browsing, a Wi-Fi multicast lock is held, which some devices need to receive mDNS replies.
 *
 * Nothing here logs peer names or addresses.
 */
class QuickSendDiscovery(context: Context) {
    interface Listener {
        fun onPeerFound(peer: DiscoveredPeer)
        fun onPeerLost(id: DeviceId)
    }

    private val appContext: Context = context.applicationContext
    private val nsd: NsdManager = appContext.getSystemService(NsdManager::class.java)

    private var registration: NsdManager.RegistrationListener? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private var multicastLock: WifiManager.MulticastLock? = null

    // NsdManager resolves one service at a time, so found services wait in a queue.
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private val lock = Any()

    // A resolve can fail while the platform is busy with another one; it is tried again a few times.
    private val retryHandler = Handler(Looper.getMainLooper())
    private val attempts = HashMap<String, Int>()

    /** Publishes this device. [listenPort] is the port the listener is bound to. */
    fun advertise(identity: Identity, deviceName: String, listenPort: Int) {
        require(listenPort in 1..65535) { "invalid port" }
        stopAdvertising()
        val info = NsdServiceInfo().apply {
            serviceName = Discovery.instanceName(identity.id)
            serviceType = Protocol.NSD_SERVICE_TYPE
            port = listenPort
            for ((key, value) in Discovery.txtAttributes(identity.id, deviceName)) setAttribute(key, value)
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "mDNS registration failed: $errorCode")
            }

            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) = Unit
            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) = Unit
        }
        registration = listener
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    fun stopAdvertising() {
        val listener = registration ?: return
        registration = null
        runCatching { nsd.unregisterService(listener) }
    }

    /** Starts browsing; invalid records and [ownId] are never reported. */
    fun startBrowsing(ownId: DeviceId, listener: Listener) {
        stopBrowsing()
        acquireMulticastLock()
        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "mDNS discovery failed to start: $errorCode")
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                synchronized(lock) { resolveQueue.add(serviceInfo) }
                resolveNext(ownId, listener)
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                Discovery.idFromInstanceName(serviceInfo.serviceName)?.let { listener.onPeerLost(it) }
            }
        }
        discovery = discoveryListener
        nsd.discoverServices(Protocol.NSD_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
    }

    fun stopBrowsing() {
        val listener = discovery
        discovery = null
        synchronized(lock) {
            resolveQueue.clear()
            resolving = false
            attempts.clear()
        }
        retryHandler.removeCallbacksAndMessages(null)
        if (listener != null) runCatching { nsd.stopServiceDiscovery(listener) }
        releaseMulticastLock()
    }

    fun stop() {
        stopAdvertising()
        stopBrowsing()
    }

    @Suppress("DEPRECATION") // resolveService is deprecated on API 34 but works on every supported release
    private fun resolveNext(ownId: DeviceId, listener: Listener) {
        val next = synchronized(lock) {
            if (resolving) return
            val item = resolveQueue.poll() ?: return
            resolving = true
            item
        }
        nsd.resolveService(
            next,
            object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    val key = serviceInfo.serviceName.orEmpty()
                    val tries = synchronized(lock) { (attempts[key] ?: 0).also { attempts[key] = it + 1 } }
                    if (tries < MAX_RESOLVE_RETRIES && discovery != null) {
                        // Put it back at the end of the queue after a short pause.
                        retryHandler.postDelayed({
                            if (discovery != null) {
                                synchronized(lock) { resolveQueue.add(serviceInfo) }
                                resolveNext(ownId, listener)
                            }
                        }, RESOLVE_RETRY_MILLIS * (tries + 1))
                    }
                    finishResolve(ownId, listener)
                }

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val advert = try {
                        Discovery.parseTxtBytes(serviceInfo.attributes)
                    } catch (e: QuickSendException) {
                        null // malformed record: ignored, as the protocol requires
                    }
                    val host = addressOf(serviceInfo)
                    synchronized(lock) { attempts.remove(serviceInfo.serviceName.orEmpty()) }
                    if (advert != null && advert.id != ownId && host != null && serviceInfo.port in 1..65535) {
                        listener.onPeerFound(DiscoveredPeer(advert.id, advert.name, host, serviceInfo.port))
                    }
                    finishResolve(ownId, listener)
                }
            },
        )
    }

    @Suppress("DEPRECATION") // NsdServiceInfo.host is the only choice before API 34
    private fun addressOf(info: NsdServiceInfo): String? {
        val candidates: List<InetAddress> =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                info.hostAddresses
            } else {
                listOfNotNull(info.host)
            }
        return NsdAddresses.pick(candidates)?.hostAddress
    }

    private fun finishResolve(ownId: DeviceId, listener: Listener) {
        synchronized(lock) { resolving = false }
        resolveNext(ownId, listener)
    }

    private fun acquireMulticastLock() {
        if (multicastLock != null) return
        val wifi = appContext.getSystemService(WifiManager::class.java) ?: return
        multicastLock = wifi.createMulticastLock("polishot-quicksend").apply {
            setReferenceCounted(false)
            runCatching { acquire() }
        }
    }

    private fun releaseMulticastLock() {
        multicastLock?.let { held -> runCatching { if (held.isHeld) held.release() } }
        multicastLock = null
    }

    private companion object {
        const val TAG = "PolishotQuickSend"
        const val MAX_RESOLVE_RETRIES = 3
        const val RESOLVE_RETRY_MILLIS = 400L
    }
}
