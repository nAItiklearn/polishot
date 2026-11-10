package app.polishot

import android.content.ComponentName
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.polishot.editor.EditorActivity
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The share sheet's "Beautify with Polishot" entry, end to end on a real device: the manifest alias resolves for
 * images, and sharing a real image opens the editor.
 */
@RunWith(AndroidJUnit4::class)
class ShareReceiverInstrumentedTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private var imageUri: Uri? = null

    @Before
    fun insertImage() {
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "polishot-share-test.png")
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/PolishotTest")
        }
        val uri = checkNotNull(context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values))
        context.contentResolver.openOutputStream(uri).use { out ->
            val bitmap = Bitmap.createBitmap(96, 64, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(200, 71, 29)) }
            checkNotNull(out)
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        }
        imageUri = uri
    }

    @After
    fun cleanUp() {
        imageUri?.let { context.contentResolver.delete(it, null, null) }
        runBlocking { context.polishotApp.history.clearAll() }
    }

    @Test
    fun theShareSheetOffersBeautifyWithPolishotForImages() {
        val probe = Intent(Intent.ACTION_SEND).setType("image/png")
        val labels = context.packageManager.queryIntentActivities(probe, 0)
            .filter { it.activityInfo.packageName == context.packageName }
            .map { it.loadLabel(context.packageManager).toString() }
        assertTrue("share targets of this app: $labels", labels.contains("Beautify with Polishot"))
    }

    @Test
    fun sharingAnImageOpensTheEditor() {
        val monitor = instrumentation.addMonitor(EditorActivity::class.java.name, null, false)
        val intent = Intent(Intent.ACTION_SEND)
            .setComponent(ComponentName(context.packageName, "app.polishot.ShareAlias"))
            .setType("image/png")
            .putExtra(Intent.EXTRA_STREAM, imageUri)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            val editor = monitor.waitForActivityWithTimeout(20_000)
            assertNotNull("the editor should open after sharing an image", editor)
            editor.finish()
        } finally {
            instrumentation.removeMonitor(monitor)
        }
    }
}
