package app.polishot.quicksend

import app.polishot.license.SecretStore
import app.polishot.license.SecretUnavailableException
import java.util.Base64
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Keeps this device's long-term quick-send identity (a P-256 key pair) and the pair records of paired devices.
 * Both are secrets, so everything lives in one JSON document inside a [SecretStore] (an AES-GCM blob whose key is
 * in the Android Keystore):
 *
 *     { "v": 1, "identity": "<base64, 97 bytes>", "pairs": [ "<base64 PairRecord>", ... ] }
 *
 * The identity is created on first use. A document that is damaged for good is treated as empty and replaced, which
 * makes this device a new device (its former pairs must be redone), the safe outcome for a damaged secret. A
 * document that cannot be read *right now* ([SecretUnavailableException]: the Keystore is busy) is never replaced:
 * the exception propagates, so a hiccup cannot destroy the identity and every pairing with it.
 */
class QuickSendStore(private val secrets: SecretStore) {
    private class Data(val identity: Identity, val pairs: MutableList<PairRecord>)

    private var cache: Data? = null

    @Synchronized
    fun identity(): Identity = load().identity

    @Synchronized
    fun pairs(): List<PairRecord> = load().pairs.toList()

    @Synchronized
    fun pairFor(id: DeviceId): PairRecord? = load().pairs.firstOrNull { it.peerId == id }

    /** Adds [record], replacing any earlier pairing with the same device. */
    @Synchronized
    fun addPair(record: PairRecord) {
        val data = load()
        data.pairs.removeAll { it.peerId == record.peerId }
        data.pairs.add(record)
        while (data.pairs.size > MAX_PAIRS) data.pairs.removeAt(0)
        save(data)
    }

    @Synchronized
    fun removePair(id: DeviceId) {
        val data = load()
        if (data.pairs.removeAll { it.peerId == id }) save(data)
    }

    /** Forgets everything, including the identity. The next use creates a new one. */
    @Synchronized
    fun reset() {
        cache = null
        runCatching { secrets.clear() }
    }

    private fun load(): Data {
        cache?.let { return it }
        val data = read() ?: Data(Identity.generate(), ArrayList()).also { save(it) }
        cache = data
        return data
    }

    private fun read(): Data? {
        val text = try {
            secrets.read()
        } catch (e: SecretUnavailableException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return null
        return try {
            val json = JSONObject(text)
            if (json.getInt("v") != 1) return null
            val identity = Identity.fromBytes(decode(json.getString("identity")))
            val pairs = ArrayList<PairRecord>()
            val array = json.getJSONArray("pairs")
            for (i in 0 until array.length()) {
                try {
                    pairs.add(PairRecord.fromBytes(decode(array.getString(i))))
                } catch (e: QuickSendException) {
                    // One damaged record must not cost the user every other pairing.
                }
            }
            Data(identity, pairs)
        } catch (e: JSONException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        } catch (e: QuickSendException) {
            null
        }
    }

    private fun save(data: Data) {
        val pairs = JSONArray()
        for (p in data.pairs) pairs.put(encode(p.toBytes()))
        val json = JSONObject()
            .put("v", 1)
            .put("identity", encode(data.identity.toBytes()))
            .put("pairs", pairs)
        secrets.write(json.toString())
    }

    private fun encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    private fun decode(text: String): ByteArray = Base64.getDecoder().decode(text)

    companion object {
        const val MAX_PAIRS = 20
    }
}
