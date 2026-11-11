# Polishot Quick Send protocol, version 1

Windows and Android exchange images over the local network with no account, no server and no cloud.
Devices find each other with mDNS, pair once by comparing a six-digit code on both screens, and from
then on every transfer is mutually authenticated, forward secret and end-to-end encrypted.

This document is normative. Two implementations follow it and must agree byte for byte:

| Implementation | Location |
|---|---|
| Rust (Windows desktop) | `crates/polishot-quicksend` |
| Kotlin/JVM (Android) | `apps/android/quicksend` |
| Shared test vectors, asserted by both | `packages/quicksend-vectors/vectors.json` |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Threat model

Attacker: anyone on the same LAN. They can sniff, drop, modify, replay and inject packets, connect to the
listening port, and run a man-in-the-middle (MITM) during first contact.

| Property | How |
|---|---|
| Confidentiality and integrity of image data | AES-256-GCM under per-session keys |
| Forward secrecy | fresh ephemeral ECDH for every session |
| MITM resistance at first contact | short authentication string (SAS) compared by the user, with commit-reveal so it cannot be ground |
| Only paired devices can send | every transfer is authenticated by the 256-bit pair key |
| Receiver stays in control | explicit accept callback; size, type, magic-byte and hash checks |
| Replay, reorder, truncation, tamper | implicit AEAD counters, authenticated frame type, end-of-file hash |
| Resource exhaustion | frame, file and name limits, per-read timeouts, pairing rate limit, pairing off unless the user opened it |

Out of scope: a compromised endpoint, traffic analysis (sizes and timing are visible), denial of service by a
LAN attacker who simply floods the port, and anonymity (the device id and name are broadcast by mDNS).

## 2. Conventions

- All integers are big-endian. `u8`, `u16`, `u32`, `u64` are unsigned.
- `a ‖ b` is byte concatenation. `str8(s)` is one length byte followed by that many bytes of UTF-8.
- Curve: NIST P-256 (secp256r1, prime256v1). Hash: SHA-256. KDF: HKDF-SHA256 (RFC 5869). MAC:
  HMAC-SHA256. AEAD: AES-256-GCM, 96-bit nonce, 128-bit tag.
- **Public keys** are SEC1 *uncompressed*: 65 bytes, `0x04 ‖ X(32) ‖ Y(32)`. A receiver MUST reject any point
  that is not on the curve or is the point at infinity. Compressed encodings are not accepted.
- **Private keys** are the 32-byte big-endian scalar `d`, with `0 < d < n`.
- **ECDH output** is the 32-byte big-endian X coordinate of `d·Q` (what JCA `KeyAgreement("ECDH")` and RustCrypto
  `diffie_hellman` both return).
- **HKDF** with an empty salt means a salt of 32 zero bytes (RFC 5869 section 2.2). The HKDF `info` strings
  below are ASCII with no terminator.
- All domain-separation labels are ASCII, no terminator, and are never reused across purposes.

### 2.1 Labels

| Constant | Value |
|---|---|
| `L_COMMIT` | `polishot-qs-commit-v1` |
| `L_PAIR_T` | `polishot-qs-pair-transcript-v1` |
| `L_XFER_T` | `polishot-qs-transfer-transcript-v1` |
| `I_SAS` | `polishot-sas` |
| `I_PAIR` | `polishot-pair-v1` |
| `I_SESSION` | `polishot-session-v1` |
| `L_CONFIRM_I`, `L_CONFIRM_R` | `polishot-pair-confirm-i`, `polishot-pair-confirm-r` |
| `L_AUTH_S`, `L_AUTH_R` | `polishot-auth-s`, `polishot-auth-r` |

### 2.2 Strings

Device names and file names are UTF-8 and MUST be decoded strictly (malformed input is a protocol error).
Both kinds MUST NOT contain any of these code points: U+0000 to U+001F, U+007F to U+009F, U+2028, U+2029,
U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069, or a lone surrogate.

- Device name: 1 to 32 Unicode scalar values.
- File name on the wire: 1 to 128 bytes of UTF-8.

`clean_device_name(raw)` removes forbidden code points, trims U+0020 from both ends, truncates to 32 scalar
values and falls back to `Device` if nothing is left. Apps SHOULD pass user-visible names through it.

`sanitize_file_name(raw)` (used by the sender when building the offer and again by the receiver before the
name is shown or used):

1. Replace each forbidden code point and each of `/ \ : * ? " < > |` with `_`.
2. Trim leading and trailing U+0020 and `.`.
3. If empty, use `image`.
4. If the part before the first `.` equals (ASCII case-insensitively) `CON PRN AUX NUL COM1`..`COM9`
   `LPT1`..`LPT9`, prepend `_`.
5. Truncate to at most 128 UTF-8 bytes without splitting a code point, then trim spaces and dots again; if empty,
   use `image`.

The function is idempotent. Apps MUST still choose their own safe file path when saving (for example
`<picked folder>/<timestamp>-<sanitized name>`) and MUST NOT trust any name for path construction.

## 3. Identity and device id

Each installation owns a long-term P-256 key pair `(IK_priv, IK_pub)`, generated once and stored by the app
(Windows: a file under `%APPDATA%\Polishot\quicksend\` protected with DPAPI `CryptProtectData`, bound to the
Windows user; Android: Keystore-wrapped storage). Rotating it makes the device a new device. A Windows identity file
that cannot be unlocked is set aside, never deleted, and a new identity is created (the user is told to pair again).

```
device_id = first 10 bytes of SHA-256(IK_pub)           (IK_pub is the 65-byte SEC1 encoding)
id_string = RFC 4648 base32, upper case, no padding     (16 characters, e.g. "MFRGGZDFMZTWQ2LK")
```

Parsers MUST accept lower case and normalise to upper case. Ordering of device ids (needed for the canonical
transcript) is unsigned lexicographic comparison of the raw 10 bytes, never of the strings.

A device id is a label, not a secret. Authority comes from keys: during pairing the SAS covers the full public
keys, and during transfer the pair key authenticates the peer.

## 4. Discovery (mDNS / DNS-SD)

| Item | Value |
|---|---|
| Service type | `_polishot._tcp.local.` (Android `NsdManager` type `_polishot._tcp.`) |
| Instance name | the device `id_string` |
| Port | chosen by the OS; the listener binds `0.0.0.0:0` and publishes the actual port |
| TXT `v` | `1` (highest protocol version supported; a hint only, negotiation happens in HELLO) |
| TXT `id` | the device `id_string` |
| TXT `name` | the device name, at most 32 characters |

Rules for browsers: ignore any record whose `v` is missing or not an integer, whose `id` does not parse, or
whose `name` fails the name rules. Ignore your own id. Treat discovered data as untrusted hints: nothing
learned from mDNS authenticates anyone. A browser MUST NOT show or select a peer for transfer unless it is
paired, and the pair record (not the advertised name) decides what is displayed.

Advertise only while the app wants to be reachable (the receive screen is open, or pairing mode is on).
The Windows Firewall prompt on first listen is expected.

## 5. Wire framing

Every message is one frame on a TCP stream:

```
+----------------+---------+------------------------------+
| len : u32      | type:u8 | body : len - 1 bytes         |
+----------------+---------+------------------------------+
```

- `len` counts the type byte and the body. `len` MUST be at least 1.
- `len` MUST NOT exceed `MAX_FRAME` = 1 048 576 (1 MiB). Before authentication it MUST NOT exceed
  `MAX_PLAIN_FRAME` = 1024. A reader checks `len` before allocating or reading the body and fails with a
  frame-too-large error (reported to the peer as `PROTOCOL`; the connection is then closed).
- **Plain frames** carry the body as is. They are used only before the transfer session is authenticated
  (HELLO, the pairing messages, AUTH, and ERROR sent before AUTH completes).
- **Sealed frames** are used for every message after both AUTH frames of a transfer session. The body is
  `ciphertext ‖ tag(16)`. The type byte stays visible but is authenticated.

### 5.1 Sealing

```
key       = k_s2r for sender-to-receiver frames, k_r2s for receiver-to-sender frames
nonce     = dir_tag(4) ‖ counter(u64)          (12 bytes)
dir_tag   = 00 00 00 01  sender -> receiver
            00 00 00 02  receiver -> sender
counter   = 0 for the first sealed frame in that direction, +1 for each following sealed frame
aad       = ver(1) ‖ type(1)                    ver = the negotiated protocol version byte
body      = AES-256-GCM-Seal(key, nonce, aad, plaintext)       (ciphertext ‖ 16-byte tag)
```

The nonce is *not* transmitted. The receiver derives it from its own per-direction counter, so a replayed,
dropped, duplicated or reordered frame fails authentication, and nonces are never reused (a counter that would
wrap past 2^64 - 1 is a protocol error). The two directions use different keys *and* different direction tags.
A sealed frame whose `len` is less than 17 is rejected. The plaintext is therefore at most
`MAX_FRAME - 17` bytes.

## 6. Messages

| Code | Name | Direction | Plain/sealed | Body |
|---|---|---|---|---|
| `0x01` | HELLO | both | plain | `ver_min u8 ‖ ver_max u8 ‖ intent u8 ‖ device_id(10) ‖ eph_len u8 ‖ eph(eph_len)` |
| `0x02` | PAIR_REQUEST | I to R | plain | `ik_pub(65) ‖ commit(32) ‖ str8(name)` |
| `0x03` | PAIR_RESPONSE | R to I | plain | `ik_pub(65) ‖ eph_pub(65) ‖ str8(name)` |
| `0x04` | PAIR_REVEAL | I to R | plain | `eph_pub(65)` |
| `0x05` | PAIR_CONFIRM | both | plain | `decision u8 ‖ mac(32)` |
| `0x10` | AUTH | both | plain | `mac(32)` |
| `0x11` | OFFER | S to R | sealed | `size u64 ‖ sha256(32) ‖ str8(mime) ‖ str8(name)` |
| `0x12` | ACCEPT | R to S | sealed | empty |
| `0x13` | DECLINE | R to S | sealed | empty |
| `0x14` | CHUNK | S to R | sealed | raw file bytes |
| `0x15` | DONE | both | sealed | S to R: `total u64`; R to S: empty (acknowledgement) |
| `0x7F` | ERROR | both | plain before AUTH completes, sealed after | `code u16` |

`intent` is `1` (pair) or `2` (transfer). For intent 1, `eph_len` MUST be 0. For intent 2, `eph_len` MUST be 65
and `eph` is the sender's ephemeral public key. `I`/`R` are the pairing initiator (the side that opened the TCP
connection) and responder; `S`/`R` are the transfer sender (the side that opened the connection) and receiver.
`str8` fields hold at most 32 characters (device name), 255 bytes (mime; allowlist applies) or 128 bytes
(file name). Trailing bytes after the last field of any message are a protocol error. A frame of unknown or
unexpected type is a protocol error.

## 7. Version negotiation

The initiator's HELLO states the inclusive range of versions it speaks. The responder picks
`chosen = min(initiator.ver_max, responder.ver_max)` and requires `chosen >= max(initiator.ver_min,
responder.ver_min)`. If not, it replies with plain `ERROR(UNSUPPORTED_VERSION)` and closes. Otherwise it replies
with its own HELLO whose `ver_min` and `ver_max` both equal `chosen`. The initiator verifies `ver_min ==
ver_max` and that the value lies in its own range. This document defines version 1 only (`ver_min = ver_max = 1`).
The chosen version is part of every transcript, so a downgrade attempt changes the keys and fails.

## 8. Pairing (first contact)

Pairing is only available while the user has explicitly opened pairing mode on the responder (`allow_pairing`),
and at most 5 pairing attempts per 60 seconds are served (sliding window, counted when the HELLO arrives,
whether or not the pairing then succeeds). Otherwise the responder answers with plain
`ERROR(PAIRING_DISABLED)` or `ERROR(RATE_LIMITED)`.

### 8.1 Message flow

```
Initiator (I)                                   Responder (R)
  e_I = fresh ephemeral key pair                  e_R = fresh ephemeral key pair

  HELLO(intent=1, id_I)                 --->
                                        <---      HELLO(chosen version, intent=1, id_R)
  PAIR_REQUEST(IK_I, commit, name_I)    --->
                                        <---      PAIR_RESPONSE(IK_R, E_R, name_R)
  PAIR_REVEAL(E_I)                      --->
        both compute T, SAS, pair_key
        both show the SAS; the user of each device compares
  PAIR_CONFIRM(decision, mac_I)         --->
                                        <---      PAIR_CONFIRM(decision, mac_R)
        each side persists the record only if the local user said yes AND
        the peer's decision is 1 AND the peer's mac verifies (constant time)
```

The two PAIR_CONFIRM frames are sent without waiting for each other, then each side reads the peer's.

`commit = SHA-256(L_COMMIT ‖ ver ‖ IK_I ‖ E_I)`. It binds the initiator to its ephemeral key before the responder
reveals its own. The responder checks that `device_id` in HELLO equals the id derived from the key in
PAIR_REQUEST, and the initiator makes the same check for PAIR_RESPONSE; mismatches are protocol errors. After
PAIR_REVEAL the responder recomputes the commitment and rejects a mismatch (`BadCommitment`, wire code
`PROTOCOL`). Both sides reject a peer whose device id equals their own (`SelfPairing`).

**Why commit-reveal.** A bare six-digit SAS has only 20 bits. If a MITM could see both ephemeral keys before
choosing the keys it shows to each side, it could try about a million key pairs offline until the two SAS
values collide, then pass the user's comparison. With the commitment, the initiator's ephemeral key is hidden
until the responder's is fixed, and the MITM's own keys on both legs are fixed before the honest keys are
known. The attacker then wins with probability 10^-6 per attempt, and attempts are rate-limited.

### 8.2 Transcript, SAS, pair key

Let the two parties be `P_x = IK_x ‖ E_x ‖ str8(name_x)` for each device `x`, using exactly the name bytes that
were sent on the wire. Order the parties by device id (section 3), lower first:

```
T = SHA-256( L_PAIR_T ‖ ver ‖ P_lo ‖ P_hi )              ver = chosen version byte

sas_value = u64_be( HKDF-SHA256(salt = empty, IKM = T, info = I_SAS, L = 8) ) mod 1 000 000
SAS       = sas_value as 6 decimal digits, zero padded      (display grouping such as "123 456" is up to the UI)

z_ee      = ECDH(e_self, E_peer)
z_ss      = ECDH(IK_self, IK_peer)                      (proves possession of the long-term private key)
pair_key  = HKDF-SHA256(salt = T, IKM = z_ee ‖ z_ss, info = I_PAIR, L = 32)
```

Names are inside the transcript, so a MITM cannot alter the displayed device name without changing the SAS.
The SAS is derived from public values only and reveals nothing about `pair_key`.

### 8.3 Confirmation and persistence

Each side shows the SAS and the peer name and asks "Do both devices show the same code?".

```
decision = 1 if the user confirmed, otherwise 0
mac_I    = HMAC-SHA256(pair_key, L_CONFIRM_I ‖ T)      sent by I
mac_R    = HMAC-SHA256(pair_key, L_CONFIRM_R ‖ T)      sent by R
```

If the decision is 0 the `mac` field is 32 zero bytes. A side that rejects locally sends its decision-0 frame
and does not wait. A side that confirms waits for the peer's frame (up to 120 s, a human is deciding). The
peer's mac is verified in constant time against the *other* role's label, which blocks reflection.

On success each side persists a **pair record**:

```
peer_id, peer_ik_pub (65 bytes), pair_key (32 bytes), peer_name
```

Recommended encoding (used by both libraries, `to_bytes`/`from_bytes`):

```
format u8 = 1 ‖ peer_ik_pub(65) ‖ pair_key(32) ‖ str8(peer_name)         (peer_id is derived)
```

The pair key is a secret: store it protected by the OS (Windows: one DPAPI-protected file per pair record next to
the identity; Android: a keystore-wrapped file). Pairing is complete
for a side only when it holds the record; if the connection dies after one side persisted and before the other
did, the user simply pairs again (the stale record is harmless: transfers from it are refused by the side that
lacks it). "Unpair" is deleting the record locally; a device that was unpaired by its peer learns this the next
time it is refused with `UNPAIRED`.

## 9. Transfer (paired devices)

### 9.1 Handshake

```
Sender (S)                                      Receiver (R)
  pair = record for R                             pairs = all records
  e_S = fresh ephemeral                           e_R = fresh ephemeral

  HELLO(intent=2, id_S, E_S)            --->      look up id_S in pairs, else plain ERROR(UNPAIRED)
                                        <---      HELLO(chosen, intent=2, id_R, E_R)
  S checks id_R == pair.peer_id
  both: z = ECDH(e_self, E_peer), T, keys as below
  AUTH(auth_s)                          --->      verify auth_s in constant time, else plain ERROR(AUTH_FAILED)
                                        <---      AUTH(auth_r)
  S verifies auth_r in constant time
  -- from here on every frame is sealed --
```

```
T       = SHA-256( L_XFER_T ‖ ver ‖ id_S(10) ‖ id_R(10) ‖ E_S(65) ‖ E_R(65) )
z       = ECDH(e_self, E_peer)
PRK     = HKDF-Extract(salt = pair_key, IKM = z)
OKM     = HKDF-Expand(PRK, info = I_SESSION ‖ T, L = 64)
k_s2r   = OKM[0..32]          k_r2s = OKM[32..64]
auth_s  = HMAC-SHA256(pair_key, L_AUTH_S ‖ T)
auth_r  = HMAC-SHA256(pair_key, L_AUTH_R ‖ T)
```

Because `z` comes from fresh ephemeral keys, past sessions stay secret even if the pair key leaks later.
Because the pair key is mixed into the session keys and into the AUTH MACs, an attacker without it can neither
authenticate nor decrypt. A wrong pair key shows up as `AUTH_FAILED` on both ends.

### 9.2 File exchange

1. S sends sealed `OFFER{size, sha256, mime, name}`.
2. R validates: `1 <= size <= 50 MiB (52 428 800)`, `mime` is exactly one of `image/png`, `image/jpeg`,
   `image/webp`, `name` is valid (section 2.2). Failures: sealed `ERROR(TOO_LARGE)` or
   `ERROR(UNSUPPORTED_TYPE)` or `ERROR(PROTOCOL)`, then close.
3. R calls the app's **accept callback** with `{peer, name, mime, size}`. Nothing is buffered before the
   user answers. R replies sealed `ACCEPT` or `DECLINE`. S waits up to 60 s for the answer.
4. After ACCEPT, S sends `CHUNK` frames: every chunk is exactly `CHUNK_SIZE` = 65 536 bytes except the last,
   which carries the remainder (`size mod 65536`, or a full chunk when the size is a multiple). R rejects any
   chunk whose length is not exactly `min(CHUNK_SIZE, remaining)` and any chunk beyond `size` (`PROTOCOL`).
5. S sends `DONE{total}`; R checks `total == size == bytes received`.
6. R verifies `SHA-256(data) == offer.sha256` (constant time) and the **magic bytes** of the data against the
   offered MIME:

   | MIME | Required bytes |
   |---|---|
   | `image/png` | `89 50 4E 47 0D 0A 1A 0A` at offset 0 |
   | `image/jpeg` | `FF D8 FF` at offset 0 |
   | `image/webp` | `52 49 46 46` ("RIFF") at 0 and `57 45 42 50` ("WEBP") at 8 |

   On failure R sends sealed `ERROR(BAD_CONTENT)` and discards the data. On success it sends sealed `DONE`
   (empty) and returns the file. S returns success only after it reads that DONE.
7. S also checks MIME allowlist, size and magic bytes before connecting, so it fails early with a clear error.

R never writes files itself in the library; it returns the bytes and the sanitized name to the app.

## 10. Limits and timeouts

| Item | Value |
|---|---|
| Protocol version | 1 |
| Max file size | 50 MiB = 52 428 800 bytes |
| Max frame (`len`) | 1 MiB = 1 048 576 |
| Max pre-authentication frame | 1024 |
| Chunk size | 65 536 |
| Device name | 32 characters |
| File name | 128 bytes |
| Handshake read (each frame, and waiting for OFFER) | 10 s |
| Wait for accept/decline | 60 s |
| Read per chunk frame | 15 s |
| Wait for final DONE | 15 s |
| Wait for the peer's pairing decision | 120 s |
| Whole transfer after AUTH | 600 s |
| Pairing attempts served | 5 per 60 s |
| Write per call | 30 s in Rust (`set_write_timeout`). JVM sockets have no write timeout: the Android app should close the socket from a watchdog if a send stalls. |

Every blocking read uses a deadline: before each `read` call the implementation sets the socket read timeout to
the time left, so a peer that trickles bytes cannot extend a frame past its timeout. Timeouts are fatal for the
session; the caller opens a new connection to retry. These values are the defaults of `Config`/`Timeouts`;
implementations may expose them for tests but MUST NOT ship larger limits for sizes.

## 11. Error codes

Carried in `ERROR` frames as `u16`. Implementations send an ERROR frame best-effort before closing on a fatal
local failure, and map a received ERROR to a typed error without trusting its contents beyond the code.

| Code | Name | Typical cause |
|---|---|---|
| 1 | `UNSUPPORTED_VERSION` | no common protocol version |
| 2 | `UNPAIRED` | the receiver has no record for the sender id |
| 3 | `PAIRING_DISABLED` | the user has not opened pairing mode |
| 4 | `RATE_LIMITED` | too many pairing attempts |
| 5 | `PROTOCOL` | malformed, unexpected or out-of-order message |
| 6 | `AUTH_FAILED` | AUTH MAC mismatch (wrong pair key) |
| 7 | `TOO_LARGE` | offer exceeds 50 MiB |
| 8 | `UNSUPPORTED_TYPE` | MIME not on the allowlist |
| 9 | `BAD_CONTENT` | magic bytes, hash or length mismatch |
| 10 | `BUSY` | the receiver is already handling a transfer |
| 11 | `TIMEOUT` | the peer stopped answering |
| 12 | `INTERNAL` | local failure; also used for unknown codes |
| 13 | `PAIRING_REJECTED` | a user rejected the SAS |

Local conditions with no code of their own: decline by the receiving user (the peer sees the DECLINE message),
I/O errors and a closed connection (nothing is sent), frame too large, an authentication-tag failure on a sealed
frame, a bad commitment and pairing with yourself (all sent as `PROTOCOL`).

## 12. Integration notes for the apps

- The app owns listening, port publishing, mDNS registration, UI, key storage and file writing. The libraries
  own the protocol. One listener loop calls `serve` (Rust) / `QuickSend.serve` (Kotlin) per accepted
  connection; it returns either a pending pairing (show the SAS) or a received file.
- Run the protocol on a worker thread: all calls block. The accept callback runs on that thread; if it
  waits for UI it should give up before 60 s (the sender stops waiting then) and answer "decline".
- Show the SAS as `123 456`, the peer name, and the question above. Give the user an obvious "They don't match"
  button. Never auto-confirm.
- Keep `allow_pairing` false except while the pairing screen is open.
- After a successful receive, treat the bytes as untrusted input to the image decoder.
- Never log image bytes, names or keys.

## 13. Security notes

- ECDH public values are validated on decode. Secrets are zeroized on drop in Rust; the JVM cannot guarantee
  this, so the Kotlin library only drops references.
- All MAC and hash comparisons on secrets use constant-time comparison (`subtle`, `MessageDigest.isEqual`).
- AEAD failure reveals nothing but the failure. The session is aborted at the first bad frame.
- The pair key is symmetric: either side can impersonate the other to a third party. This is acceptable for a
  two-device trust relationship.
- A six-digit SAS is a human-factor defence, sized for a live comparison of two screens held side by side.
  Apps must not offer to "type the code in" from one device to the other.

## 14. Test vectors

`packages/quicksend-vectors/vectors.json` is generated by the Rust test `vectors::generate_or_check`
(`POLISHOT_WRITE_VECTORS=1 cargo test -p polishot-quicksend vectors` rewrites it; without the variable the same
test fails if the file is stale) and asserted by both the Rust and the Kotlin tests. All keys are fixed and
derived from public labels, so the file secures nothing. All byte strings are lower-case hex; the file is pure
ASCII (non-ASCII test strings are `\u` escapes).

| Key | Contents |
|---|---|
| `identities.a`, `identities.b` | `private` (32 bytes), `public` (65), `id` |
| `device_id_cases` | raw id bytes and the expected base32 text |
| `sas_cases` | transcript, the raw 8-byte HKDF output `okm`, expected SAS. At least one `okm` has the top bit set, which catches signed 64-bit arithmetic. |
| `string_cases` | inputs and expected outputs of `sanitize_file_name` and `clean_device_name` |
| `pairing` | both ephemerals, `commit`, `z_ee`, `z_ss`, `transcript`, `sas`, `pair_key`, both confirm MACs, both persisted pair records, and `wire_initiator` / `wire_responder` (every frame, in order, as written by that side) |
| `transfer` | both ephemerals, `pair_key`, `z`, `transcript`, `k_s2r`, `k_r2s`, `auth_s`, `auth_r`, the file (name, MIME, bytes, SHA-256), `aead_sender_to_receiver` (three sealed frames with counter, type, AAD, nonce, plaintext, ciphertext and the full frame), `aead_receiver_to_sender_first`, and `wire_sender` / `wire_receiver` |

The Kotlin tests assert every derived value, then replay the recorded Rust bytes through the Kotlin state machines
with the same fixed keys: the Kotlin initiator and sender read the recorded responder and receiver frames, the
Kotlin responder and receiver read the recorded initiator and sender frames, and in each case the bytes the Kotlin
side writes must equal the recorded ones exactly. A change to the protocol therefore means: edit this document,
change both implementations, regenerate the vectors, review the diff.

## 15. API summary

Rust (`polishot-quicksend`): `Identity::{generate, from_bytes, to_bytes, public, id}`,
`pair_initiator(stream, &identity, name) -> PendingPairing`, `pair_responder(...)`, `PendingPairing::{sas, peer_name,
peer_id, confirm(bool) -> PairRecord}`, `send_file(stream, &identity, &pair, &FileMeta, bytes)`,
`receive(stream, &identity, &pairs, accept_cb) -> ReceivedFile`, `serve(stream, &ServeConfig, accept_cb) ->
Incoming`, `PairingRateLimiter`, `Config`/`Timeouts`, `PairRecord::{to_bytes, from_bytes}`, and with the `discovery`
feature `discovery::{Advertiser, Browser, Peer, PeerEvent}`. `Transport` is implemented for `TcpStream`; `duplex()`
gives an in-memory pair for tests.

Kotlin (`:quicksend`, package `app.polishot.quicksend`): `Identity.{generate, fromBytes, toBytes, publicKey, id}`,
`QuickSend.{pairInitiator, pairResponder, sendFile, receive, serve}`, `PendingPairing.{sas, peerName, peerId,
confirm, cancel}`, `PairRecord.{toBytes, fromBytes}`, `ServeConfig`, `Incoming.{Pairing, Received}`, `Config`,
`PairingRateLimiter`, `Content`, `Discovery` (TXT helpers for `NsdManager`), `Transport.of(socket)`,
`QuickSendException` with `Failure` and `ErrorCode`.

The two `Identity` byte encodings differ on purpose and are never exchanged between devices: Rust stores the
32-byte scalar, Kotlin stores scalar plus public key (97 bytes) because the JCA cannot derive a public key from a
scalar.
