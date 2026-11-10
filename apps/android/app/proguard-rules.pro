# R8 rules for the release build (minify + shrink resources are enabled in app/build.gradle.kts).

# ---- WebView JavaScript bridge ------------------------------------------------------------------
# The editor page calls window.PolishotAndroid.<method>() by name. R8 must neither rename nor remove
# the @JavascriptInterface methods, or the editor silently loses saving, sharing and OCR.
-keepattributes JavascriptInterface
-keepattributes *Annotation*
-keepclassmembers class app.polishot.editor.EditorBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# ---- BouncyCastle ---------------------------------------------------------------------------------
# Only the lightweight Ed25519 API is used (no JCA provider registration), so the rest is shrunk away.
# The jar has optional references to classes that do not exist on Android.
-dontwarn org.bouncycastle.**
-dontwarn javax.naming.**

# ---- Misc -----------------------------------------------------------------------------------------
# Crash stack traces stay readable when uploaded to a symbolicator.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
