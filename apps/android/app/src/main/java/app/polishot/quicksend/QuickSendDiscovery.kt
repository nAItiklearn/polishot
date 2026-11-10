package app.polishot.quicksend

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.util.Log
import java.util.ArrayDeque

/** A device seen on the LAN. Everything here is an untrusted hint until a stored pair record vouches for it. */
data class DiscoveredPeer(val id: DeviceId, val name: String, val host: String, val port: Int)

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
        }
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
                    finishResolve(ownId, listener)
                }

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val advert = try {
                        Discovery.parseTxtBytes(serviceInfo.attributes)
                    } catch (e: QuickSendException) {
                        null // malformed record: ignored, as the protocol requires
                    }
                    val host = serviceInfo.host?.hostAddress
                    if (advert != null && advert.id != ownId && host != null && serviceInfo.port in 1..65535) {
                        listener.onPeerFound(DiscoveredPeer(advert.id, advert.name, host, serviceInfo.port))
                    }
                    finishResolve(ownId, listener)
                }
            },
        )
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
    }
}
