package app.polishot.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.polishot.R
import app.polishot.settings.AppSettings
import app.polishot.settings.ExportFormat
import app.polishot.settings.PresetIds
import app.polishot.settings.ThemeMode
import app.polishot.ui.components.ScreenHeader
import app.polishot.ui.components.SectionLabel
import app.polishot.ui.components.SegmentedChoice
import kotlin.math.roundToInt

/**
 * Default export format, quality and scale, the default canvas preset, the theme and the capture bubble.
 * Stateless: [onChange] receives a transform that the repository applies and persists.
 */
@Composable
fun SettingsScreen(
    settings: AppSettings,
    onChange: ((AppSettings) -> AppSettings) -> Unit,
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
            ScreenHeader(title = stringResource(R.string.settings_title), onBack = onBack)

            SectionLabel(stringResource(R.string.settings_section_export))
            Text(stringResource(R.string.settings_format), style = MaterialTheme.typography.titleSmall)
            SegmentedChoice(
                options = ExportFormat.entries.toList(),
                selected = settings.exportFormat,
                label = { it.label },
                onSelect = { f -> onChange { it.copy(exportFormat = f) } },
                groupDescription = stringResource(R.string.settings_format),
                modifier = Modifier.padding(top = 8.dp),
            )

            if (settings.exportFormat != ExportFormat.Png) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        stringResource(R.string.settings_quality),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = "${settings.exportQuality}%",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Slider(
                    value = settings.exportQuality.toFloat(),
                    onValueChange = { v -> onChange { it.copy(exportQuality = v.roundToInt()) } },
                    valueRange = AppSettings.MIN_QUALITY.toFloat()..100f,
                    modifier = Modifier.testTag("settings-quality"),
                )
            }

            Text(
                stringResource(R.string.settings_scale),
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(top = 16.dp),
            )
            SegmentedChoice(
                options = listOf(1, 2, 3),
                selected = settings.exportScale,
                label = { "${it}x" },
                onSelect = { s -> onChange { it.copy(exportScale = s) } },
                groupDescription = stringResource(R.string.settings_scale),
                modifier = Modifier.padding(top = 8.dp),
            )

            Text(
                stringResource(R.string.settings_preset),
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(top = 16.dp),
            )
            Column(modifier = Modifier.selectableGroup()) {
                for (id in PresetIds.all) {
                    PresetRow(
                        label = PresetIds.labels.getValue(id),
                        selected = settings.defaultPreset == id,
                        onSelect = { onChange { it.copy(defaultPreset = id) } },
                    )
                }
            }

            SectionLabel(stringResource(R.string.settings_section_appearance))
            Text(stringResource(R.string.settings_theme), style = MaterialTheme.typography.titleSmall)
            SegmentedChoice(
                options = ThemeMode.entries.toList(),
                selected = settings.theme,
                label = { mode ->
                    when (mode) {
                        ThemeMode.System -> stringResource(R.string.theme_system)
                        ThemeMode.Light -> stringResource(R.string.theme_light)
                        ThemeMode.Dark -> stringResource(R.string.theme_dark)
                    }
                },
                onSelect = { m -> onChange { it.copy(theme = m) } },
                groupDescription = stringResource(R.string.settings_theme),
                modifier = Modifier.padding(top = 8.dp),
            )

            SectionLabel(stringResource(R.string.settings_section_capture))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .toggleable(
                        value = settings.bubbleEnabled,
                        role = Role.Switch,
                        onValueChange = { on -> onChange { it.copy(bubbleEnabled = on) } },
                    ),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(stringResource(R.string.settings_bubble), style = MaterialTheme.typography.titleSmall)
                    Text(
                        stringResource(R.string.settings_bubble_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(checked = settings.bubbleEnabled, onCheckedChange = null)
            }
        }
    }
}

@Composable
private fun PresetRow(label: String, selected: Boolean, onSelect: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .selectable(selected = selected, role = Role.RadioButton, onClick = onSelect),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 12.dp))
    }
}
