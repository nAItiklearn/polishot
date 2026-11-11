package app.polishot.capture

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import kotlin.math.hypot
import kotlin.math.min

/**
 * The floating capture button: a draggable overlay window (TYPE_APPLICATION_OVERLAY, needs the "display over other
 * apps" permission) that snaps to the nearest screen edge when released. A tap calls [onTap].
 *
 * While a frame is grabbed the window stays attached and visible to the window manager but is fully transparent
 * (alpha 0), so it is not in the screenshot yet the app still owns a visible overlay window when it starts the editor
 * from the background. A view set to INVISIBLE would not do: the system then drops the window's surface, and
 * Android 15 and later only let an app with the overlay permission start an activity from the background while
 * that overlay window is visible.
 */
class CaptureBubble(
    private val context: Context,
    private val prefs: SharedPreferences,
    private val onTap: () -> Unit,
) {
    private val windowManager: WindowManager = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private val sizePx = (SIZE_DP * density).toInt()
    private val marginPx = (MARGIN_DP * density).toInt()

    private val params = WindowManager.LayoutParams(
        sizePx,
        sizePx,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.START }

    private val view = BubbleView(context, sizePx, object : BubbleView.Callbacks {
        override fun onDragStart() = cancelSnap()
        override fun onDragBy(dx: Float, dy: Float, startX: Int, startY: Int) = moveTo(startX + dx.toInt(), startY + dy.toInt())
        override fun onDragEnd() = snapToEdge()
        override fun onClick() = onTap()
        override fun currentPosition(): Pair<Int, Int> = params.x to params.y
    })

    private var attached = false
    private var snap: ValueAnimator? = null

    /** Adds the window. Returns false when the overlay permission is missing or the system refuses. */
    fun attach(): Boolean {
        if (attached) {
            view.visibility = View.VISIBLE
            view.alpha = REST_ALPHA
            return true
        }
        val screen = ScreenMetrics.real(context)
        val (x, y) = restorePosition(screen)
        params.x = x
        params.y = y
        view.visibility = View.VISIBLE
        view.alpha = REST_ALPHA
        return try {
            windowManager.addView(view, params)
            attached = true
            true
        } catch (e: RuntimeException) {
            // BadTokenException / SecurityException when "display over other apps" was revoked.
            false
        }
    }

    /** Hides the pixels but keeps the window attached and visible to the system (see class comment). */
    fun hideForCapture() {
        view.alpha = 0f
    }

    fun showAgain() {
        if (attached) {
            view.visibility = View.VISIBLE
            view.alpha = REST_ALPHA
        }
    }

    fun detach() {
        cancelSnap()
        if (!attached) return
        attached = false
        runCatching { windowManager.removeViewImmediate(view) }
    }

    val isAttached: Boolean get() = attached

    private fun moveTo(x: Int, y: Int) {
        val screen = ScreenMetrics.real(context)
        params.x = x.coerceIn(0, (screen.width - sizePx).coerceAtLeast(0))
        params.y = y.coerceIn(0, (screen.height - sizePx).coerceAtLeast(0))
        update()
    }

    private fun snapToEdge() {
        val screen = ScreenMetrics.real(context)
        val rightEdge = (screen.width - sizePx - marginPx).coerceAtLeast(marginPx)
        val toRight = params.x + sizePx / 2 > screen.width / 2
        val target = if (toRight) rightEdge else marginPx
        cancelSnap()
        snap = ValueAnimator.ofInt(params.x, target).apply {
            duration = SNAP_MILLIS
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                params.x = it.animatedValue as Int
                update()
            }
            start()
        }
        persistPosition(screen, toRight)
    }

    private fun cancelSnap() {
        snap?.cancel()
        snap = null
    }

    private fun update() {
        if (attached) runCatching { windowManager.updateViewLayout(view, params) }
    }

    private fun restorePosition(screen: ScreenSize): Pair<Int, Int> {
        val right = prefs.getBoolean(KEY_RIGHT, true)
        val fraction = prefs.getFloat(KEY_Y, DEFAULT_Y_FRACTION).coerceIn(0f, 1f)
        val x = if (right) (screen.width - sizePx - marginPx).coerceAtLeast(0) else marginPx
        val y = (fraction * (screen.height - sizePx)).toInt().coerceAtLeast(0)
        return x to y
    }

    private fun persistPosition(screen: ScreenSize, right: Boolean) {
        val room = (screen.height - sizePx).coerceAtLeast(1)
        prefs.edit()
            .putBoolean(KEY_RIGHT, right)
            .putFloat(KEY_Y, (params.y.toFloat() / room).coerceIn(0f, 1f))
            .apply()
    }

    private companion object {
        const val SIZE_DP = 56
        const val MARGIN_DP = 6
        const val SNAP_MILLIS = 180L
        const val DEFAULT_Y_FRACTION = 0.4f
        const val REST_ALPHA = 0.94f
        const val KEY_RIGHT = "bubble_right"
        const val KEY_Y = "bubble_y_fraction"
    }
}

/** The bubble's pixels and touch handling. Dragging is reported to [Callbacks]; the window code stays outside. */
@SuppressLint("ViewConstructor")
internal class BubbleView(
    context: Context,
    private val sizePx: Int,
    private val callbacks: Callbacks,
) : View(context) {
    interface Callbacks {
        fun onDragStart()
        fun onDragBy(dx: Float, dy: Float, startX: Int, startY: Int)
        fun onDragEnd()
        fun onClick()
        fun currentPosition(): Pair<Int, Int>
    }

    private val density = context.resources.displayMetrics.density
    private val slop = ViewConfiguration.get(context).scaledTouchSlop

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = ACCENT
        setShadowLayer(5f * density, 0f, 2f * density, SHADOW)
    }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = ON_ACCENT
        style = Paint.Style.STROKE
        strokeWidth = 2.5f * density
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ON_ACCENT }
    private val brackets = Path()

    private var downX = 0f
    private var downY = 0f
    private var startX = 0
    private var startY = 0
    private var dragging = false

    init {
        setLayerType(LAYER_TYPE_SOFTWARE, null) // shadow layers on shapes need a software layer
        isClickable = true
        contentDescription = context.getString(app.polishot.R.string.bubble_description)
        alpha = REST_ALPHA
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(sizePx, sizePx)
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val radius = min(width, height) / 2f - 7f * density
        canvas.drawCircle(cx, cy, radius, fill)

        // Viewfinder corners.
        val half = radius * 0.5f
        val arm = radius * 0.3f
        brackets.reset()
        for (sx in intArrayOf(-1, 1)) {
            for (sy in intArrayOf(-1, 1)) {
                val cornerX = cx + sx * half
                val cornerY = cy + sy * half
                brackets.moveTo(cornerX - sx * arm, cornerY)
                brackets.lineTo(cornerX, cornerY)
                brackets.lineTo(cornerX, cornerY - sy * arm)
            }
        }
        canvas.drawPath(brackets, stroke)
        canvas.drawCircle(cx, cy, radius * 0.13f, dot)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.rawX
                downY = event.rawY
                val (x, y) = callbacks.currentPosition()
                startX = x
                startY = y
                dragging = false
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = event.rawX - downX
                val dy = event.rawY - downY
                if (!dragging && hypot(dx, dy) > slop) {
                    dragging = true
                    callbacks.onDragStart()
                }
                if (dragging) callbacks.onDragBy(dx, dy, startX, startY)
                return true
            }
            MotionEvent.ACTION_UP -> {
                if (dragging) callbacks.onDragEnd() else performClick()
                dragging = false
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                if (dragging) callbacks.onDragEnd()
                dragging = false
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun performClick(): Boolean {
        super.performClick()
        callbacks.onClick()
        return true
    }

    private companion object {
        const val REST_ALPHA = 0.94f

        /** Persimmon, the brand accent (packages/brand palette.light.accent). */
        const val ACCENT = 0xFFC8471D.toInt()
        const val ON_ACCENT = 0xFFFFFFFF.toInt()
        const val SHADOW = 0x66000000
    }
}
