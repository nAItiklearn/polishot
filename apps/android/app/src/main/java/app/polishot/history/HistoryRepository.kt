package app.polishot.history

import app.polishot.capture.CaptureStore
import app.polishot.ocr.OcrMapping
import app.polishot.ocr.OcrWord
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow

/** Saved screenshots plus their recognised text. Image bytes stay in [CaptureStore]; rows are metadata. */
class HistoryRepository(
    private val dao: HistoryDao,
    private val store: CaptureStore,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    /** Registers a freshly stored capture so it shows up in the grid. */
    suspend fun register(id: String, width: Int, height: Int) {
        dao.insert(
            HistoryEntity(
                id = id,
                createdAt = clock(),
                width = width,
                height = height,
                ocrText = "",
                wordsJson = null,
                docJson = null,
            ),
        )
        prune(MAX_ITEMS)
    }

    /** Live list for the grid. A blank or unsearchable [query] shows the most recent items. */
    fun observe(query: String): Flow<List<HistoryRow>> {
        val match = FtsQuery.build(query)
        return if (match == null) dao.observeRecent(PAGE) else dao.observeSearch(match, PAGE)
    }

    /** The small columns of one row, or null when the screenshot is not registered (or the row cannot be read). */
    suspend fun meta(id: String): HistoryMeta? = guarded { dao.meta(id) }

    /** The saved editor document. A column that cannot be read (too large for the cursor window) is cleared. */
    suspend fun docJson(id: String): String? = readBig({ dao.docJson(id) }) { dao.clearDoc(id) }

    /** The cached OCR words, or null when there are none or the stored text is damaged. */
    suspend fun words(id: String): List<OcrWord>? {
        val json = readBig({ dao.wordsJson(id) }) { dao.clearWords(id) } ?: return null
        return OcrMapping.fromJson(json)
    }

    private suspend fun <T> guarded(block: suspend () -> T?): T? =
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }

    private suspend fun readBig(read: suspend () -> String?, heal: suspend () -> Unit): String? =
        try {
            read()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Typically SQLiteBlobTooBigException from a very large value: drop it so the next open is clean.
            try {
                heal()
            } catch (inner: CancellationException) {
                throw inner
            } catch (inner: Exception) {
                // nothing more to do
            }
            null
        }

    suspend fun saveDoc(id: String, docJson: String) {
        dao.updateDoc(id, docJson)
    }

    suspend fun saveOcr(id: String, words: List<OcrWord>) {
        val stored = OcrMapping.fitForStorage(words)
        dao.updateOcr(id, OcrMapping.toPlainText(stored), OcrMapping.toJson(stored))
    }

    suspend fun delete(id: String) {
        dao.delete(id)
        store.delete(id)
    }

    /** Deletes every row and every stored image and thumbnail. */
    suspend fun clearAll() {
        dao.clear()
        store.deleteAll()
    }

    /** Drops the oldest items beyond [keep]. */
    suspend fun prune(keep: Int) {
        for (id in dao.idsBeyond(keep)) delete(id)
    }

    /** Removes image files that no row refers to (an editor session that was killed mid-way, a finished batch). */
    suspend fun sweepOrphans() {
        store.sweepOrphans(dao.allIds().toSet(), ORPHAN_AGE_MILLIS)
    }

    companion object {
        const val PAGE = 200
        const val MAX_ITEMS = 300
        private const val ORPHAN_AGE_MILLIS = 6L * 60 * 60 * 1000
    }
}
