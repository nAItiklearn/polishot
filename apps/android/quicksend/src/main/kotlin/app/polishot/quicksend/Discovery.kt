package app.polishot.quicksend

/** A device as advertised on the network. Everything here is an untrusted hint (spec section 4). */
class PeerAdvert(
    val id: DeviceId,
    val name: String,
    /** Advertised highest protocol version. */
    val version: Int,
)

/**
 * mDNS/DNS-SD record helpers that need no Android classes. The app registers and browses with `NsdManager`:
 * service type [Protocol.NSD_SERVICE_TYPE], service name = [instanceName], port = the listener's actual port,
 * and one attribute per entry of [txtAttributes]. `NsdServiceInfo.attributes` maps to [parseTxtBytes].
 */
object Discovery {

    /** The DNS-SD instance name: the device id string. */
    fun instanceName(id: DeviceId): String = id.toString()

    /** TXT records for an advertisement: `v`, `id`, `name`. */
    fun txtAttributes(id: DeviceId, name: String): Map<String, String> {
        Content.validateDeviceName(name)
        return linkedMapOf(
            "v" to Protocol.PROTOCOL_MAX.toString(),
            "id" to id.toString(),
            "name" to name,
        )
    }

    /** Parse and validate TXT records. Anything malformed throws a [QuickSendException]. */
    fun parseTxt(get: (String) -> String?): PeerAdvert {
        val v = get("v") ?: throw protocolError("advertisement has no version")
        val digits = v.trim()
        if (digits.isEmpty() || !digits.all { it in '0'..'9' }) {
            throw protocolError("advertisement version is not a number")
        }
        val version = digits.toIntOrNull() ?: throw protocolError("advertisement version out of range")
        if (version > 255) throw protocolError("advertisement version out of range")
        val id = DeviceId.parse(get("id") ?: throw protocolError("advertisement has no id"))
        val name = get("name") ?: throw protocolError("advertisement has no name")
        Content.validateDeviceName(name)
        return PeerAdvert(id, name, version)
    }

    /** Like [parseTxt] for `NsdServiceInfo.attributes` (values are raw bytes, decoded strictly as UTF-8). */
    fun parseTxtBytes(attributes: Map<String, ByteArray?>): PeerAdvert = parseTxt { key ->
        val raw = attributes[key]
        if (raw == null) null else decodeUtf8Strict(raw)
    }

    /** The device id from a service name, or null if it is not a valid id (such records are ignored). */
    fun idFromInstanceName(serviceName: String): DeviceId? =
        try {
            DeviceId.parse(serviceName.substringBefore('.'))
        } catch (e: QuickSendException) {
            null
        }
}
