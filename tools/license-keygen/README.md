# @polishot/license-keygen

Offline tool that creates the production signing key, mints licence keys and regenerates the shared
test vectors. Needs Node 22.18+ (it loads `@polishot/license` TypeScript source directly).

```bash
node tools/license-keygen/index.mjs init [--force]
node tools/license-keygen/index.mjs issue --email jane@example.com --edition personal|team [--date YYYY-MM-DD]
node tools/license-keygen/index.mjs verify [--test] <key>
node tools/license-keygen/index.mjs vectors
```

(`pnpm --filter @polishot/license-keygen keygen <command> ...` works too.)

| command   | what it does                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`    | Generates the production Ed25519 keypair. Private key goes to `keys/prod.private.key` (mode 0600, user-only ACL on Windows). Writes the public key to `packages/license/public-key.hex` and `packages/license/src/publicKey.ts`. Refuses to run if a key already exists unless `--force`; with `--force` the old private key is kept next to it as a `.bak`. |
| `issue`   | Signs a key for an email and edition and prints it to stdout (details go to stderr). `--date` defaults to today (UTC). Checks that the private key matches `public-key.hex` and verifies the result before printing.                                                                                                                                         |
| `verify`  | Decodes a key and prints its fields as JSON. Exit code 1 and `{"valid":false,"reason":...}` when it is not valid. `--test` checks against the test key instead of the production key.                                                                                                                                                                        |
| `vectors` | Rewrites `packages/license/test-vectors.json` with the TEST keypair in `packages/license/test-keypair.json` (created once, committed). Output is deterministic. Run it whenever the key format or parsing rules change, then run the TS and Rust tests.                                                                                                      |

## Security

- `keys/` is gitignored, as is `*.private.key`. Back the file up somewhere safe: if it is lost, every
  issued licence has to be re-issued with a new key shipped in a new app release.
- The private key is never printed (`init` prints only the public key) and is never imported by app
  code. Only this tool reads it.
- Re-running `init --force` invalidates every key issued so far.
- `test-keypair.json` is a throw-away key that exists only to produce vectors. Never issue real
  licences with it.

## Key format (for the Rust and Kotlin implementers)

`PSHOT-` + Crockford base32 of `payload || signature` in groups of 6 joined by `-`.
Payload is 30 bytes: `version (1)`, `edition (1=personal, 2=team)`, `issuedDays u32 big-endian`,
`keyId (8)`, `licenseeHash (16, first half of SHA-256 of lower-cased trimmed email)`. The signature
is Ed25519 over the 30 payload bytes, verified strictly (dalek `verify_strict`; noble
`zip215: false`, which also rejects S >= L). Check order, first failure wins:

1. Input longer than 300 characters: `length`.
2. Trim ASCII whitespace (space, `\t`, `\n`, `\v`, `\f`, `\r`); drop a leading `PSHOT-` (any case,
   dash required); ignore ASCII whitespace and `-` anywhere else.
3. Any character outside Crockford base32 (case-insensitive, `O` is `0`, `I`/`L` are `1`, `U` is
   illegal, non-ASCII is illegal): `format`.
4. Decoded size is not exactly 94 bytes (151 characters): `length`. Spare padding bits are ignored.
5. Signature does not verify: `signature`.
6. Signature verifies but version is not 1 or edition is not 1 or 2: `version`.

`issuedDays` is unsigned 32-bit (a vector uses `4294967295`); do not read it as a signed Int.
Vectors cover each rule; `valid` cases carry `edition`, `issuedDays`, `keyIdHex` (16 hex) and
`licenseeHash` (32 hex). The test emails behind them are `alice@example.com` (personal) and
`team@example.com` (team).

## Entitlement vectors (update window)

`vectors` also writes `entitlementCases` next to `cases` in `packages/license/test-vectors.json`:
`{ name, key, buildDays, pro, reason?, updatesUntilDays? }`. `key` is `""` (or whitespace) when nothing is
activated. `updatesUntilDays` is `min(issuedDays + 365, 4294967295)`; `reason` is `no-key`, `invalid` or
`updates-expired` and is present exactly when `pro` is false. The cases cover a build inside the window,
the last covered day (inclusive), one day after, a build older than the key, the u32 saturation key, invalid
keys and no key. Expected values are computed in the tool with plain arithmetic and then checked against
`entitlement()`. The existing `cases` stay byte-for-byte identical (Ed25519 is deterministic).
