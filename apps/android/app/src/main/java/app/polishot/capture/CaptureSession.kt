package app.polishot.capture

import android.content.Context
import android.graphics.Bitmap
import android.hardware.display.DisplayManager
import android.media.Image
import android.util.DisplayMetrics
import android.view.Display
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
        val displays = context.getSystemService(DisplayManager::class.java)
        val display = displays.getDisplay(Display.DEFAULT_DISPLAY)
        val metrics = DisplayMetrics()
        display.getRealMetrics(metrics)
        return ScreenSize(metrics.widthPixels, metrics.heightPixels, metrics.densityDpi)
    }
}

internal object FrameConverter {
    /**
     * Copies an RGBA_8888 [Image] from an ImageReader into a [Bitmap]. The buffer rows can be wider than the image
     * (row padding), so the bitmap is created wide enough for a straight copy and then cropped.
     */
    fun toBitmap(image: Image): Bitmap {
        val plane = image.planes[0]
        val pixelStride = plane.pixelStride
        val rowPadding = plane.rowStride - pixelStride * image.width
        val padded = Bitmap.createBitmap(image.width + rowPadding / pixelStride, image.height, Bitmap.Config.ARGB_8888)
        val buffer = plane.buffer
        buffer.rewind()
        padded.copyPixelsFromBuffer(buffer)
        if (rowPadding == 0) return padded
        val cropped = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
        padded.recycle()
        return cropped
    }
}
