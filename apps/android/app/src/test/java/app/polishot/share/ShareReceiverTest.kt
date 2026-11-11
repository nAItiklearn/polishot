package app.polishot.share

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.test.core.app.ApplicationProvider
import app.polishot.PolishotApp
import app.polishot.R
import app.polishot.editor.EditorActivity
import app.polishot.polishotApp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowToast

/**
 * What the share-sheet entry accepts and refuses. The happy path (a real image reaching the editor) needs a
 * real ImageDecoder and MediaStore and runs as an instrumented test (ShareReceiverInstrumentedTest).
 */
@RunWith(RobolectricTestRunner::class)
class ShareReceiverTest {
    private val context: Application get() = ApplicationProvider.getApplicationContext()
    private val own: String get() = context.packageName

    private fun send(vararg uris: Uri): Intent =
        Intent(context, ShareReceiverActivity::class.java).apply {
            type = "image/png"
            if (uris.size == 1) {
                action = Intent.ACTION_SEND
                putExtra(Intent.EXTRA_STREAM, uris.first())
            } else {
                action = Intent.ACTION_SEND_MULTIPLE
                putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris.toList()))
            }
        }

    @Test
    fun `content uris are accepted in order and without duplicates`() {
        val a = Uri.parse("content://media/external/images/media/1")
        val b = Uri.parse("content://com.example.gallery/pics/2")
        val found = ShareImport.uris(send(a, b, a), own)
        assertEquals(listOf(a, b), found)
    }

    @Test
    fun `file uris are refused`() {
        val file = Uri.parse("file:///data/data/$own/files/captures/a.png")
        assertTrue(ShareImport.uris(send(file), own).isEmpty())
    }

    @Test
    fun `uris served by this app are refused`() {
        val mine = Uri.parse("content://$own.fileprovider/shared/x.png")
        assertTrue(ShareImport.uris(send(mine), own).isEmpty())
    }

    @Test
    fun `other actions are ignored`() {
        val intent = Intent(Intent.ACTION_VIEW).putExtra(Intent.EXTRA_STREAM, Uri.parse("content://media/external/images/media/1"))
        assertTrue(ShareImport.uris(intent, own).isEmpty())
    }

    @Test
    fun `an intent cannot queue an unbounded number of images`() {
        val many = Array(ShareImport.HARD_CAP + 50) { Uri.parse("content://media/external/images/media/$it") }
        assertEquals(ShareImport.HARD_CAP, ShareImport.uris(send(*many), own).size)
    }

    @Test
    fun `a share without an image says so and finishes`() {
        val intent = Intent(context, ShareReceiverActivity::class.java).setAction(Intent.ACTION_SEND).setType("image/png")
        val activity = Robolectric.buildActivity(ShareReceiverActivity::class.java, intent).create().get()

        assertTrue(activity.isFinishing)
        assertEquals(context.getString(R.string.share_nothing), ShadowToast.getTextOfLatestToast())
        assertNull(shadowOf(context).nextStartedActivity)
    }

    @Test
    fun `a recreated activity finishes instead of importing the same images again`() {
        val uri = Uri.parse("content://media/external/images/media/1")
        // A non-null saved state is what the system passes after the process was killed and the screen is restored.
        val activity = Robolectric.buildActivity(ShareReceiverActivity::class.java, send(uri)).create(Bundle()).get()

        assertTrue(activity.isFinishing)
        assertNull("no import and no editor on a restore", shadowOf(context).nextStartedActivity)
        assertNull("nothing to tell the user", ShadowToast.getLatestToast())
    }

    @Test
    fun `a file uri never reaches the editor`() {
        val file = Uri.parse("file:///data/data/$own/files/captures/a.png")
        val activity = Robolectric.buildActivity(ShareReceiverActivity::class.java, send(file)).create().get()

        assertTrue(activity.isFinishing)
        assertNull("no editor must start for a refused uri", shadowOf(context).nextStartedActivity)
        assertEquals(context.getString(R.string.share_nothing), ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun `the application object is the one the manifest declares`() {
        assertEquals(PolishotApp::class.java, context.javaClass)
        assertEquals(context, context.polishotApp)
        // EditorActivity is the only place a share ends; its intent factory carries the capture id.
        val intent = EditorActivity.intentFor(context, "abc123")
        assertEquals(EditorActivity::class.java.name, intent.component?.className)
    }
}
