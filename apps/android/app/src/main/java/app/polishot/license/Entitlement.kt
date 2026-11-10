package app.polishot.license

import java.time.LocalDate

enum class EntitlementReason(val id: String) {
    /** No key has been activated. */
    NoKey("no-key"),

    /** A key is stored but it does not verify. */
    Invalid("invalid"),

    /** The key is genuine, but this app version was built after the key's update window closed. */
    UpdatesExpired("updates-expired"),
}

/**
 * What the app is entitled to (CONTRACTS section 5b): `{ pro, reason?, updatesUntil? }`. [pro] is what the editor
 * receives as `licensed`: no watermark, custom brand mark, unlimited saved looks and batch size.
 */
data class Entitlement(
    val pro: Boolean,
    val reason: EntitlementReason? = null,
    /** ISO date (yyyy-MM-dd) of the last day of updates the key covers; null when there is no valid key. */
    val updatesUntil: String? = null,
    /** The verified key details, when the key is genuine (also for [EntitlementReason.UpdatesExpired]). */
    val info: LicenseInfo? = null,
) {
    companion object {
        val Free = Entitlement(pro = false, reason = EntitlementReason.NoKey)
    }
}

/**
 * Pro is $11 once and includes one year of updates: a key covers every app build dated no later than
 * `issuedDays + 365`. Builds made later keep working but behave as Free; the last covered build stays Pro forever.
 *
 * Arithmetic follows the Rust crate (`u32` with saturating add): days are unsigned 32-bit values held in a Long,
 * and the sum saturates at 4294967295 instead of wrapping.
 */
object Entitlements {
    const val UPDATE_WINDOW_DAYS: Long = 365L
    private const val U32_MAX: Long = 0xFFFF_FFFFL

    /** Last build day (days since the Unix epoch) the key covers: `issuedDays + 365`, saturating at u32 max. */
    fun updatesUntilDays(info: LicenseInfo): Long =
        minOf(info.issuedDays + UPDATE_WINDOW_DAYS, U32_MAX)

    /** True when a build made on [buildDays] (days since epoch) is covered by the key's update window. */
    fun coversBuild(info: LicenseInfo, buildDays: Long): Boolean =
        buildDays in 0L..U32_MAX && buildDays <= updatesUntilDays(info)

    /**
     * `YYYY-MM-DD` for [updatesUntilDays], any unsigned 32-bit day count (the TypeScript `daysToIso`). A year past
     * 9999 comes out without the leading `+` that `LocalDate` would add.
     */
    fun updatesUntilIso(info: LicenseInfo): String = isoDate(updatesUntilDays(info))

    fun isoDate(days: Long): String = LocalDate.ofEpochDay(days).toString().removePrefix("+")

    /** Entitlement for the stored key text ([key] is null or blank when nothing is activated). */
    fun evaluate(key: String?, verifier: LicenseVerifier, buildDays: Long): Entitlement {
        if (key.isNullOrBlank()) return Entitlement.Free
        return when (val result = verifier.verify(key)) {
            is VerifyResult.Invalid -> Entitlement(pro = false, reason = EntitlementReason.Invalid)
            is VerifyResult.Valid -> forVerified(result.info, buildDays)
        }
    }

    /** Entitlement for a key that already verified. */
    fun forVerified(info: LicenseInfo, buildDays: Long): Entitlement =
        if (coversBuild(info, buildDays)) {
            Entitlement(pro = true, updatesUntil = updatesUntilIso(info), info = info)
        } else {
            Entitlement(
                pro = false,
                reason = EntitlementReason.UpdatesExpired,
                updatesUntil = updatesUntilIso(info),
                info = info,
            )
        }
}
