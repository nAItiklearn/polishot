package app.polishot.share

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import app.polishot.R
import app.polishot.capture.CaptureStore
import app.polishot.capture.SavedCapture
import app.polishot.editor.EditorActivity
import app.polishot.polishotApp
import app.polishot.ui.theme.PolishotTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Target of the "Beautify with Polishot" share-sheet entry (the `.ShareAlias` activity alias in the manifest).
 *
 * One image opens in the editor. Several images run batch beautify with the user's last-used look and save the
 * results to Pictures/Polishot; Free runs up to [BatchPolicy.FREE_BATCH_LIMIT] per run, Pro has no such limit.
 *
 * Images are copied into app-private storage straight away (only `content://` URIs are accepted), so the sender's
 * temporary read permission is not needed afterwards.
 */
class ShareReceiverActivity : ComponentActivity() {
    /** How many of the shared images are imported so far, and how many there are: "2 of 5". */
    private var done by mutableIntStateOf(0)
    private var total by mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A recreated activity (process death) must not import the same images twice, and has nothing to show:
        // the share sheet's original intent is gone with the process.
        if (savedInstanceState != null) {
            finish()
            return
        }
        setContent {
            PolishotTheme(darkTheme = isSystemInDarkTheme()) {
                Surface(color = androidx.compose.ui.graphics.Color.Transparent) {
                    Column(
                        modifier = Modifier.padding(32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        CircularProgressIndicator()
                        Text(
                            text = if (total > 1) {
                                stringResource(R.string.share_progress, minOf(done + 1, total), total)
                            } else {
                                stringResource(R.string.share_preparing)
                            },
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }
        handle(intent)
    }

    /** One image into private storage; any failure (unreadable, too large, out of memory) just skips that image. */
    private fun importOne(captures: CaptureStore, uri: Uri): SavedCapture? =
        try {
            captures.importFrom(contentResolver, uri)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } catch (e: OutOfMemoryError) {
            null
        }

    private fun handle(intent: Intent) {
        val app = polishotApp
        val all = ShareImport.uris(intent, packageName)
        if (all.isEmpty()) {
            Toast.makeText(this, R.string.share_nothing, Toast.LENGTH_LONG).show()
            finish()
            return
        }
        lifecycleScope.launch {
            // The stored licence is checked off the main thread at start-up; the batch limit depends on it.
            val plan = BatchPolicy.plan(all.size, app.license.awaitPro())
            val picked = all.take(plan.accepted)
            total = picked.size

            val saved = ArrayList<SavedCapture>(picked.size)
            for ((index, uri) in picked.withIndex()) {
                val one = withContext(Dispatchers.IO) { importOne(app.captures, uri) }
                if (one != null) saved.add(one)
                done = index + 1
            }
            if (saved.isEmpty()) {
                Toast.makeText(this@ShareReceiverActivity, R.string.share_unreadable, Toast.LENGTH_LONG).show()
                finish()
                return@launch
            }

            if (all.size == 1) {
                val image = saved.first()
                withContext(Dispatchers.IO) { app.history.register(image.id, image.width, image.height) }
                startActivity(EditorActivity.intentFor(this@ShareReceiverActivity, image.id))
            } else {
                if (plan.limited) {
                    val message = getString(R.string.share_free_limit, plan.accepted, all.size)
                    Toast.makeText(this@ShareReceiverActivity, message, Toast.LENGTH_LONG).show()
                }
                startActivity(EditorActivity.batchIntent(this@ShareReceiverActivity, saved.map { it.id }))
            }
            finish()
        }
    }
}
