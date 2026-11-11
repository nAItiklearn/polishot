package app.polishot.ocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Long screenshots are read in overlapping bands at full resolution. The invariant that matters: every line of text
 * belongs to exactly one band, however the bands happen to fall.
 */
class OcrTilingTest {
    private val heights = listOf(4097, 5000, 6144, 9999, 10_000, 20_000, 65_536, 100_000)

    @Test
    fun `ordinary and wide images are read in one piece`() {
        assertNull(OcrTiling.tiles(1080, 2400))
        assertNull("exactly the limit is still one piece", OcrTiling.tiles(1080, OcrTiling.MAX_SIDE))
        assertNull("a wide image is shrunk instead", OcrTiling.tiles(OcrTiling.MAX_SIDE + 1, 9000))
        assertNull(OcrTiling.tiles(0, 9000))
        assertNull(OcrTiling.tiles(-5, 9000))
    }

    @Test
    fun `a narrow image one row over the limit is cut`() {
        val tiles = OcrTiling.tiles(1080, OcrTiling.MAX_SIDE + 1)
        assertNotNull(tiles)
        assertTrue(tiles!!.size >= 2)
    }

    @Test
    fun `bands stay inside the image and inside the size ML Kit reads well`() {
        for (height in heights) {
            for (tile in requireNotNull(OcrTiling.tiles(1080, height))) {
                assertTrue("h=$height $tile", tile.top >= 0 && tile.bottom <= height && tile.top < tile.bottom)
                assertTrue("h=$height $tile", tile.bottom - tile.top <= OcrTiling.TILE_HEIGHT)
                assertTrue("h=$height $tile", OcrTiling.TILE_HEIGHT <= OcrTiling.MAX_SIDE)
                assertTrue("h=$height $tile", tile.keepFrom >= tile.top && tile.keepTo <= tile.bottom)
                assertTrue("h=$height $tile", tile.keepFrom < tile.keepTo)
            }
        }
    }

    @Test
    fun `the owned ranges tile the image with no gap and no overlap`() {
        for (height in heights) {
            val tiles = requireNotNull(OcrTiling.tiles(1080, height))
            assertEquals("h=$height", 0, tiles.first().keepFrom)
            assertEquals("h=$height", height, tiles.last().keepTo)
            for ((a, b) in tiles.zipWithNext()) {
                assertEquals("h=$height between $a and $b", a.keepTo, b.keepFrom)
                // The bands themselves overlap by more than two lines of text, so a cut line is whole in a neighbour.
                assertTrue("h=$height", a.bottom - b.top >= OcrTiling.OVERLAP)
            }
        }
    }

    @Test
    fun `every possible line centre is owned by exactly one band`() {
        for (height in listOf(4097, 6144, 9999, 20_000)) {
            val tiles = requireNotNull(OcrTiling.tiles(1080, height))
            var y = 0.0
            while (y < height) {
                val owners = tiles.count { it.keeps(y) }
                assertEquals("h=$height y=$y", 1, owners)
                y += 3.5
            }
        }
    }

    @Test
    fun `a line cut by a band edge is fully visible to the band that owns it`() {
        // A line whose centre is just below the seam is owned by the lower band, which saw it with OVERLAP/2 rows to spare.
        for (height in listOf(6144, 9999)) {
            val tiles = requireNotNull(OcrTiling.tiles(1080, height))
            for ((upper, lower) in tiles.zipWithNext()) {
                val seam = upper.keepTo
                val lineHalfHeight = 30
                val centre = seam + 1
                assertTrue(lower.keeps(centre.toDouble()))
                assertTrue("the whole line is inside the lower band", centre - lineHalfHeight >= lower.top)
            }
        }
    }

    // ---- ownedLines -------------------------------------------------------------------------------

    private fun el(text: String, top: Int, bottom: Int) = RawElement(text, 0, top, 50, bottom)

    @Test
    fun `lines owned by the band are moved down into source rows`() {
        val tile = OcrTiling.Tile(top = 2880, bottom = 5952, keepFrom = 2976, keepTo = 5856)
        // Band-local rows 200..220 are source rows 3080..3100, inside the owned range.
        val kept = OcrTiling.ownedLines(listOf(RawLine(listOf(el("hello", 200, 220)))), tile)
        assertEquals(1, kept.size)
        assertEquals(RawElement("hello", 0, 3080, 50, 3100), kept.single().elements.single())
    }

    @Test
    fun `lines owned by a neighbouring band are dropped`() {
        val tile = OcrTiling.Tile(top = 2880, bottom = 5952, keepFrom = 2976, keepTo = 5856)
        val lines = listOf(
            RawLine(listOf(el("above", 10, 30))), // source rows 2890..2910, centre 2900 < keepFrom
            RawLine(listOf(el("owned", 400, 420))),
            RawLine(listOf(el("below", 2990, 3010))), // source rows 5870..5890, centre 5880 >= keepTo
        )
        val kept = OcrTiling.ownedLines(lines, tile)
        assertEquals(listOf("owned"), kept.map { it.elements.single().text })
    }

    @Test
    fun `a line split across the seam keeps only the elements the band owns`() {
        val tile = OcrTiling.Tile(top = 0, bottom = 3072, keepFrom = 0, keepTo = 2976)
        val line = RawLine(listOf(el("inside", 2900, 2940), el("outside", 3000, 3040)))
        val kept = OcrTiling.ownedLines(listOf(line), tile)
        assertEquals(1, kept.size)
        assertEquals(listOf("inside"), kept.single().elements.map { it.text })
    }

    @Test
    fun `an empty page gives no lines`() {
        val tile = OcrTiling.Tile(0, 3072, 0, 2976)
        assertTrue(OcrTiling.ownedLines(emptyList(), tile).isEmpty())
        assertTrue(OcrTiling.ownedLines(listOf(RawLine(emptyList())), tile).isEmpty())
    }
}
