package app.polishot.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.polishot.R

/*
 * Polishot's Material 3 theme. The values mirror the `--ps-*` palette in packages/brand/src/index.ts
 * (palette.light / palette.dark): warm neutrals plus one accent, Persimmon. Dynamic colour is deliberately NOT
 * used, so the brand looks the same on every device and wallpaper.
 *
 * Material 3 needs roles the brand palette does not name (the surface container ramp, tonal containers); those
 * are derived by mixing the palette's own colours, never introducing a new hue.
 */

// ---- light ---------------------------------------------------------------------------------------
private val LightBg = Color(0xFFFAFAF9)
private val LightSurface = Color(0xFFFFFFFF)
private val LightSurface2 = Color(0xFFF3F3F1)
private val LightBorder = Color(0xFFE6E5E1)
private val LightText = Color(0xFF161615)
private val LightText2 = Color(0xFF57564F)
private val LightText3 = Color(0xFF6B6A63)
private val LightAccent = Color(0xFFC8471D)
private val LightAccentText = Color(0xFFB03C15)
private val LightAccentFg = Color(0xFFFFFFFF)
private val LightAccentTint = Color(0xFFF8E9E4) // accent at 12% over surface

// ---- dark ----------------------------------------------------------------------------------------
private val DarkBg = Color(0xFF0C0C0B)
private val DarkSurface = Color(0xFF151514)
private val DarkSurface2 = Color(0xFF1D1D1B)
private val DarkBorder = Color(0xFF2B2B28)
private val DarkText = Color(0xFFEDECE8)
private val DarkText2 = Color(0xFFA6A59F)
private val DarkText3 = Color(0xFF8C8B85)
private val DarkAccent = Color(0xFFEE7444)
private val DarkAccentText = Color(0xFFF28D63)
private val DarkAccentFg = Color(0xFF170A04)
private val DarkAccentTint = Color(0xFF38241C) // accent at 16% over surface

private val LightColors: ColorScheme = lightColorScheme(
    primary = LightAccent,
    onPrimary = LightAccentFg,
    primaryContainer = LightAccentTint,
    onPrimaryContainer = LightAccentText,
    inversePrimary = DarkAccent,
    secondary = LightText2,
    onSecondary = LightSurface,
    secondaryContainer = LightSurface2,
    onSecondaryContainer = LightText,
    tertiary = LightText3,
    onTertiary = LightSurface,
    tertiaryContainer = LightSurface2,
    onTertiaryContainer = LightText,
    background = LightBg,
    onBackground = LightText,
    surface = LightSurface,
    onSurface = LightText,
    surfaceVariant = LightSurface2,
    onSurfaceVariant = LightText2,
    surfaceTint = LightSurface,
    inverseSurface = LightText,
    inverseOnSurface = LightBg,
    error = LightAccentText,
    onError = LightAccentFg,
    errorContainer = LightAccentTint,
    onErrorContainer = LightAccentText,
    outline = LightText3,
    outlineVariant = LightBorder,
    scrim = Color(0xFF000000),
    surfaceBright = LightSurface,
    surfaceDim = Color(0xFFEEEEE9),
    surfaceContainerLowest = LightSurface,
    surfaceContainerLow = LightBg,
    surfaceContainer = LightSurface2,
    surfaceContainerHigh = Color(0xFFEEEEE9),
    surfaceContainerHighest = LightBorder,
)

private val DarkColors: ColorScheme = darkColorScheme(
    primary = DarkAccent,
    onPrimary = DarkAccentFg,
    primaryContainer = DarkAccentTint,
    onPrimaryContainer = DarkAccentText,
    inversePrimary = LightAccent,
    secondary = DarkText2,
    onSecondary = DarkBg,
    secondaryContainer = DarkSurface2,
    onSecondaryContainer = DarkText,
    tertiary = DarkText3,
    onTertiary = DarkBg,
    tertiaryContainer = DarkSurface2,
    onTertiaryContainer = DarkText,
    background = DarkBg,
    onBackground = DarkText,
    surface = DarkSurface,
    onSurface = DarkText,
    surfaceVariant = DarkSurface2,
    onSurfaceVariant = DarkText2,
    surfaceTint = DarkSurface,
    inverseSurface = DarkText,
    inverseOnSurface = DarkBg,
    error = DarkAccentText,
    onError = DarkAccentFg,
    errorContainer = DarkAccentTint,
    onErrorContainer = DarkAccentText,
    outline = DarkText3,
    outlineVariant = DarkBorder,
    scrim = Color(0xFF000000),
    surfaceBright = DarkBorder,
    surfaceDim = DarkBg,
    surfaceContainerLowest = DarkBg,
    surfaceContainerLow = Color(0xFF111110),
    surfaceContainer = DarkSurface2,
    surfaceContainerHigh = Color(0xFF242422),
    surfaceContainerHighest = DarkBorder,
)

/** Radii 6 / 10 / 14 from the brand tokens. */
private val PolishotShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(6.dp),
    medium = RoundedCornerShape(10.dp),
    large = RoundedCornerShape(14.dp),
    extraLarge = RoundedCornerShape(20.dp),
)

/** Instrument Serif for headings, Geist for everything else (both SIL OFL, bundled in res/font). */
private val Geist = FontFamily(
    Font(R.font.geist_regular, FontWeight.Normal),
    Font(R.font.geist_medium, FontWeight.Medium),
    Font(R.font.geist_semibold, FontWeight.SemiBold),
)
private val InstrumentSerif = FontFamily(Font(R.font.instrument_serif, FontWeight.Normal))

private fun brandTypography(): Typography {
    val base = Typography()
    fun TextStyle.ui(weight: FontWeight = FontWeight.Normal) = copy(fontFamily = Geist, fontWeight = weight)
    fun TextStyle.serif() = copy(fontFamily = InstrumentSerif, fontWeight = FontWeight.Normal, letterSpacing = 0.sp)
    return Typography(
        displayLarge = base.displayLarge.serif(),
        displayMedium = base.displayMedium.serif(),
        displaySmall = base.displaySmall.serif(),
        headlineLarge = base.headlineLarge.serif(),
        headlineMedium = base.headlineMedium.serif(),
        headlineSmall = base.headlineSmall.serif(),
        titleLarge = base.titleLarge.ui(FontWeight.SemiBold),
        titleMedium = base.titleMedium.ui(FontWeight.Medium),
        titleSmall = base.titleSmall.ui(FontWeight.Medium),
        bodyLarge = base.bodyLarge.ui(),
        bodyMedium = base.bodyMedium.ui(),
        bodySmall = base.bodySmall.ui(),
        labelLarge = base.labelLarge.ui(FontWeight.Medium),
        labelMedium = base.labelMedium.ui(FontWeight.Medium),
        labelSmall = base.labelSmall.ui(FontWeight.Medium),
    )
}

/**
 * @param darkTheme which palette to use; callers resolve the user's Light / Dark / System setting first.
 * @param brandFonts set false in tests that cannot load font resources.
 */
@Composable
fun PolishotTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    brandFonts: Boolean = true,
    content: @Composable () -> Unit,
) {
    val typography = remember(brandFonts) { if (brandFonts) brandTypography() else Typography() }
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = typography,
        shapes = PolishotShapes,
        content = content,
    )
}
