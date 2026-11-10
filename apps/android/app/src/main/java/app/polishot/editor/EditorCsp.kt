package app.polishot.editor

/**
 * Content Security Policy of the editor page: no remote origins at all, no inline or eval'd script.
 * It lives in its own file (no Android imports) so a plain JVM unit test can compare it with the
 * `<meta http-equiv="Content-Security-Policy">` in apps/android/editor-host/index.html.
 */
internal object EditorCsp {
    const val POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self'; connect-src 'self' data: blob:; worker-src 'none'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
}
