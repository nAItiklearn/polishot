package app.polishot.license

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.GeneralSecurityException
import java.security.InvalidAlgorithmParameterException
import java.security.InvalidKeyException
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.IllegalBlockSizeException
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * How a failure to read a secret should be treated. Deleting a stored secret is irreversible (a licence key the user
 * paid for, the quick-send identity and every pairing), so it only happens when the secret can provably never be read
 * again. A busy or restarting Keystore, an I/O hiccup or any error that is not understood leaves the data alone and
 * is reported as temporarily unavailable.
 */
internal enum class SecretFailure {
    /** The data or its key is gone for good: invalidated key, wrong tag, corrupt blob. Safe to remove. */
    Permanent,

    /** May work next time. Keep the data. */
    Transient;

    companion object {
        fun classify(e: Throwable): SecretFailure =
            when (e) {
                // KeyPermanentlyInvalidatedException is an InvalidKeyException; AEADBadTagException is a
                // BadPaddingException.
                is InvalidKeyException,
                is UnrecoverableKeyException,
                is BadPaddingException,
                is IllegalBlockSizeException,
                is InvalidAlgorithmParameterException,
                is IllegalArgumentException,
                -> Permanent
                else -> Transient
            }
    }
}

/**
 * Keeps the licence key text encrypted with an AES-256-GCM key that lives in the Android Keystore (hardware
 * backed where available) and never leaves it. The ciphertext sits in a private SharedPreferences file that
 * is excluded from backups. This is the "Keystore-wrapped preference" option, chosen over the deprecated
 * EncryptedSharedPreferences so no extra dependency is needed.
 *
 * A secret that can never be decrypted again (key invalidated, data corrupt) is removed and reads as "nothing
 * stored". A failure that may pass (Keystore busy or unavailable) throws [SecretUnavailableException] and leaves
 * the data untouched; see [SecretFailure].
 */
class KeystoreSecretStore(
    private val appContext: Context,
    private val alias: String = DEFAULT_ALIAS,
    private val prefsName: String = PREFS_NAME,
) : SecretStore {
    // SharedPreferences are opened on first use, which is off the main thread (see LicenseManager).
    private val prefs: SharedPreferences by lazy {
        appContext.applicationContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
    }

    override fun read(): String? {
        val encoded = prefs.getString(KEY_BLOB, null) ?: return null
        val blob = try {
            Base64.decode(encoded, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            clear()
            return null
        }
        if (blob.size <= IV_LEN) {
            clear()
            return null
        }
        return try {
            decrypt(blob)
        } catch (e: Exception) {
            when (SecretFailure.classify(e)) {
                SecretFailure.Permanent -> {
                    clear()
                    null
                }
                SecretFailure.Transient -> throw SecretUnavailableException(e)
            }
        }
    }

    private fun decrypt(blob: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, blob, 0, IV_LEN))
        return String(cipher.doFinal(blob, IV_LEN, blob.size - IV_LEN), Charsets.UTF_8)
    }

    @Throws(GeneralSecurityException::class)
    override fun write(value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = cipher.iv
        val sealed = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        // commit(), not apply(): the caller is told the write failed instead of losing the secret silently.
        if (!prefs.edit().putString(KEY_BLOB, Base64.encodeToString(iv + sealed, Base64.NO_WRAP)).commit()) {
            throw SecretUnavailableException()
        }
    }

    override fun clear() {
        prefs.edit().remove(KEY_BLOB).apply()
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        /** Separate file and key for the quick-send identity, so licence and pairing secrets never share a blob. */
        const val QUICKSEND_ALIAS = "polishot.quicksend.v1"
        const val QUICKSEND_PREFS = "polishot_quicksend"

        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val DEFAULT_ALIAS = "polishot.license.v1"
        private const val PREFS_NAME = "polishot_license"
        private const val KEY_BLOB = "blob"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_LEN = 12
        private const val TAG_BITS = 128
    }
}
