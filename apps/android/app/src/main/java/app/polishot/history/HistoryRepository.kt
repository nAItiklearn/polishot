package app.polishot.history

import app.polishot.capture.CaptureStore
import app.polishot.ocr.OcrMapping
import app.polishot.ocr.OcrWord
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

    suspend fun get(id: String): HistoryEntity? = dao.get(id)

    suspend fun saveDoc(id: String, docJson: String) {
        dao.updateDoc(id, docJson)
    }

    suspend fun saveOcr(id: String, words: List<OcrWord>) {
        dao.updateOcr(id, OcrMapping.toPlainText(words), OcrMapping.toJson(words))
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
