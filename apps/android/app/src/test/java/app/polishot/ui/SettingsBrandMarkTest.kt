package app.polishot.ui

import androidx.compose.ui.test.assertDoesNotExist
import androidx.compose.ui.test.assertExists
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import app.polishot.settings.AppSettings
import app.polishot.settings.BrandMarkMode
import app.polishot.ui.settings.SettingsScreen
import app.polishot.ui.theme.PolishotTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Pro brand mark controls in Settings: Free sees one calm note, Pro sees the controls. */
@RunWith(RobolectricTestRunner::class)
class SettingsBrandMarkTest {
    @get:Rule
    val compose = createComposeRule()

    private var current = AppSettings()
    private var licenseOpened = 0

    private fun show(settings: AppSettings, pro: Boolean, hasLogo: Boolean = false) {
        current = settings
        compose.setContent {
            PolishotTheme(darkTheme = false, brandFonts = false) {
                SettingsScreen(
                    settings = settings,
                    pro = pro,
                    hasLogo = hasLogo,
                    onChange = { transform -> current = transform(current) },
                    onPickLogo = {},
                    onRemoveLogo = {},
                    onOpenLicense = { licenseOpened++ },
                    onBack = {},
                )
            }
        }
    }

    @Test
    fun `Free sees the note and none of the controls`() {
        show(AppSettings(brandMarkMode = BrandMarkMode.Text, brandMarkText = "Ada"), pro = false)
        compose.onNodeWithTag("brand-locked").assertExists()
        compose.onNodeWithTag("brand-text").assertDoesNotExist()
        compose.onNodeWithTag("brand-logo-choose").assertDoesNotExist()
    }

    @Test
    fun `Pro in name mode sees the text field and not the note`() {
        show(AppSettings(brandMarkMode = BrandMarkMode.Text), pro = true)
        compose.onNodeWithTag("brand-locked").assertDoesNotExist()
        compose.onNodeWithTag("brand-text").assertExists()
    }

    @Test
    fun `Pro in logo mode sees the image chooser`() {
        show(AppSettings(brandMarkMode = BrandMarkMode.Logo), pro = true, hasLogo = false)
        compose.onNodeWithTag("brand-logo-choose").assertExists()
        compose.onNodeWithTag("brand-text").assertDoesNotExist()
    }

    @Test
    fun `typing a name reports the change`() {
        show(AppSettings(brandMarkMode = BrandMarkMode.Text), pro = true)
        compose.onNodeWithTag("brand-text").performScrollTo().performTextInput("Ada")
        compose.waitForIdle()
        assertEquals("Ada", current.brandMarkText)
    }
}
