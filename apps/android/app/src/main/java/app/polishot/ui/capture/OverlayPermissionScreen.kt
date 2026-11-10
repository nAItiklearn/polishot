package app.polishot.ui.capture

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.polishot.R
import app.polishot.ui.components.ScreenHeader

/**
 * Explains, before the system settings page opens, why Polishot asks to "display over other apps": it draws the
 * small floating capture button, and nothing else. Reading other apps is not possible with this permission.
 */
@Composable
fun OverlayPermissionScreen(
    onAllow: () -> Unit,
    onUseNotification: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(modifier = modifier, containerColor = MaterialTheme.colorScheme.background) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 32.dp),
        ) {
            ScreenHeader(title = stringResource(R.string.overlay_header), onBack = onBack)
            Text(
                text = stringResource(R.string.overlay_title),
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.padding(top = 16.dp),
            )
            Text(
                text = stringResource(R.string.overlay_body),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp),
            )
            Text(
                text = stringResource(R.string.overlay_promise),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp),
            )
            Button(
                onClick = onAllow,
                modifier = Modifier.fillMaxWidth().padding(top = 32.dp).heightIn(min = 52.dp),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(stringResource(R.string.overlay_allow), style = MaterialTheme.typography.titleMedium)
            }
            TextButton(
                onClick = onUseNotification,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.overlay_use_notification))
            }
        }
    }
}
