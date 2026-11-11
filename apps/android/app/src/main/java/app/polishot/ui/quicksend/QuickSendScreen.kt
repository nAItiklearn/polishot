package app.polishot.ui.quicksend

import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogProperties
import app.polishot.R
import app.polishot.quicksend.DeviceId
import app.polishot.quicksend.NearbyDevice
import app.polishot.quicksend.PairedDevice
import app.polishot.quicksend.QuickSendState
import app.polishot.ui.components.Panel
import app.polishot.ui.components.ScreenHeader
import app.polishot.ui.components.SectionLabel

/**
 * Quick send: this device's name, the paired devices, pairing, and any incoming image. While this screen is
 * visible the phone listens for paired devices; leaving it stops that. Stateless: [app.polishot.MainActivity] owns
 * the controller.
 *
 * Pairing never auto-confirms: the six-digit code is shown in a dialog and the user decides whether it matches.
 */
@Composable
fun QuickSendScreen(
    state: QuickSendState,
    needsPermission: Boolean,
    onRequestPermission: () -> Unit,
    onBack: () -> Unit,
    onPairingOpen: (Boolean) -> Unit,
    onPairWith: (DeviceId) -> Unit,
    onRemove: (DeviceId) -> Unit,
    onRename: (String) -> Unit,
    onAnswerOffer: (Boolean) -> Unit,
    onAnswerPairing: (Boolean) -> Unit,
    permissionBlocked: Boolean = false,
    modifier: Modifier = Modifier,
) {
    var removing by remember { mutableStateOf<PairedDevice?>(null) }

    Scaffold(
        modifier = modifier,
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 32.dp),
        ) {
            ScreenHeader(title = stringResource(R.string.quicksend_title), onBack = onBack)

            state.offer?.let { offer ->
                Panel(modifier = Modifier.padding(top = 8.dp).testTag("quicksend-offer")) {
                    Text(stringResource(R.string.quicksend_offer_title), style = MaterialTheme.typography.titleMedium)
                    Text(
                        text = stringResource(
                            R.string.quicksend_offer_body,
                            offer.peerName,
                            offer.fileName,
                            Formatter.formatShortFileSize(LocalContext.current, offer.sizeBytes),
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        OutlinedButton(
                            onClick = { onAnswerOffer(false) },
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                            shape = RoundedCornerShape(12.dp),
                        ) { Text(stringResource(R.string.quicksend_decline)) }
                        Button(
                            onClick = { onAnswerOffer(true) },
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                            shape = RoundedCornerShape(12.dp),
                        ) { Text(stringResource(R.string.quicksend_accept)) }
                    }
                }
            }

            Text(
                text = stringResource(R.string.quicksend_intro),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp),
            )

            if (needsPermission) {
                Panel(modifier = Modifier.padding(top = 16.dp)) {
                    Text(stringResource(R.string.quicksend_permission), style = MaterialTheme.typography.bodyMedium)
                    Button(
                        onClick = onRequestPermission,
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp).heightIn(min = 48.dp),
                        shape = RoundedCornerShape(12.dp),
                    ) {
                        Text(
                            stringResource(
                                if (permissionBlocked) R.string.quicksend_permission_settings else R.string.quicksend_permission_action,
                            ),
                        )
                    }
                }
            } else {
                Text(
                    text = stringResource(
                        if (state.listening) R.string.quicksend_visible else R.string.quicksend_starting,
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }

            DeviceName(state.ownName, onRename)

            SectionLabel(stringResource(R.string.quicksend_paired))
            if (state.paired.isEmpty()) {
                Text(
                    text = stringResource(R.string.quicksend_no_pairs),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            state.paired.forEach { device ->
                PairedRow(device = device, onRemove = { removing = device })
            }

            SectionLabel(stringResource(R.string.quicksend_pair_section))
            if (!state.pairingOpen) {
                Button(
                    onClick = { onPairingOpen(true) },
                    enabled = !needsPermission && state.listening,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("quicksend-pair-start"),
                    shape = RoundedCornerShape(14.dp),
                ) { Text(stringResource(R.string.quicksend_pair_start), style = MaterialTheme.typography.titleMedium) }
            } else {
                Panel(modifier = Modifier.testTag("quicksend-pairing-open")) {
                    Text(
                        text = stringResource(R.string.quicksend_pair_help),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (state.nearby.isEmpty()) {
                        Text(
                            text = stringResource(R.string.quicksend_nearby_none),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.tertiary,
                            modifier = Modifier.padding(top = 12.dp),
                        )
                    }
                    state.nearby.forEach { device -> NearbyRow(device = device, onPair = { onPairWith(device.id) }) }
                    TextButton(
                        onClick = { onPairingOpen(false) },
                        modifier = Modifier.padding(top = 8.dp).heightIn(min = 48.dp),
                    ) { Text(stringResource(R.string.quicksend_pair_done)) }
                }
            }
        }
    }

    state.pairing?.let { prompt ->
        AlertDialog(
            onDismissRequest = { onAnswerPairing(false) },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(R.string.quicksend_pairing_title)) },
            text = {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        text = prompt.code,
                        fontSize = 40.sp,
                        fontWeight = FontWeight.Medium,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(vertical = 12.dp).testTag("quicksend-code"),
                    )
                    Text(
                        text = stringResource(R.string.quicksend_pairing_body, prompt.peerName),
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = { onAnswerPairing(true) }) { Text(stringResource(R.string.quicksend_pairing_match)) }
            },
            dismissButton = {
                TextButton(onClick = { onAnswerPairing(false) }) { Text(stringResource(R.string.quicksend_pairing_mismatch)) }
            },
        )
    }

    removing?.let { device ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(stringResource(R.string.quicksend_remove_title, device.name)) },
            text = { Text(stringResource(R.string.quicksend_remove_body)) },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    onRemove(device.id)
                }) { Text(stringResource(R.string.quicksend_remove)) }
            },
            dismissButton = {
                TextButton(onClick = { removing = null }) { Text(stringResource(R.string.dialog_cancel)) }
            },
        )
    }
}

@Composable
private fun DeviceName(current: String, onRename: (String) -> Unit) {
    var name by rememberSaveable(current) { mutableStateOf(current) }
    Text(
        text = stringResource(R.string.quicksend_device_name),
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.padding(top = 24.dp),
    )
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = name,
            onValueChange = { name = it.take(32) },
            singleLine = true,
            modifier = Modifier.weight(1f),
            shape = RoundedCornerShape(12.dp),
        )
        TextButton(
            onClick = { onRename(name) },
            enabled = name.isNotBlank() && name != current,
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(stringResource(R.string.quicksend_rename)) }
    }
}

@Composable
private fun PairedRow(device: PairedDevice, onRemove: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(device.name, style = MaterialTheme.typography.titleSmall)
            Text(
                text = stringResource(if (device.nearby) R.string.quicksend_nearby else R.string.quicksend_not_nearby),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(onClick = onRemove, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(R.string.quicksend_remove))
        }
    }
}

@Composable
private fun NearbyRow(device: NearbyDevice, onPair: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(device.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
        OutlinedButton(
            onClick = onPair,
            modifier = Modifier.heightIn(min = 48.dp),
            shape = RoundedCornerShape(12.dp),
        ) { Text(stringResource(R.string.quicksend_pair_with)) }
    }
}
