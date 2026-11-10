package app.polishot.share

/**
 * Free runs up to [FREE_BATCH_LIMIT] images per batch beautify; Pro has no such limit (docs/CONTRACTS.md section 5b).
 * Only a technical ceiling remains for Pro so one intent cannot queue thousands of decodes.
 */
object BatchPolicy {
    const val FREE_BATCH_LIMIT = 5
    const val PRO_CEILING = 100

    class Plan(val accepted: Int, val dropped: Int) {
        val limited: Boolean get() = dropped > 0
    }

    /** How many of [requested] images this run processes. */
    fun plan(requested: Int, pro: Boolean): Plan {
        val limit = if (pro) PRO_CEILING else FREE_BATCH_LIMIT
        val accepted = requested.coerceIn(0, limit)
        return Plan(accepted, (requested - accepted).coerceAtLeast(0))
    }
}
