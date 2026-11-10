package app.polishot.license

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Where the activated key text lives. The production store wraps it with an Android Keystore key. */
interface SecretStore {
    fun read(): String?
    fun write(value: String)
    fun clear()
}

/** Plain in-memory store, for tests and previews. */
class InMemorySecretStore(initial: String? = null) : SecretStore {
    private var value: String? = initial
    override fun read(): String? = value
    override fun write(value: String) {
        this.value = value
    }
    override fun clear() {
        value = null
    }
}

sealed interface ActivationResult {
    /** The key is genuine. [entitlement] says whether this build is covered by its update window. */
    data class Success(val entitlement: Entitlement) : ActivationResult
    data class Failure(val reason: InvalidReason) : ActivationResult
}

/**
 * Holds the entitlement for the whole app. A stored key is re-verified on every start, so tampering with the
 * stored text cannot unlock anything. [buildDays] is the build date of this app version (days since the Unix
 * epoch, `BuildConfig.BUILD_DAYS`): it decides whether the key's one-year update window covers this build.
 */
class LicenseManager(
    private val verifier: LicenseVerifier,
    private val store: SecretStore,
    private val buildDays: Long,
) {
    private val mutableEntitlement = MutableStateFlow(Entitlement.Free)
    val entitlement: StateFlow<Entitlement> = mutableEntitlement.asStateFlow()

    init {
        restore()
    }

    /** True when the editor should run without the watermark and without the free-tier limits. */
    val isPro: Boolean get() = mutableEntitlement.value.pro

    private fun restore() {
        val saved = runCatching { store.read() }.getOrNull()
        val next = Entitlements.evaluate(saved, verifier, buildDays)
        mutableEntitlement.value = next
        // A stored key that no longer verifies is dropped; an expired-but-genuine key is kept for the message.
        if (next.reason == EntitlementReason.Invalid) runCatching { store.clear() }
    }

    /** Verifies [raw] and, when genuine, stores it. */
    fun activate(raw: String): ActivationResult =
        when (val result = verifier.verify(raw)) {
            is VerifyResult.Valid -> {
                // A key that verifies is honoured for this run even if secure storage failed; the next start
                // will simply ask for it again.
                runCatching { store.write(raw.trim()) }
                val entitlement = Entitlements.forVerified(result.info, buildDays)
                mutableEntitlement.value = entitlement
                ActivationResult.Success(entitlement)
            }
            is VerifyResult.Invalid -> ActivationResult.Failure(result.reason)
        }

    fun deactivate() {
        runCatching { store.clear() }
        mutableEntitlement.value = Entitlement.Free
    }
}
