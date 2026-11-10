package app.polishot.ui

import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.polishot.license.InMemorySecretStore
import app.polishot.license.LicenseManager
import app.polishot.license.LicenseVerifier
import app.polishot.ui.license.LicenseScreen
import app.polishot.ui.theme.PolishotTheme
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The licence screen against the real verifier and the shared test vectors; runs on the JVM with Robolectric. */
@RunWith(RobolectricTestRunner::class)
class LicenseScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val vectors: JSONObject = run {
        val configured = System.getProperty("polishot.licenseVectors")
        val file = if (!configured.isNullOrBlank()) File(configured) else File("../../../packages/license/test-vectors.json")
        JSONObject(file.readText())
    }

    private fun validKey(): String {
        val cases = vectors.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            if (c.getString("name") == "valid-personal") return c.getString("key")
        }
        throw AssertionError("valid-personal vector missing")
    }

    // issuedDays for valid-personal is 20468, so day 20500 is inside the one-year update window.
    private fun manager(buildDays: Long = 20_500): LicenseManager =
        LicenseManager(LicenseVerifier(vectors.getString("publicKeyHex")), InMemorySecretStore(), buildDays)

    private fun show(manager: LicenseManager, onBack: () -> Unit = {}) {
        compose.setContent {
            PolishotTheme(darkTheme = false, brandFonts = false) {
                val entitlement by manager.entitlement.collectAsStateWithLifecycle()
                LicenseScreen(
                    entitlement = entitlement,
                    onActivate = manager::activate,
                    onDeactivate = manager::deactivate,
                    onBack = onBack,
                )
            }
        }
    }

    @Test
    fun `a free install explains the plan and asks for a key`() {
        show(manager())
        compose.onNodeWithTag("license-status").assertIsDisplayed()
        compose.onNodeWithText("Free").assertIsDisplayed()
        compose.onNodeWithTag("license-key").assertIsDisplayed()
        compose.onNodeWithTag("license-activate").assertIsNotEnabled() // nothing typed yet
    }

    @Test
    fun `a bad key is rejected with a message and stays Free`() {
        val m = manager()
        show(m)
        compose.onNodeWithTag("license-key").performTextInput("PSHOT-AAAAAA-BBBBBB")
        compose.onNodeWithTag("license-activate").assertIsEnabled().performClick()

        compose.onNodeWithTag("license-error").assertIsDisplayed()
        assertFalse(m.isPro)
        compose.onNodeWithText("Free").assertIsDisplayed()
    }

    @Test
    fun `text that is not a key is rejected too`() {
        val m = manager()
        show(m)
        compose.onNodeWithTag("license-key").performTextInput("hello world, this is not a key")
        compose.onNodeWithTag("license-activate").performClick()
        compose.onNodeWithTag("license-error").assertIsDisplayed()
        assertFalse(m.isPro)
    }

    @Test
    fun `a genuine key activates Pro and shows the update window`() {
        val m = manager()
        show(m)
        compose.onNodeWithTag("license-key").performTextInput(validKey())
        compose.onNodeWithTag("license-activate").performClick()

        compose.waitForIdle()
        assertTrue(m.isPro)
        compose.onNodeWithText("Polishot Pro").assertIsDisplayed()
        compose.onNodeWithText("Personal license").assertIsDisplayed()
        compose.onNodeWithText("2027-01-15").assertIsDisplayed() // issued day 20468 + 365
        compose.onNodeWithTag("license-remove").assertIsDisplayed()
    }

    @Test
    fun `a genuine key on a build past its window shows the update message`() {
        val m = manager(buildDays = 30_000)
        show(m)
        compose.onNodeWithTag("license-key").performTextInput(validKey())
        compose.onNodeWithTag("license-activate").performClick()

        compose.waitForIdle()
        assertFalse("later builds behave as Free", m.isPro)
        compose.onNodeWithTag("license-expired-message").assertIsDisplayed()
        compose.onNodeWithText("Your license includes updates released until 2027-01-15. This version came out later.")
            .assertIsDisplayed()
    }

    @Test
    fun `removing the key asks first and then returns to Free`() {
        val m = manager()
        m.activate(validKey())
        show(m)
        compose.onNodeWithTag("license-remove").performClick()
        compose.onNodeWithText("Remove this key?").assertIsDisplayed()
        assertTrue("still Pro until confirmed", m.isPro)
        compose.onNodeWithText("Remove").performClick()
        compose.waitForIdle()
        assertFalse(m.isPro)
        compose.onNodeWithTag("license-key").assertIsDisplayed()
    }
}
