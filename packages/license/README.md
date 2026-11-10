# @polishot/license

Offline Ed25519 licence verification and the Pro entitlement rules (`docs/CONTRACTS.md` sections 3 and 5b).
Consumed as TypeScript source. The Rust twin is `crates/polishot-license`; the Kotlin port lives in
`apps/android`. All three run `test-vectors.json`.

```ts
import { buildDaysFromDate, entitlement, verifyLicense } from '@polishot/license';

const BUILD_DAYS = 20_468; // embedded at build time, see below
const stored = localStorage.getItem('license'); // however the host stores it
const e = entitlement(stored ? await verifyLicense(stored) : null, BUILD_DAYS);
// { pro: true, updatesUntil: '2027-01-15' }
// { pro: false, reason: 'updates-expired', updatesUntil: '2027-01-15' }
// { pro: false, reason: 'invalid' } | { pro: false, reason: 'no-key' }
new Editor(el, { licensed: e.pro });
```

## API

| export | meaning |
|---|---|
| `verifyLicense(key, publicKeyHex?)` | `{ valid: true, info } \| { valid: false, reason }`; never throws |
| `LicenseInfo` | `version, edition, issuedAt: Date, issuedDays: number, keyId, licenseeHash` (`issuedDays` is the exact u32; `issuedAt` is clamped for absurd values) |
| `UPDATE_WINDOW_DAYS` | `365` |
| `updatesUntilDays(info)` | `min(issuedDays + 365, 4294967295)` (saturates like Rust) |
| `updatesUntilDate(info)` | the same day as a `Date` (midnight UTC) |
| `coversBuild(info, buildDays)` | `buildDays <= updatesUntilDays(info)`; the last day is included; not an integer in `0..4294967295` is `false` |
| `entitlement(result, buildDays)` | `{ pro, reason?, updatesUntil? }`; `null`/`undefined` result is `no-key`, a failed or malformed result is `invalid`, outside the window is `updates-expired` (still reports the date) |
| `buildDaysFromDate(d)` | days since the Unix epoch (UTC) of a build date; throws on an invalid date |
| `daysToIso(days)` | `YYYY-MM-DD` for a day count (any u32) |

## Embedding `BUILD_DAYS`

The app embeds the day it was built and compares it with the key's window, so a version released after
the window keeps working but behaves as Free. Never fall back to `0` or to "now at run time": a build day
of 0 is covered by every key, and "now" lets the user keep updating forever by running an old build later.

**Vite** (`vite.config.ts`):

```ts
import { buildDaysFromDate } from '@polishot/license';

const epoch = process.env.SOURCE_DATE_EPOCH; // reproducible builds
const built = epoch ? new Date(Number(epoch) * 1000) : new Date();

export default defineConfig({
  define: { __BUILD_DAYS__: JSON.stringify(buildDaysFromDate(built)) },
});
```

**Next.js** (`next.config.ts`): `env: { NEXT_PUBLIC_BUILD_DAYS: String(buildDaysFromDate(built)) }`.

**Rust** (Tauri `build.rs`): see `crates/polishot-license/README.md`.

**Android** (`app/build.gradle.kts`):

```kotlin
val buildDays: Long = providers.gradleProperty("buildDays")
    .map { it.trim().toLong() }
    .orElse(System.currentTimeMillis() / 86_400_000L)
    .get()
android {
    defaultConfig { buildConfigField("long", "BUILD_DAYS", "${buildDays}L") }
    buildFeatures { buildConfig = true }
}
```

## Porting to Kotlin

Use `Long` for days. `updatesUntilDays = min(issuedDays + 365, 0xFFFF_FFFFL)`;
`coversBuild = buildDays in 0..0xFFFF_FFFFL && buildDays <= updatesUntilDays`. Treat a blank stored key as
`no-key` and any key that fails verification as `invalid`. `test-vectors.json` `entitlementCases` is
`{ name, key, buildDays, pro, reason?, updatesUntilDays? }` where `key` is `""` or whitespace when nothing
is activated.

## Tests

```bash
pnpm --filter @polishot/license test
pnpm --filter @polishot/license typecheck
node tools/license-keygen/index.mjs vectors   # regenerate test-vectors.json (deterministic)
```
