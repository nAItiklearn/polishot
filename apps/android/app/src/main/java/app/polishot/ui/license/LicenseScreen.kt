package app.polishot.ui.license

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.polishot.R
import app.polishot.license.ActivationResult
import app.polishot.license.Edition
import app.polishot.license.Entitlement
import app.polishot.license.EntitlementReason
import app.polishot.license.InvalidReason
import app.polishot.ui.components.Panel
import app.polishot.ui.components.ScreenHeader

/**
 * Paste a key, see the edition and the end of the update window, remove the key.
 *
 * [onActivate] verifies the key (offline, Ed25519) and reports the outcome; the screen only maps a failure to a
 * calm message. Nothing is sent anywhere.
 */
@Composable
fun LicenseScreen(
    entitlement: Entitlement,
    onActivate: (String) -> ActivationResult,
    onDeactivate: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var key by rememberSaveable { mutableStateOf("") }
    var failure by rememberSaveable { mutableStateOf<InvalidReason?>(null) }
    var confirmRemove by rememberSaveable { mutableStateOf(false) }
    val hasKey = entitlement.info != null

    Scaffold(modifier = modifier, containerColor = MaterialTheme.colorScheme.background) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 32.dp),
        ) {
            ScreenHeader(title = stringResource(R.string.license_title), onBack = onBack)

            StatusPanel(entitlement)

            if (!hasKey) {
                Text(
                    text = stringResource(R.string.license_key_label),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(top = 24.dp),
                )
                OutlinedTextField(
                    value = key,
                    onValueChange = {
                        key = it
                        failure = null
                    },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp).testTag("license-key"),
                    placeholder = { Text(stringResource(R.string.license_key_placeholder)) },
                    minLines = 3,
                    isError = failure != null,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Characters,
                        keyboardType = KeyboardType.Ascii,
                    ),
                    shape = RoundedCornerShape(12.dp),
                )
                failure?.let { reason ->
                    Text(
                        text = stringResource(messageFor(reason)),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(top = 8.dp).testTag("license-error"),
                    )
                }
                Button(
                    onClick = {
                        when (val result = onActivate(key)) {
                            is ActivationResult.Success -> {
                                key = ""
                                failure = null
                            }
                            is ActivationResult.Failure -> failure = result.reason
                        }
                    },
                    enabled = key.isNotBlank(),
                    modifier = Modifier.fillMaxWidth().padding(top = 16.dp).heightIn(min = 52.dp).testTag("license-activate"),
                    shape = RoundedCornerShape(14.dp),
                ) {
                    Text(stringResource(R.string.license_activate), style = MaterialTheme.typography.titleMedium)
                }
                Text(
                    text = stringResource(R.string.license_on_sale_soon),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.padding(top = 12.dp),
                )
            } else {
                OutlinedButton(
                    onClick = { confirmRemove = true },
                    modifier = Modifier.fillMaxWidth().padding(top = 24.dp).heightIn(min = 52.dp).testTag("license-remove"),
                    shape = RoundedCornerShape(14.dp),
                ) {
                    Text(stringResource(R.string.license_remove), style = MaterialTheme.typography.titleMedium)
                }
            }
        }
    }

    if (confirmRemove) {
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            title = { Text(stringResource(R.string.license_remove_title)) },
            text = { Text(stringResource(R.string.license_remove_body)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmRemove = false
                    onDeactivate()
                }) { Text(stringResource(R.string.license_remove_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmRemove = false }) { Text(stringResource(R.string.dialog_cancel)) }
            },
        )
    }
}

/** What the current entitlement means, in plain words. */
@Composable
private fun StatusPanel(entitlement: Entitlement) {
    val info = entitlement.info
    val updatesUntil = entitlement.updatesUntil
    Panel(modifier = Modifier.padding(top = 8.dp).testTag("license-status")) {
        when {
            entitlement.pro && info != null -> {
                Text(stringResource(R.string.license_status_pro), style = MaterialTheme.typography.headlineSmall)
                Text(
                    text = stringResource(editionLabel(info.edition)),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
                Detail(stringResource(R.string.license_issued), info.issuedDate().toString())
                if (updatesUntil != null) Detail(stringResource(R.string.license_updates_until), updatesUntil)
            }
            entitlement.reason == EntitlementReason.UpdatesExpired && info != null -> {
                Text(stringResource(R.string.license_status_expired), style = MaterialTheme.typography.headlineSmall)
                Text(
                    text = stringResource(R.string.license_expired_message, updatesUntil.orEmpty()),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(top = 8.dp).testTag("license-expired-message"),
                )
                Detail(stringResource(R.string.license_issued), info.issuedDate().toString())
            }
            else -> {
                Text(stringResource(R.string.license_status_free), style = MaterialTheme.typography.headlineSmall)
                Text(
                    text = stringResource(R.string.license_free_body),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun Detail(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

private fun editionLabel(edition: Edition): Int =
    when (edition) {
        Edition.PERSONAL -> R.string.license_edition_personal
        Edition.TEAM -> R.string.license_edition_team
    }

/** String resource for a failed activation; deliberately never reveals more than "what to fix". */
internal fun messageFor(reason: InvalidReason): Int =
    when (reason) {
        InvalidReason.FORMAT -> R.string.license_error_format
        InvalidReason.LENGTH -> R.string.license_error_length
        InvalidReason.SIGNATURE -> R.string.license_error_signature
        InvalidReason.VERSION -> R.string.license_error_version
    }
