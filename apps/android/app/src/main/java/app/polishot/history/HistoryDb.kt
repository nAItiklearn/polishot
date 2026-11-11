package app.polishot.history

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Fts4
import androidx.room.FtsOptions
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

/**
 * One saved screenshot. The image itself lives in [app.polishot.capture.CaptureStore]; this row holds its
 * metadata, the recognised text (searchable through [HistoryFts]), the cached OCR words, and the editor document
 * so a screenshot stays re-editable.
 *
 * The integer primary key is named `rowid` so the FTS4 table can use this table as its external content.
 */
@Entity(
    tableName = "history",
    indices = [Index(value = ["id"], unique = true), Index(value = ["createdAt"])],
)
data class HistoryEntity(
    @PrimaryKey(autoGenerate = true)
    @ColumnInfo(name = "rowid")
    val rowId: Long = 0,
    val id: String,
    val createdAt: Long,
    val width: Int,
    val height: Int,
    val ocrText: String,
    val wordsJson: String?,
    val docJson: String?,
)

/** Full-text index over [HistoryEntity.ocrText]; Room keeps it in sync with triggers. */
@Fts4(contentEntity = HistoryEntity::class, tokenizer = FtsOptions.TOKENIZER_UNICODE61)
@Entity(tableName = "history_fts")
data class HistoryFts(
    val ocrText: String,
)

/** The small fixed-size columns of a row, for code that must not touch the large JSON columns. */
data class HistoryMeta(
    val id: String,
    val createdAt: Long,
    val width: Int,
    val height: Int,
)

/** Lightweight projection for the history grid: no OCR words and no document JSON. */
data class HistoryRow(
    val id: String,
    val createdAt: Long,
    val width: Int,
    val height: Int,
    val excerpt: String,
    val hasDoc: Boolean,
)

@Dao
interface HistoryDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(entity: HistoryEntity): Long

    @Query(
        "SELECT id, createdAt, width, height, substr(ocrText, 1, 160) AS excerpt, " +
            "(docJson IS NOT NULL) AS hasDoc FROM history ORDER BY createdAt DESC LIMIT :limit",
    )
    fun observeRecent(limit: Int): Flow<List<HistoryRow>>

    @Query(
        "SELECT id, createdAt, width, height, substr(ocrText, 1, 160) AS excerpt, " +
            "(docJson IS NOT NULL) AS hasDoc FROM history " +
            "WHERE rowid IN (SELECT rowid FROM history_fts WHERE history_fts MATCH :match) " +
            "ORDER BY createdAt DESC LIMIT :limit",
    )
    fun observeSearch(match: String, limit: Int): Flow<List<HistoryRow>>

    // Never SELECT *: a row with a large document or word list can exceed the 2 MB cursor window, and reading it
    // would throw. The big columns are read one at a time so a failure costs only that column, not the screenshot.
    @Query("SELECT id, createdAt, width, height FROM history WHERE id = :id LIMIT 1")
    suspend fun meta(id: String): HistoryMeta?

    @Query("SELECT docJson FROM history WHERE id = :id LIMIT 1")
    suspend fun docJson(id: String): String?

    @Query("SELECT wordsJson FROM history WHERE id = :id LIMIT 1")
    suspend fun wordsJson(id: String): String?

    @Query("UPDATE history SET docJson = NULL WHERE id = :id")
    suspend fun clearDoc(id: String): Int

    @Query("UPDATE history SET wordsJson = NULL WHERE id = :id")
    suspend fun clearWords(id: String): Int

    @Query("UPDATE history SET docJson = :docJson WHERE id = :id")
    suspend fun updateDoc(id: String, docJson: String): Int

    @Query("UPDATE history SET ocrText = :text, wordsJson = :wordsJson WHERE id = :id")
    suspend fun updateOcr(id: String, text: String, wordsJson: String): Int

    @Query("DELETE FROM history WHERE id = :id")
    suspend fun delete(id: String): Int

    @Query("DELETE FROM history")
    suspend fun clear(): Int

    @Query("SELECT id FROM history")
    suspend fun allIds(): List<String>

    @Query("SELECT id FROM history ORDER BY createdAt DESC LIMIT -1 OFFSET :keep")
    suspend fun idsBeyond(keep: Int): List<String>
}

@Database(entities = [HistoryEntity::class, HistoryFts::class], version = 1, exportSchema = true)
abstract class HistoryDatabase : RoomDatabase() {
    abstract fun dao(): HistoryDao

    companion object {
        private const val FILE_NAME = "history.db"

        fun create(context: Context): HistoryDatabase =
            Room.databaseBuilder(context.applicationContext, HistoryDatabase::class.java, FILE_NAME).build()

        fun inMemory(context: Context): HistoryDatabase =
            Room.inMemoryDatabaseBuilder(context.applicationContext, HistoryDatabase::class.java).build()
    }
}
