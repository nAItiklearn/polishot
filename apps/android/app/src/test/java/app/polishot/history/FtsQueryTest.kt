package app.polishot.history

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FtsQueryTest {
    @Test
    fun `words become prefix tokens joined by AND`() {
        assertEquals("invoice*", FtsQuery.build("invoice"))
        assertEquals("visa* 4242*", FtsQuery.build("Visa 4242"))
    }

    @Test
    fun `case is folded so FTS operators in the input are inert`() {
        assertEquals("or* near* not*", FtsQuery.build("OR NEAR NOT"))
        assertEquals("and*", FtsQuery.build("AND"))
    }

    @Test
    fun `punctuation and FTS syntax characters never reach MATCH`() {
        for (hostile in listOf("\"unterminated", "a*b", "col:value", "-minus", "(paren", "a OR b", "x\\y", "'; DROP TABLE history;--")) {
            val query = FtsQuery.build(hostile)
            assertTrue("expected a query for $hostile", query != null)
            assertFalse("quote leaked from $hostile", query!!.contains('"'))
            assertFalse("colon leaked from $hostile", query.contains(':'))
            assertFalse("paren leaked from $hostile", query.contains('(') || query.contains(')'))
            assertFalse("minus leaked from $hostile", query.contains('-'))
            // The only operator character allowed is the trailing prefix star on each token.
            assertTrue(query.split(' ').all { it.endsWith("*") && it.count { c -> c == '*' } == 1 })
        }
    }

    @Test
    fun `nothing searchable gives null`() {
        assertNull(FtsQuery.build(""))
        assertNull(FtsQuery.build("   "))
        assertNull(FtsQuery.build("\"*-:()"))
    }

    @Test
    fun `token count and length are bounded`() {
        val many = (1..20).joinToString(" ") { "w$it" }
        assertEquals(FtsQuery.MAX_TOKENS, FtsQuery.build(many)!!.split(' ').size)
        val long = "a".repeat(500)
        assertEquals(FtsQuery.MAX_TOKEN_LENGTH + 1, FtsQuery.build(long)!!.length)
    }

    @Test
    fun `non ASCII letters are kept`() {
        assertEquals("über*", FtsQuery.build("ÜBER"))
        assertEquals("東京*", FtsQuery.build("東京"))
    }

    @Test
    fun `digits inside tokens and email style text split on punctuation`() {
        assertEquals("jane* example* com*", FtsQuery.build("jane@example.com"))
        assertEquals("192* 168* 0* 1*", FtsQuery.build("192.168.0.1"))
    }
}
