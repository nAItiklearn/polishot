package app.polishot

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The real MainActivity on a device or emulator. Assumes a fresh install: a device that already holds a genuine
 * licence key shows the key as active instead of the entry field.
 */
@RunWith(AndroidJUnit4::class)
class HomeInstrumentedTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun homeRendersItsPrimaryActions() {
        compose.onNodeWithText(APP_NAME).assertIsDisplayed()
        compose.onNodeWithText("Capture").assertIsDisplayed()
        compose.onNodeWithText("Open image").assertIsDisplayed()
        compose.onNodeWithText("Quick send").assertIsDisplayed()
    }

    @Test
    fun licenseScreenRejectsABadKey() {
        compose.onNodeWithText("License").performClick()

        compose.onNodeWithTag("license-key").performTextInput("PSHOT-AAAAAA-BBBBBB")
        compose.onNodeWithTag("license-activate").performClick()

        compose.onNodeWithTag("license-error").assertIsDisplayed()
        compose.onNodeWithText("Free").assertIsDisplayed()
    }

    @Test
    fun settingsOpensFromHome() {
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Settings").assertIsDisplayed()
    }
}
