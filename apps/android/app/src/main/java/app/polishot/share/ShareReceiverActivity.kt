package app.polishot.share

import android.content.Intent
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import app.polishot.R
import app.polishot.capture.SavedCapture
import app.polishot.editor.EditorActivity
import app.polishot.polishotApp
import app.polishot.ui.theme.PolishotTheme
import java.io.IOException
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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            PolishotTheme(darkTheme = isSystemInDarkTheme()) {
                Surface(color = androidx.compose.ui.graphics.Color.Transparent) {
                    Column(
                        modifier = Modifier.padding(32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        CircularProgressIndicator()
                        Text(stringResource(R.string.share_preparing), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
        // A recreated activity (process death) must not import the same images twice.
        if (savedInstanceState == null) handle(intent)
    }

    private fun handle(intent: Intent) {
        val app = polishotApp
        val all = ShareImport.uris(intent, packageName)
        if (all.isEmpty()) {
            Toast.makeText(this, R.string.share_nothing, Toast.LENGTH_LONG).show()
            finish()
            return
        }
        val plan = BatchPolicy.plan(all.size, app.license.isPro)
        val picked = all.take(plan.accepted)

        lifecycleScope.launch {
            val saved: List<SavedCapture> = withContext(Dispatchers.IO) {
                picked.mapNotNull { uri ->
                    try {
                        app.captures.importFrom(contentResolver, uri)
                    } catch (e: IOException) {
                        null
                    }
                }
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
