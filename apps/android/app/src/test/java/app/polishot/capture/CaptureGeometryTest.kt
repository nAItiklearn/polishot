package app.polishot.capture

import java.nio.ByteBuffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Frame row packing, image size limits and the bubble's position rules: pure arithmetic, no Android needed. */
class CaptureGeometryTest {
    // ---- RowPacker ------------------------------------------------------------------------------

    /** A buffer of [rows] rows of [stride] bytes where byte i of row y is `y * 16 + i` (wrapping), to spot misplaced copies. */
    private fun frame(stride: Int, rows: Int, trailing: Int = stride): ByteBuffer {
        val size = stride * (rows - 1) + trailing
        val bytes = ByteArray(size) { i -> ((i / stride) * 16 + (i % stride)).toByte() }
        return ByteBuffer.wrap(bytes)
    }

    @Test
    fun `packing drops the row padding and keeps every pixel`() {
        val width = 3
        val stride = 20 // 12 bytes of pixels plus 8 of padding
        val packed = RowPacker.pack(frame(stride, rows = 4), stride, 4, width, 4)

        assertEquals(width * 4 * 4, packed.remaining())
        val out = ByteArray(packed.remaining()).also { packed.get(it) }
        for (y in 0 until 4) {
            for (x in 0 until width * 4) {
                assertEquals("row $y byte $x", (y * 16 + x).toByte(), out[y * width * 4 + x])
            }
        }
    }

    @Test
    fun `a short last row still packs when it holds the pixels`() {
        // The driver maps only 12 bytes for the final row instead of the full 20-byte stride.
        val buffer = frame(stride = 20, rows = 3, trailing = 12)
        assertFalse(RowPacker.canCopyPadded(buffer.limit(), 20, 4, 3, 3))
        val packed = RowPacker.pack(buffer, 20, 4, 3, 3)
        assertEquals(3 * 3 * 4, packed.remaining())
    }

    @Test
    fun `a buffer shorter than its layout is an error not an overflow`() {
        val buffer = frame(stride = 20, rows = 3, trailing = 8) // last row has 8 of its 12 pixel bytes
        try {
            RowPacker.pack(buffer, 20, 4, 3, 3)
            fail("expected an IllegalStateException")
        } catch (expected: IllegalStateException) {
            // reported, so the capture ends with a message instead of a crash
        }
    }

    @Test
    fun `the straight copy is only chosen when the whole padded image is there`() {
        assertTrue(RowPacker.canCopyPadded(available = 20 * 3, rowStride = 20, pixelStride = 4, width = 3, height = 3))
        assertFalse(RowPacker.canCopyPadded(available = 20 * 3 - 1, rowStride = 20, pixelStride = 4, width = 3, height = 3))
        assertFalse("not RGBA_8888", RowPacker.canCopyPadded(100, 20, 2, 3, 3))
        assertFalse("stride not a whole number of pixels", RowPacker.canCopyPadded(100, 18, 4, 3, 3))
        assertFalse("stride narrower than the image", RowPacker.canCopyPadded(100, 8, 4, 3, 3))
    }

    @Test
    fun `an odd pixel stride is refused`() {
        try {
            RowPacker.pack(ByteBuffer.allocate(64), 16, 2, 4, 2)
            fail("expected an IllegalArgumentException")
        } catch (expected: IllegalArgumentException) {
            // fine
        }
    }

    @Test
    fun `packing does not disturb the source buffer position`() {
        val buffer = frame(20, 2)
        buffer.position(5)
        RowPacker.pack(buffer, 20, 4, 3, 2)
        assertEquals(5, buffer.position())
    }

    // ---- ImageLimits ----------------------------------------------------------------------------

    @Test
    fun `ordinary screenshots are accepted and kept at full size`() {
        assertTrue(ImageLimits.isAcceptable(1080, 2400))
        assertNull(ImageLimits.targetSize(1080, 2400))
        assertNull("exactly 24 megapixels is kept", ImageLimits.targetSize(6000, 4000))
    }

    @Test
    fun `big images are scaled down to the pixel budget and keep their shape`() {
        val (w, h) = requireNotNull(ImageLimits.targetSize(8000, 6000)) // 48 megapixels
        assertTrue(w.toLong() * h <= ImageLimits.MAX_IMPORT_PIXELS)
        assertEquals(8000.0 / 6000.0, w.toDouble() / h, 0.01)
        assertTrue(w > 0 && h > 0)
    }

    @Test
    fun `a very thin huge image never scales to a zero side`() {
        val (w, h) = requireNotNull(ImageLimits.targetSize(30_000, 1_000))
        assertTrue("w=$w h=$h", w >= 1 && h >= 1)
    }

    @Test
    fun `decompression bombs are refused before any pixel is decoded`() {
        assertFalse(ImageLimits.isAcceptable(40_000, 40_000))
        assertFalse("too many pixels", ImageLimits.isAcceptable(30_000, 30_000))
        assertFalse("one side too long", ImageLimits.isAcceptable(ImageLimits.HARD_MAX_SIDE + 1, 10))
        assertFalse(ImageLimits.isAcceptable(0, 100))
        assertFalse(ImageLimits.isAcceptable(100, -5))
        assertTrue(ImageLimits.isAcceptable(10_000, 10_000)) // 100 megapixels is the most a phone gets here
    }

    // ---- BubbleGeometry -------------------------------------------------------------------------

    private val size = 150
    private val margin = 18

    @Test
    fun `the bubble is kept fully on screen`() {
        assertEquals(0 to 0, BubbleGeometry.clamp(-40, -9, size, 1080, 2400))
        assertEquals(930 to 2250, BubbleGeometry.clamp(5000, 9000, size, 1080, 2400))
        assertEquals(400 to 800, BubbleGeometry.clamp(400, 800, size, 1080, 2400))
    }

    @Test
    fun `a screen smaller than the bubble pins it to the corner`() {
        assertEquals(0 to 0, BubbleGeometry.clamp(30, 30, size, 100, 100))
    }

    @Test
    fun `after a rotation the remembered edge and relative height are restored on the new screen`() {
        // Portrait: right edge, 40 percent down.
        val portrait = BubbleGeometry.restore(right = true, yFraction = 0.4f, size, margin, 1080, 2400)
        assertEquals(1080 - size - margin, portrait.first)
        assertEquals((0.4f * (2400 - size)).toInt(), portrait.second)

        // Landscape: the same edge and fraction, now on a 2400 x 1080 screen, still inside it.
        val landscape = BubbleGeometry.restore(right = true, yFraction = 0.4f, size, margin, 2400, 1080)
        assertEquals(2400 - size - margin, landscape.first)
        assertEquals((0.4f * (1080 - size)).toInt(), landscape.second)
        assertTrue(landscape.second + size <= 1080)
    }

    @Test
    fun `a left edge sits one margin in and nonsense fractions are clamped`() {
        assertEquals(margin, BubbleGeometry.edgeX(false, size, margin, 1080))
        val (x, y) = BubbleGeometry.restore(right = false, yFraction = 7f, size, margin, 1080, 2400)
        assertEquals(margin, x)
        assertEquals(2400 - size, y)
    }

    @Test
    fun `the saved height round-trips`() {
        val y = 900
        val fraction = BubbleGeometry.yFraction(y, size, 2400)
        val restored = BubbleGeometry.restore(true, fraction, size, margin, 1080, 2400).second
        assertEquals(y.toDouble(), restored.toDouble(), 1.0)
        assertEquals(0f, BubbleGeometry.yFraction(-50, size, 2400), 0f)
        assertEquals(1f, BubbleGeometry.yFraction(99_999, size, 2400), 0f)
    }

    @Test
    fun `packing result is independent of how the source was built`() {
        // Heap and read-only wrappers behave the same (ImageReader hands out a direct buffer).
        val heap = frame(20, 2)
        val readOnly = heap.asReadOnlyBuffer()
        val a = RowPacker.pack(heap, 20, 4, 3, 2)
        val b = RowPacker.pack(readOnly, 20, 4, 3, 2)
        assertArrayEquals(ByteArray(a.remaining()).also { a.get(it) }, ByteArray(b.remaining()).also { b.get(it) })
    }
}
