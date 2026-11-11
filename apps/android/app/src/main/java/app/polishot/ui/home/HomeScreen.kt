package app.polishot.ui.home

import android.text.format.DateUtils
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridItemSpanScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.polishot.APP_NAME
import app.polishot.R
import app.polishot.history.HistoryRow
import app.polishot.ui.components.BrandMark
import kotlinx.coroutines.delay

private const val CLOCK_TICK_MILLIS = 60_000L

/** Loads a history thumbnail off the main thread; returns null when there is none. */
fun interface ThumbnailLoader {
    suspend fun load(id: String): ImageBitmap?
}

/** Everything the home screen shows. */
data class HomeState(
    val items: List<HistoryRow>,
    val query: String,
    /** True while a capture session (foreground service) is running. */
    val sessionActive: Boolean,
    /** True until the history database has answered once; nothing is drawn in the history area meanwhile. */
    val loading: Boolean = false,
    /** Fixed "now" for relative times (tests). Null means the screen keeps its own clock, ticking once a minute. */
    val nowMillis: Long? = null,
)

/**
 * Home: a large Capture action, Open image, then the history grid with search. Settings and License sit in the
 * top row. Stateless: the activity owns the data and the actions.
 */
@Composable
fun HomeScreen(
    state: HomeState,
    thumbnails: ThumbnailLoader,
    onCapture: () -> Unit,
    onStopSession: () -> Unit,
    onOpenImage: () -> Unit,
    onQuickSend: () -> Unit,
    onOpenItem: (String) -> Unit,
    onDeleteItem: (String) -> Unit,
    onClearAll: () -> Unit,
    onQueryChange: (String) -> Unit,
    onSettings: () -> Unit,
    onLicense: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var pendingDelete by rememberSaveable { mutableStateOf<String?>(null) }
    var confirmClear by rememberSaveable { mutableStateOf(false) }
    val span: LazyGridItemSpanScope.() -> GridItemSpan = { GridItemSpan(maxLineSpan) }
    val hasHistory = state.items.isNotEmpty() || state.query.isNotBlank()
    // One clock for every tile, refreshed once a minute, instead of a new "now" on every recomposition.
    val ticking by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(CLOCK_TICK_MILLIS)
            value = System.currentTimeMillis()
        }
    }
    val now = state.nowMillis ?: ticking

    Scaffold(
        modifier = modifier,
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { inner ->
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 148.dp),
            modifier = Modifier.fillMaxSize().padding(inner).testTag("home-grid"),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 32.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(span = span) { TopRow(onSettings = onSettings, onLicense = onLicense) }
            item(span = span) {
                Actions(
                    sessionActive = state.sessionActive,
                    onCapture = onCapture,
                    onStopSession = onStopSession,
                    onOpenImage = onOpenImage,
                    onQuickSend = onQuickSend,
                )
            }
            item(span = span) {
                RecentHeader(
                    query = state.query,
                    showSearch = hasHistory,
                    canClear = state.items.isNotEmpty(),
                    onQueryChange = onQueryChange,
                    onClearAll = { confirmClear = true },
                )
            }
            if (state.loading) {
                // Draw nothing yet: showing the empty state for a moment would flash on every cold start.
            } else if (!hasHistory) {
                item(span = span) { EmptyState() }
            } else if (state.items.isEmpty()) {
                item(span = span) {
                    Text(
                        text = stringResource(R.string.home_no_results),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 16.dp),
                    )
                }
            } else {
                items(state.items, key = { it.id }) { row ->
                    HistoryTile(
                        row = row,
                        nowMillis = now,
                        thumbnails = thumbnails,
                        onOpen = { onOpenItem(row.id) },
                        onDelete = { pendingDelete = row.id },
                    )
                }
            }
        }
    }

    pendingDelete?.let { id ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text(stringResource(R.string.dialog_delete_title)) },
            text = { Text(stringResource(R.string.dialog_delete_body)) },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    onDeleteItem(id)
                }) { Text(stringResource(R.string.dialog_delete_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text(stringResource(R.string.dialog_cancel)) }
            },
        )
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text(stringResource(R.string.dialog_clear_title)) },
            text = { Text(stringResource(R.string.dialog_clear_body)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmClear = false
                    onClearAll()
                }) { Text(stringResource(R.string.dialog_clear_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmClear = false }) { Text(stringResource(R.string.dialog_cancel)) }
            },
        )
    }
}

@Composable
private fun TopRow(onSettings: () -> Unit, onLicense: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BrandMark(modifier = Modifier.size(36.dp))
        Text(
            text = APP_NAME,
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.weight(1f).padding(start = 10.dp),
        )
        TextButton(onClick = onLicense) { Text(stringResource(R.string.home_license)) }
        IconButton(onClick = onSettings) {
            Icon(Icons.Default.Settings, contentDescription = stringResource(R.string.home_settings))
        }
    }
}

@Composable
private fun Actions(
    sessionActive: Boolean,
    onCapture: () -> Unit,
    onStopSession: () -> Unit,
    onOpenImage: () -> Unit,
    onQuickSend: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Button(
            onClick = onCapture,
            modifier = Modifier.fillMaxWidth().height(64.dp),
            shape = RoundedCornerShape(14.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            ),
        ) {
            Text(stringResource(R.string.home_capture), style = MaterialTheme.typography.titleLarge)
        }
        Text(
            text = stringResource(R.string.home_capture_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp, start = 4.dp, end = 4.dp),
        )
        if (sessionActive) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.home_session_active),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f).padding(start = 4.dp),
                )
                TextButton(onClick = onStopSession) { Text(stringResource(R.string.home_session_stop)) }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(
                onClick = onOpenImage,
                modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(stringResource(R.string.home_open_image), style = MaterialTheme.typography.titleMedium, maxLines = 1)
            }
            OutlinedButton(
                onClick = onQuickSend,
                modifier = Modifier.weight(1f).heightIn(min = 52.dp).testTag("home-quick-send"),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(stringResource(R.string.home_quick_send), style = MaterialTheme.typography.titleMedium, maxLines = 1)
            }
        }
    }
}

@Composable
private fun RecentHeader(
    query: String,
    showSearch: Boolean,
    canClear: Boolean,
    onQueryChange: (String) -> Unit,
    onClearAll: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(top = 20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(
                text = stringResource(R.string.home_recent),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier.weight(1f),
            )
            if (canClear) {
                TextButton(onClick = onClearAll) { Text(stringResource(R.string.home_clear_all)) }
            }
        }
        if (showSearch) {
            OutlinedTextField(
                value = query,
                onValueChange = onQueryChange,
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp).testTag("home-search"),
                singleLine = true,
                placeholder = { Text(stringResource(R.string.home_search_placeholder)) },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                shape = RoundedCornerShape(12.dp),
            )
        }
    }
}

@Composable
private fun EmptyState() {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp)) {
        Text(
            text = stringResource(R.string.home_empty_title),
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Text(
            text = stringResource(R.string.home_empty_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

@Composable
private fun HistoryTile(
    row: HistoryRow,
    nowMillis: Long,
    thumbnails: ThumbnailLoader,
    onOpen: () -> Unit,
    onDelete: () -> Unit,
) {
    val bitmap by produceState<ImageBitmap?>(null, row.id) { value = thumbnails.load(row.id) }
    val whenText = DateUtils.getRelativeTimeSpanString(
        row.createdAt,
        nowMillis,
        DateUtils.MINUTE_IN_MILLIS,
        DateUtils.FORMAT_ABBREV_RELATIVE,
    ).toString()
    val openLabel = stringResource(R.string.tile_open_description, whenText)

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(3f / 4f)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .clickable(onClickLabel = openLabel, onClick = onOpen),
    ) {
        bitmap?.let {
            Image(
                bitmap = it,
                contentDescription = openLabel,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Text(
            text = whenText,
            style = MaterialTheme.typography.labelMedium,
            color = Color.White,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .background(Color(0x99000000))
                .padding(horizontal = 10.dp, vertical = 6.dp),
        )
        IconButton(
            onClick = onDelete,
            modifier = Modifier.align(Alignment.TopEnd),
        ) {
            Box(
                modifier = Modifier.size(32.dp).clip(CircleShape).background(Color(0x99000000)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = stringResource(R.string.tile_delete_description),
                    tint = Color.White,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}
