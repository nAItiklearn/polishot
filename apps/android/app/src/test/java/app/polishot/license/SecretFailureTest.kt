package app.polishot.license

import java.io.IOException
import java.security.GeneralSecurityException
import java.security.InvalidAlgorithmParameterException
import java.security.InvalidKeyException
import java.security.KeyStoreException
import java.security.NoSuchAlgorithmException
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.BadPaddingException
import javax.crypto.IllegalBlockSizeException
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Deleting a stored secret cannot be undone, so only failures that prove it can never be read again are permanent.
 * Everything else, including every error this code does not recognise, keeps the data.
 */
class SecretFailureTest {
    private fun classify(e: Throwable) = SecretFailure.classify(e)

    @Test
    fun `a wiped or invalidated key is permanent`() {
        assertEquals(SecretFailure.Permanent, classify(InvalidKeyException("KeyPermanentlyInvalidated")))
        assertEquals(SecretFailure.Permanent, classify(UnrecoverableKeyException()))
    }

    @Test
    fun `data that fails authentication or is the wrong shape is permanent`() {
        assertEquals(SecretFailure.Permanent, classify(AEADBadTagException()))
        assertEquals(SecretFailure.Permanent, classify(BadPaddingException()))
        assertEquals(SecretFailure.Permanent, classify(IllegalBlockSizeException()))
        assertEquals(SecretFailure.Permanent, classify(InvalidAlgorithmParameterException()))
    }

    @Test
    fun `an undecodable blob is permanent`() {
        assertEquals(SecretFailure.Permanent, classify(IllegalArgumentException("bad base64")))
        assertEquals(SecretFailure.Permanent, classify(NumberFormatException()))
    }

    @Test
    fun `a busy or restarting Keystore is transient`() {
        assertEquals(SecretFailure.Transient, classify(KeyStoreException("keystore busy")))
        assertEquals(SecretFailure.Transient, classify(ProviderException("keystore died")))
        assertEquals(SecretFailure.Transient, classify(IllegalStateException("not ready")))
    }

    @Test
    fun `io trouble and unknown errors are transient`() {
        assertEquals(SecretFailure.Transient, classify(IOException("disk")))
        assertEquals(SecretFailure.Transient, classify(RuntimeException()))
        assertEquals(SecretFailure.Transient, classify(SecurityException()))
        assertEquals(SecretFailure.Transient, classify(GeneralSecurityException()))
        assertEquals(SecretFailure.Transient, classify(NoSuchAlgorithmException()))
    }
}
