package app.polishot.license

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Where the activated key text lives. The production store wraps it with an Android Keystore key.
 *
 * [read] returns null when nothing is stored, or when what was stored can never be read again (the Keystore key
 * was wiped, the data is corrupt); in the second case the store has already removed it. It throws
 * [SecretUnavailableException] when the secret cannot be read *right now* but may be later: the stored data is
 * untouched and the caller must not treat the secret as absent.
 */
interface SecretStore {
    fun read(): String?
    fun write(value: String)
    fun clear()
}

/** The secret exists but could not be read at this moment (for example the Keystore was busy). Nothing was deleted. */
class SecretUnavailableException(cause: Throwable? = null) : RuntimeException("secret temporarily unavailable", cause)

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
 *
 * Reading the key touches the Android Keystore and verifying it loads the cryptography provider, which is slow
 * enough to drop frames, so with a [restoreScope] the stored key is restored on [restoreDispatcher] while the
 * entitlement is [Entitlement.Free]. Anything that must know the real answer before it acts (the editor handing
 * its page a "licensed" flag, the share receiver sizing a batch) calls [awaitPro] / [awaitRestored]. Without a
 * scope (tests) the restore happens inside the constructor.
 *
 * If the user activates or removes a key before the restore finishes, that choice wins; the restore never
 * overwrites it.
 */
class LicenseManager(
    private val verifier: LicenseVerifier,
    private val store: SecretStore,
    private val buildDays: Long,
    restoreScope: CoroutineScope? = null,
    restoreDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val mutableEntitlement = MutableStateFlow(Entitlement.Free)
    val entitlement: StateFlow<Entitlement> = mutableEntitlement.asStateFlow()

    private val restored = CompletableDeferred<Unit>()
    private val lock = Any()
    private var decidedByUser = false

    init {
        if (restoreScope == null) {
            restoreOnce()
        } else {
            restoreScope.launch(restoreDispatcher) { restoreOnce() }
        }
    }

    /** True when the editor should run without the watermark and without the free-tier limits. */
    val isPro: Boolean get() = mutableEntitlement.value.pro

    /** True once the stored key (if any) has been checked. */
    val isRestored: Boolean get() = restored.isCompleted

    /** Suspends until the stored key has been checked. */
    suspend fun awaitRestored() = restored.await()

    /** The Pro flag after the stored key has been checked. */
    suspend fun awaitPro(): Boolean {
        awaitRestored()
        return isPro
    }

    private fun restoreOnce() {
        try {
            restore()
        } finally {
            restored.complete(Unit)
        }
    }

    private fun restore() {
        val saved = try {
            store.read()
        } catch (e: SecretUnavailableException) {
            return // try again on the next start; the key is still stored
        } catch (e: Exception) {
            return
        }
        val next = Entitlements.evaluate(saved, verifier, buildDays)
        synchronized(lock) {
            if (decidedByUser) return
            mutableEntitlement.value = next
        }
        // A stored key that no longer verifies is dropped; an expired-but-genuine key is kept for the message.
        if (next.reason == EntitlementReason.Invalid) {
            synchronized(lock) {
                if (!decidedByUser) runCatching { store.clear() }
            }
        }
    }

    /** Verifies [raw] and, when genuine, stores it. Does Keystore and crypto work: call it off the main thread. */
    fun activate(raw: String): ActivationResult =
        when (val result = verifier.verify(raw)) {
            is VerifyResult.Valid -> {
                val entitlement = Entitlements.forVerified(result.info, buildDays)
                synchronized(lock) {
                    decidedByUser = true
                    // A key that verifies is honoured for this run even if secure storage failed; the next start
                    // will simply ask for it again.
                    runCatching { store.write(raw.trim()) }
                    mutableEntitlement.value = entitlement
                }
                ActivationResult.Success(entitlement)
            }
            is VerifyResult.Invalid -> ActivationResult.Failure(result.reason)
        }

    fun deactivate() {
        synchronized(lock) {
            decidedByUser = true
            runCatching { store.clear() }
            mutableEntitlement.value = Entitlement.Free
        }
    }
}
