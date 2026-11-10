package app.polishot.editor

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The page ships a CSP in its own <meta> tag and the native asset handler sends the same policy as a response
 * header. They must stay identical, and neither may allow a remote origin: the editor never talks to the network.
 */
class CspConsistencyTest {
    private val indexHtml: String = run {
        val candidates = listOf(File("../editor-host/index.html"), File("apps/android/editor-host/index.html"))
        val file = candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("editor-host/index.html not found from ${File(".").absoluteFile}")
        file.readText()
    }

    private fun metaCsp(): String {
        val tag = Regex("""<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>""", RegexOption.DOT_MATCHES_ALL)
            .find(indexHtml)?.value ?: throw AssertionError("no CSP meta tag in index.html")
        return Regex("""content="([^"]*)"""").find(tag)?.groupValues?.get(1)
            ?: throw AssertionError("CSP meta tag has no content attribute")
    }

    @Test
    fun `the meta tag and the response header carry the same policy`() {
        assertEquals(EditorCsp.POLICY, metaCsp())
    }

    @Test
    fun `the policy names no remote origin`() {
        val csp = EditorCsp.POLICY
        assertFalse(csp.contains("http:"))
        assertFalse(csp.contains("https:"))
        assertFalse(csp.contains("*"))
        assertFalse(csp.contains("unsafe-eval"))
        assertTrue(csp.startsWith("default-src 'none'"))
    }

    @Test
    fun `scripts only come from the app itself and are never inline`() {
        val script = EditorCsp.POLICY.split(";").map { it.trim() }.single { it.startsWith("script-src") }
        assertEquals("script-src 'self'", script)
    }
}
