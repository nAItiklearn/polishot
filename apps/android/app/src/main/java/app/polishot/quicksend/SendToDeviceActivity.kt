package app.polishot.quicksend

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import app.polishot.MainActivity
import app.polishot.R
import app.polishot.polishotApp
import app.polishot.ui.theme.PolishotTheme
import kotlinx.coroutines.launch

/**
 * "Send to": a sheet over the editor that lists the paired devices currently visible on the network. Tapping one
 * sends the PNG waiting in [QuickSendOutbox]; the sheet closes when the receiver has confirmed.
 *
 * Only paired devices are offered (docs/QUICKSEND.md section 4); pairing happens on the Quick send screen.
 */
class SendToDeviceActivity : ComponentActivity() {
    private var png: ByteArray? = null
    private var message by mutableStateOf<Int?>(null)

    private val localNetworkPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) {
                message = R.string.quicksend_permission
            } else if (!started && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                // Count the screen in once; if the user already left (onStop ran), there is nothing to start.
                polishotApp.quickSend.acquire()
                started = true
            }
        }
    private var started = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        png = QuickSendOutbox.peek()
        if (png == null) {
            finish()
            return
        }
        val controller = polishotApp.quickSend
        val settings = polishotApp.settings

        setContent {
            val state by controller.state.collectAsStateWithLifecycle()
            // Collected, not read with .value: a theme change must recompose the sheet.
            val appSettings by settings.settings.collectAsStateWithLifecycle()
            PolishotTheme(darkTheme = appSettings.theme.isDark(isSystemInDarkTheme())) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable(enabled = state.sending == null) { finish() },
                    contentAlignment = Alignment.BottomCenter,
                ) {
                    SendSheet(
                        state = state,
                        message = message,
                        onSend = { id ->
                            message = null
                            png?.let { controller.send(id, it) }
                        },
                        onPair = {
                            startActivity(
                                Intent(this@SendToDeviceActivity, MainActivity::class.java)
                                    .putExtra(MainActivity.EXTRA_OPEN_QUICK_SEND, true),
                            )
                            finish()
                        },
                        onCancel = { finish() },
                    )
                }
            }
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                controller.events.collect { event ->
                    when (event) {
                        is QuickSendEvent.Sent -> {
                            Toast.makeText(
                                this@SendToDeviceActivity,
                                getString(R.string.quicksend_sent, event.peerName),
                                Toast.LENGTH_SHORT,
                            ).show()
                            finish()
                        }
                        is QuickSendEvent.Problem -> message = problemMessage(event.kind)
                        else -> Unit
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        if (png == null) return
        if (QuickSendController.needsLocalNetworkPermission &&
            ContextCompat.checkSelfPermission(this, QuickSendController.LOCAL_NETWORK_PERMISSION) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            localNetworkPermission.launch(QuickSendController.LOCAL_NETWORK_PERMISSION)
        } else if (!started) {
            polishotApp.quickSend.acquire()
            started = true
        }
    }

    override fun onStop() {
        if (started) {
            polishotApp.quickSend.release()
            started = false
        }
        super.onStop()
    }

    override fun onDestroy() {
        if (isFinishing) {
            png = null
            QuickSendOutbox.clear() // the bytes are large; do not hold them past the sheet
        }
        super.onDestroy()
    }

    companion object {
        fun intent(context: Context): Intent = Intent(context, SendToDeviceActivity::class.java)
    }
}

@Composable
private fun SendSheet(
    state: QuickSendState,
    message: Int?,
    onSend: (DeviceId) -> Unit,
    onPair: () -> Unit,
    onCancel: () -> Unit,
) {
    Surface(
        // Taps on the sheet itself must not reach the backdrop behind it, which closes the screen.
        modifier = Modifier.fillMaxWidth().pointerInput(Unit) { detectTapGestures { } },
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 8.dp,
    ) {
        Column(modifier = Modifier.navigationBarsPadding().padding(20.dp)) {
            Text(stringResource(R.string.send_title), style = MaterialTheme.typography.headlineSmall)

            val sending = state.sending
            if (sending != null) {
                Text(
                    text = stringResource(R.string.send_sending, sending.peerName),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 16.dp),
                )
                LinearProgressIndicator(
                    progress = { if (sending.total > 0) sending.done.toFloat() / sending.total else 0f },
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    color = MaterialTheme.colorScheme.primary,
                    trackColor = MaterialTheme.colorScheme.outlineVariant,
                )
            } else {
                if (state.paired.isEmpty()) {
                    Text(
                        text = stringResource(R.string.send_no_pairs),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                    Button(
                        onClick = onPair,
                        modifier = Modifier.fillMaxWidth().padding(top = 16.dp).heightIn(min = 52.dp),
                        shape = RoundedCornerShape(14.dp),
                    ) { Text(stringResource(R.string.send_pair)) }
                } else {
                    state.paired.forEach { device ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 56.dp)
                                .clickable(enabled = device.nearby) { onSend(device.id) },
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = device.name,
                                    style = MaterialTheme.typography.titleSmall,
                                    color = if (device.nearby) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.tertiary,
                                )
                                Text(
                                    text = stringResource(
                                        if (device.nearby) R.string.quicksend_nearby else R.string.quicksend_not_nearby,
                                    ),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
                message?.let {
                    Text(
                        text = stringResource(it),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }
                TextButton(onClick = onCancel, modifier = Modifier.padding(top = 8.dp).heightIn(min = 48.dp)) {
                    Text(stringResource(R.string.dialog_cancel))
                }
            }
        }
    }
}

/** User-facing text for a failed quick-send step. */
fun problemMessage(kind: ProblemKind): Int =
    when (kind) {
        ProblemKind.Unreachable -> R.string.problem_unreachable
        ProblemKind.Declined -> R.string.problem_declined
        ProblemKind.Unpaired -> R.string.problem_unpaired
        ProblemKind.Busy -> R.string.problem_busy
        ProblemKind.Timeout -> R.string.problem_timeout
        ProblemKind.TooLarge -> R.string.problem_too_large
        ProblemKind.BadFile -> R.string.problem_bad_file
        ProblemKind.PairingCancelled -> R.string.problem_pairing_cancelled
        ProblemKind.PairingOff -> R.string.problem_pairing_off
        ProblemKind.TooManyAttempts -> R.string.problem_too_many
        ProblemKind.Connection -> R.string.problem_connection
        ProblemKind.Failed -> R.string.problem_failed
    }
