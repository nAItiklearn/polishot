package app.polishot.capture

import android.content.Context
import android.graphics.Bitmap
import android.hardware.display.DisplayManager
import android.media.Image
import android.util.DisplayMetrics
import android.view.Display
import java.nio.ByteBuffer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide capture state shared by the service, the home screen and the editor.
 * The service runs in the app's own process, so plain in-memory flows are enough.
 */
object CaptureSession {
    private val mutableActive = MutableStateFlow(false)
    private val mutableEditorVisible = MutableStateFlow(false)

    /** True while the foreground service holds a screen-capture permission (the bubble session is running). */
    val active: StateFlow<Boolean> = mutableActive.asStateFlow()

    /** True while an editor is on screen; the floating bubble steps aside so it never covers the editor. */
    val editorVisible: StateFlow<Boolean> = mutableEditorVisible.asStateFlow()

    internal fun setActive(value: Boolean) {
        mutableActive.value = value
    }

    fun setEditorVisible(value: Boolean) {
        mutableEditorVisible.value = value
    }
}

/** Full physical display size and density. */
internal data class ScreenSize(val width: Int, val height: Int, val densityDpi: Int)

internal object ScreenMetrics {
    /** The real display size for the current rotation, including system bars and cutouts. */
    @Suppress("DEPRECATION") // getRealMetrics works on every supported release and needs no UI context
    fun real(context: Context): ScreenSize {
        val metrics = DisplayMetrics()
        val display = context.getSystemService(DisplayManager::class.java)?.getDisplay(Display.DEFAULT_DISPLAY)
        if (display != null) {
            display.getRealMetrics(metrics)
        } else {
            // No default display object (very rare, e.g. while the display is being reconfigured).
            val fallback = context.resources.displayMetrics
            metrics.widthPixels = fallback.widthPixels
            metrics.heightPixels = fallback.heightPixels
            metrics.densityDpi = fallback.densityDpi
        }
        return ScreenSize(metrics.widthPixels, metrics.heightPixels, metrics.densityDpi)
    }
}

/**
 * Row arithmetic for ImageReader frames, kept free of Android types so plain JVM tests cover it.
 *
 * An RGBA_8888 plane has `rowStride` bytes per row, which can be wider than `width * 4` (padding). The last row is
 * allowed to be shorter than a full stride: some drivers only map `rowStride * (height - 1) + width * 4` bytes. A
 * straight copy into a padded bitmap then reads past the end of the buffer and throws, so those frames are packed
 * row by row instead.
 */
internal object RowPacker {
    private const val BYTES_PER_PIXEL = 4

    /** True when the whole padded image (`rowStride * height` bytes) is available for one straight copy. */
    fun canCopyPadded(available: Int, rowStride: Int, pixelStride: Int, width: Int, height: Int): Boolean =
        pixelStride == BYTES_PER_PIXEL &&
            rowStride % BYTES_PER_PIXEL == 0 &&
            rowStride >= width * BYTES_PER_PIXEL &&
            rowStride.toLong() * height <= available.toLong()

    /**
     * Copies [height] rows of [width] RGBA pixels out of [src] into a tight buffer (no padding between rows).
     * [src] is not modified. Throws [IllegalArgumentException] for a layout this code does not understand and
     * [IllegalStateException] when the buffer is too short to hold the pixels.
     */
    fun pack(src: ByteBuffer, rowStride: Int, pixelStride: Int, width: Int, height: Int): ByteBuffer {
        require(pixelStride == BYTES_PER_PIXEL) { "unsupported pixel stride $pixelStride" }
        require(width > 0 && height > 0 && rowStride >= width * BYTES_PER_PIXEL) { "bad frame layout" }
        val rowBytes = width * BYTES_PER_PIXEL
        val needed = rowStride.toLong() * (height - 1) + rowBytes
        check(needed <= src.limit()) { "frame buffer is shorter than its layout" }

        val out = ByteBuffer.allocate(rowBytes * height)
        val source = src.duplicate()
        val row = ByteArray(rowBytes)
        for (y in 0 until height) {
            source.position(y * rowStride)
            source.get(row, 0, rowBytes)
            out.put(row)
        }
        out.rewind()
        return out
    }
}

internal object FrameConverter {
    /**
     * Copies an RGBA_8888 [Image] from an ImageReader into a [Bitmap]. The buffer rows can be wider than the image
     * (row padding), so the straight copy goes through a bitmap that is wide enough and is cropped afterwards;
     * frames whose last row is short, or whose layout is unusual, are packed row by row ([RowPacker]).
     */
    fun toBitmap(image: Image): Bitmap {
        val plane = image.planes[0]
        val width = image.width
        val height = image.height
        val rowStride = plane.rowStride
        val pixelStride = plane.pixelStride
        val buffer = plane.buffer

        if (RowPacker.canCopyPadded(buffer.limit(), rowStride, pixelStride, width, height)) {
            val paddedWidth = rowStride / pixelStride
            val padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
            buffer.rewind()
            padded.copyPixelsFromBuffer(buffer)
            if (paddedWidth == width) return padded
            val cropped = Bitmap.createBitmap(padded, 0, 0, width, height)
            padded.recycle()
            return cropped
        }

        val packed = RowPacker.pack(buffer, rowStride, pixelStride, width, height)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.copyPixelsFromBuffer(packed)
        return bitmap
    }
}
