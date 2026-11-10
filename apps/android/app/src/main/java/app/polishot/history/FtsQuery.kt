package app.polishot.history

/**
 * Builds a safe SQLite FTS4 MATCH expression from whatever the user typed in the search box.
 *
 * The raw text is never handed to MATCH: operators (`OR`, `NEAR`, `-`, `"`, `*`, `:` column filters) would
 * otherwise let a typo raise a syntax error, or let the user address columns they should not. Instead the input
 * is split into letter/digit tokens, lower-cased (FTS operators are upper-case only), and each token becomes a
 * prefix query. Tokens are joined by a space, which FTS treats as AND.
 */
object FtsQuery {
    const val MAX_TOKENS = 8
    const val MAX_TOKEN_LENGTH = 48

    /** Returns the MATCH expression, or null when the input holds nothing searchable. */
    fun build(userInput: String): String? {
        val tokens = ArrayList<String>()
        val current = StringBuilder()

        fun flush() {
            if (current.isNotEmpty() && tokens.size < MAX_TOKENS) {
                tokens.add(current.toString().take(MAX_TOKEN_LENGTH))
            }
            current.setLength(0)
        }

        for (ch in userInput) {
            if (Character.isLetterOrDigit(ch)) current.append(ch.lowercaseChar()) else flush()
        }
        flush()

        if (tokens.isEmpty()) return null
        return tokens.joinToString(" ") { "$it*" }
    }
}
