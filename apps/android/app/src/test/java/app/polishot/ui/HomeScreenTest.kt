package app.polishot.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onNodeWithTag
import app.polishot.APP_NAME
import app.polishot.history.HistoryRow
import app.polishot.ui.home.HomeScreen
import app.polishot.ui.home.HomeState
import app.polishot.ui.home.ThumbnailLoader
import app.polishot.ui.theme.PolishotTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The home screen renders its primary actions and reports taps; runs on the JVM with Robolectric. */
@RunWith(RobolectricTestRunner::class)
class HomeScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val noThumbnails = ThumbnailLoader { null }

    private class Taps {
        var capture = 0
        var openImage = 0
        var quickSend = 0
        var settings = 0
        var license = 0
        var opened: String? = null
        var deleted: String? = null
        var cleared = 0
        var query: String? = null
    }

    private fun show(state: HomeState, taps: Taps = Taps()) {
        compose.setContent {
            PolishotTheme(darkTheme = false, brandFonts = false) {
                HomeScreen(
                    state = state,
                    thumbnails = noThumbnails,
                    onCapture = { taps.capture++ },
                    onStopSession = {},
                    onOpenImage = { taps.openImage++ },
                    onQuickSend = { taps.quickSend++ },
                    onOpenItem = { taps.opened = it },
                    onDeleteItem = { taps.deleted = it },
                    onClearAll = { taps.cleared++ },
                    onQueryChange = { taps.query = it },
                    onSettings = { taps.settings++ },
                    onLicense = { taps.license++ },
                )
            }
        }
    }

    private fun row(id: String) = HistoryRow(id = id, createdAt = 1_700_000_000_000L, width = 1080, height = 2400, excerpt = "", hasDoc = false)

    @Test
    fun `home shows the wordmark, Capture and Open image`() {
        show(HomeState(items = emptyList(), query = "", sessionActive = false))
        compose.onNodeWithText(APP_NAME).assertIsDisplayed()
        compose.onNodeWithText("Capture").assertIsDisplayed()
        compose.onNodeWithText("Open image").assertIsDisplayed()
        compose.onNodeWithText("License").assertIsDisplayed()
    }

    @Test
    fun `an empty history shows one plain sentence instead of a grid`() {
        show(HomeState(items = emptyList(), query = "", sessionActive = false))
        compose.onNodeWithText("Nothing here yet").assertIsDisplayed()
    }

    @Test
    fun `the actions report taps`() {
        val taps = Taps()
        show(HomeState(items = emptyList(), query = "", sessionActive = false), taps)
        compose.onNodeWithText("Capture").performClick()
        compose.onNodeWithText("Open image").performClick()
        compose.onNodeWithText("Quick send").performClick()
        compose.onNodeWithText("License").performClick()
        assertEquals(1, taps.capture)
        assertEquals(1, taps.openImage)
        assertEquals(1, taps.quickSend)
        assertEquals(1, taps.license)
    }

    @Test
    fun `history shows the recent header, the search field and Clear all`() {
        show(HomeState(items = listOf(row("a1"), row("b2")), query = "", sessionActive = false))
        compose.onNodeWithText("Recent").assertIsDisplayed()
        compose.onNodeWithTag("home-search").assertIsDisplayed()
        compose.onNodeWithText("Clear all").assertIsDisplayed()
    }

    @Test
    fun `clearing the history asks for confirmation first`() {
        val taps = Taps()
        show(HomeState(items = listOf(row("a1")), query = "", sessionActive = false), taps)
        compose.onNodeWithText("Clear all").performClick()
        compose.onNodeWithText("Clear all history?").assertIsDisplayed()
        assertEquals("nothing is deleted before the user confirms", 0, taps.cleared)
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(0, taps.cleared)
    }

    @Test
    fun `a running capture session offers Stop`() {
        show(HomeState(items = emptyList(), query = "", sessionActive = true))
        compose.onNodeWithText("Stop").assertIsDisplayed()
    }

    @Test
    fun `a search without matches says so`() {
        show(HomeState(items = emptyList(), query = "invoice", sessionActive = false))
        compose.onNodeWithText("No screenshot contains that text.").assertIsDisplayed()
    }
}
