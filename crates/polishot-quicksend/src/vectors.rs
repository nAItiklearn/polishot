//! Shared test vectors (`packages/quicksend-vectors/vectors.json`).
//!
//! This test is the generator: `POLISHOT_WRITE_VECTORS=1 cargo test -p polishot-quicksend vectors` rewrites the
//! file from the Rust implementation. Without the variable it re-derives everything and asserts that the file
//! on disk is byte-for-byte what this build produces. The Kotlin tests assert the same file, which is the
//! interoperability guarantee. All keys are fixed and derived from public labels; they secure nothing.

use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::content::{clean_device_name, sanitize_file_name};
use crate::crypto::{sha256, KeyPair, Sealer};
use crate::identity::{DeviceId, Identity, PairRecord};
use crate::pairing::{initiator_impl, pair_responder_impl};
use crate::proto::{frame_type, Config, DIR_R2S, DIR_S2R};
use crate::transfer::{derive_session, receive_impl, send_file_impl, FileMeta};
use crate::transport::{duplex, MemoryStream, Transport};

const NAME_A: &str = "Studio PC";
const NAME_B: &str = "Pixel 9";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A key derived from a public label so anyone can reproduce it.
fn fixed_secret(label: &str) -> [u8; 32] {
    sha256(&[b"polishot-qs-vector/", label.as_bytes()])
}

fn fixed_key(label: &str) -> KeyPair {
    KeyPair::from_secret_bytes(&fixed_secret(label)).unwrap()
}

fn fixed_identity(label: &str) -> Identity {
    Identity::from_bytes(&fixed_secret(label)).unwrap()
}

/// Wraps a stream and records everything written to it.
struct Recorder {
    inner: MemoryStream,
    log: Arc<Mutex<Vec<u8>>>,
}

impl Read for Recorder {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Write for Recorder {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.log.lock().unwrap().extend_from_slice(&buf[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl Transport for Recorder {
    fn set_read_timeout(&mut self, dur: Option<Duration>) -> io::Result<()> {
        self.inner.set_read_timeout(dur)
    }
    fn set_write_timeout(&mut self, dur: Option<Duration>) -> io::Result<()> {
        self.inner.set_write_timeout(dur)
    }
}

type Log = Arc<Mutex<Vec<u8>>>;

fn recorded_pair() -> (Recorder, Recorder, Log, Log) {
    let (a, b) = duplex();
    let la: Log = Arc::default();
    let lb: Log = Arc::default();
    (
        Recorder {
            inner: a,
            log: la.clone(),
        },
        Recorder {
            inner: b,
            log: lb.clone(),
        },
        la,
        lb,
    )
}

/// Split a byte stream into its frames, as hex strings.
fn frames(log: &Log) -> Vec<String> {
    let bytes = log.lock().unwrap().clone();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let len = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        out.push(hex(&bytes[i..i + 4 + len]));
        i += 4 + len;
    }
    assert_eq!(i, bytes.len());
    out
}

fn key_json(kp: &KeyPair) -> Value {
    json!({ "private": hex(&kp.secret_bytes()[..]), "public": hex(kp.public()) })
}

struct PairingRun {
    json: Value,
    rec_a_has_b: PairRecord,
    rec_b_has_a: PairRecord,
}

fn pairing_vector(a: &Identity, b: &Identity) -> PairingRun {
    let cfg = Config::default();
    let (ra, rb, la, lb) = recorded_pair();
    let (resp, init) = thread::scope(|s| {
        let hb = s.spawn(|| {
            let p = pair_responder_impl(
                rb,
                b,
                NAME_B,
                None,
                &cfg,
                fixed_key("eph-pairing-responder"),
            )
            .unwrap();
            let meta = (p.sas().to_string(), p.transcript, *p.pair_key);
            (meta, p.confirm(true).unwrap())
        });
        let pa = initiator_impl(ra, a, NAME_A, &cfg, fixed_key("eph-pairing-initiator")).unwrap();
        let meta = (pa.sas().to_string(), pa.transcript, *pa.pair_key);
        let rec = pa.confirm(true).unwrap();
        (hb.join().unwrap(), (meta, rec))
    });
    let ((sas_r, t_r, k_r), rec_b_has_a) = resp;
    let ((sas_i, t_i, k_i), rec_a_has_b) = init;
    assert_eq!(
        (&sas_r, t_r, k_r),
        (&sas_i, t_i, k_i),
        "both sides must agree"
    );

    let eph_i = fixed_key("eph-pairing-initiator");
    let eph_r = fixed_key("eph-pairing-responder");
    let ver = 1u8;
    let commit = crate::pairing::commitment(ver, a.public(), eph_i.public());
    let z_ee = eph_i.ecdh(eph_r.public()).unwrap();
    let z_ss = a.keypair().ecdh(b.public()).unwrap();
    let mac_i = crate::crypto::hmac_sha256(&k_i, &[crate::proto::L_CONFIRM_I, &t_i]).unwrap();
    let mac_r = crate::crypto::hmac_sha256(&k_i, &[crate::proto::L_CONFIRM_R, &t_i]).unwrap();

    let json = json!({
        "version": ver,
        "initiator": "a",
        "responder": "b",
        "initiator_name": NAME_A,
        "responder_name": NAME_B,
        "ephemeral_initiator": key_json(&eph_i),
        "ephemeral_responder": key_json(&eph_r),
        "commit": hex(&commit),
        "z_ee": hex(&z_ee[..]),
        "z_ss": hex(&z_ss[..]),
        "transcript": hex(&t_i),
        "sas": sas_i,
        "pair_key": hex(&k_i),
        "confirm_mac_initiator": hex(&mac_i),
        "confirm_mac_responder": hex(&mac_r),
        "record_initiator_has_responder": hex(&rec_a_has_b.to_bytes()),
        "record_responder_has_initiator": hex(&rec_b_has_a.to_bytes()),
        "wire_initiator": frames(&la),
        "wire_responder": frames(&lb),
    });
    PairingRun {
        json,
        rec_a_has_b,
        rec_b_has_a,
    }
}

fn vector_png() -> Vec<u8> {
    let mut v = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    v.extend((0u8..92).map(|i| i.wrapping_mul(7).wrapping_add(3)));
    v
}

fn transfer_vector(
    a: &Identity,
    b: &Identity,
    rec_a_has_b: &PairRecord,
    rec_b_has_a: &PairRecord,
) -> Value {
    let cfg = Config::default();
    let data = vector_png();
    let meta = FileMeta::new("vector.png", "image/png");
    let (rs, rr, ls, lr) = recorded_pair();
    thread::scope(|s| {
        let h = s.spawn(|| {
            receive_impl(
                rr,
                b,
                std::slice::from_ref(rec_b_has_a),
                &cfg,
                |_| true,
                &mut |_, _| {},
                fixed_key("eph-transfer-receiver"),
            )
            .unwrap()
        });
        send_file_impl(
            rs,
            a,
            rec_a_has_b,
            &meta,
            &data,
            &cfg,
            &mut |_, _| {},
            fixed_key("eph-transfer-sender"),
        )
        .unwrap();
        let got = h.join().unwrap();
        assert_eq!(got.data, data);
    });

    let eph_s = fixed_key("eph-transfer-sender");
    let eph_r = fixed_key("eph-transfer-receiver");
    let keys = derive_session(
        1,
        &a.id(),
        &b.id(),
        eph_s.public(),
        eph_r.public(),
        &eph_s,
        eph_r.public(),
        &rec_a_has_b.pair_key,
    )
    .unwrap();
    let z = eph_s.ecdh(eph_r.public()).unwrap();

    // The record layer in isolation: three frames from the sender's key with the same sequence of counters
    let mut sealer = Sealer::new(&keys.k_s2r, DIR_S2R, 1).unwrap();
    let mut aead = Vec::new();
    let samples: [(u8, &[u8]); 3] = [
        (frame_type::CHUNK, b"polishot quick send test vector"),
        (frame_type::CHUNK, b"second frame, counter 1"),
        (frame_type::DONE, b""),
    ];
    for (i, (ty, pt)) in samples.iter().enumerate() {
        let ct = sealer.seal(*ty, pt).unwrap();
        let mut nonce = DIR_S2R.to_vec();
        nonce.extend_from_slice(&(i as u64).to_be_bytes());
        let mut frame = ((1 + ct.len()) as u32).to_be_bytes().to_vec();
        frame.push(*ty);
        frame.extend_from_slice(&ct);
        aead.push(json!({
            "counter": i,
            "type": ty,
            "aad": hex(&[1, *ty]),
            "nonce": hex(&nonce),
            "plaintext": hex(pt),
            "ciphertext": hex(&ct),
            "frame": hex(&frame),
        }));
    }
    // and the reverse direction, so a wrong direction tag cannot pass
    let mut back = Sealer::new(&keys.k_r2s, DIR_R2S, 1).unwrap();
    let ct = back.seal(frame_type::ACCEPT, b"").unwrap();

    json!({
        "version": 1,
        "sender": "a",
        "receiver": "b",
        "ephemeral_sender": key_json(&eph_s),
        "ephemeral_receiver": key_json(&eph_r),
        "pair_key": hex(&rec_a_has_b.pair_key),
        "z": hex(&z[..]),
        "transcript": hex(&keys.transcript),
        "k_s2r": hex(&keys.k_s2r[..]),
        "k_r2s": hex(&keys.k_r2s[..]),
        "auth_s": hex(&keys.auth_s),
        "auth_r": hex(&keys.auth_r),
        "file": {
            "name": "vector.png",
            "mime": "image/png",
            "data": hex(&data),
            "sha256": hex(&sha256(&[&data])),
        },
        "aead_sender_to_receiver": aead,
        "aead_receiver_to_sender_first": { "type": frame_type::ACCEPT, "ciphertext": hex(&ct) },
        "wire_sender": frames(&ls),
        "wire_receiver": frames(&lr),
    })
}

fn sas_cases() -> Value {
    let mut cases = Vec::new();
    for n in 0..8 {
        let t = sha256(&[format!("polishot-qs-vector/sas-case-{n}").as_bytes()]);
        let sas = crate::pairing::sas_from_transcript(&t).unwrap();
        // also record the raw 64-bit value: Kotlin's Long is signed, so values with the top bit set matter
        let mut okm = [0u8; 8];
        crate::crypto::hkdf(&[], &t, &[crate::proto::I_SAS], &mut okm).unwrap();
        cases.push(json!({ "transcript": hex(&t), "okm": hex(&okm), "sas": sas }));
    }
    Value::Array(cases)
}

fn string_cases() -> Value {
    let long = format!("{}.png", "ä".repeat(100));
    let sanitize_inputs: Vec<String> = vec![
        "shot.png".into(),
        "../../etc/passwd".into(),
        "a:b*c?.png".into(),
        "  ...  ".into(),
        "con.png".into(),
        "NUL".into(),
        "COM10.png".into(),
        "x/y".into(),
        "..a..".into(),
        "\u{202E}evil.png".into(),
        "Screenshot 2026-11-10 12:00:00.png".into(),
        "a\tb.png".into(),
        "ünï😀.png".into(),
        "..\\..\\Windows\\evil.png".into(),
        long,
    ];
    let sanitize: Vec<Value> = sanitize_inputs
        .iter()
        .map(|i| json!({ "in": i, "out": sanitize_file_name(i) }))
        .collect();
    let clean_inputs: Vec<String> = vec![
        "Pixel 9".into(),
        "  \u{202E}Pixel\n 9  ".into(),
        "\n\n".into(),
        "é".repeat(40),
        "x".repeat(32),
        "😀".repeat(33),
    ];
    let clean: Vec<Value> = clean_inputs
        .iter()
        .map(|i| json!({ "in": i, "out": clean_device_name(i) }))
        .collect();
    json!({ "sanitize_file_name": sanitize, "clean_device_name": clean })
}

pub(crate) fn build() -> Value {
    let a = fixed_identity("identity-a");
    let b = fixed_identity("identity-b");
    let run = pairing_vector(&a, &b);
    let transfer = transfer_vector(&a, &b, &run.rec_a_has_b, &run.rec_b_has_a);
    json!({
        "format": "polishot-quicksend-vectors",
        "protocol_version": 1,
        "note": "Generated by the Rust test vectors::generate_or_check. Every field is lower-case hex unless it is a plain string.",
        "identities": {
            "a": { "private": hex(&a.to_bytes()[..]), "public": hex(a.public()), "id": a.id().to_string() },
            "b": { "private": hex(&b.to_bytes()[..]), "public": hex(b.public()), "id": b.id().to_string() },
        },
        "device_id_cases": [
            { "bytes": hex(b"foobarbazq"), "id": DeviceId::from_bytes(*b"foobarbazq").to_string() },
        ],
        "pairing": run.json,
        "transfer": transfer,
        "sas_cases": sas_cases(),
        "string_cases": string_cases(),
    })
}

fn vectors_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/quicksend-vectors/vectors.json")
}

#[test]
fn generate_or_check() {
    let generated = build();
    let path = vectors_path();
    if std::env::var_os("POLISHOT_WRITE_VECTORS").is_some() {
        let mut text = escape_non_ascii(&serde_json::to_string_pretty(&generated).unwrap());
        text.push('\n');
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        return;
    }
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}. Run with POLISHOT_WRITE_VECTORS=1 to create it.",
            path.display()
        )
    });
    let on_disk: Value = serde_json::from_str(&text).unwrap();
    assert!(
        on_disk == generated,
        "{} is out of date with this build. Review the change, then regenerate with POLISHOT_WRITE_VECTORS=1.",
        path.display()
    );
}

#[test]
fn generation_is_deterministic() {
    assert_eq!(build(), build());
}

#[test]
fn vector_corpus_covers_the_signed_arithmetic_edge_case() {
    // At least one SAS case must start from an HKDF output with the top bit set, so that an implementation
    // using signed 64-bit arithmetic (the JVM's Long) is caught.
    let cases = sas_cases();
    let any_top_bit = cases.as_array().unwrap().iter().any(|c| {
        let okm = c["okm"].as_str().unwrap();
        u8::from_str_radix(&okm[..2], 16).unwrap() & 0x80 != 0
    });
    assert!(any_top_bit);
}

#[test]
fn pairing_trace_has_the_documented_shape() {
    let v = build();
    let w = &v["pairing"];
    // initiator: HELLO, PAIR_REQUEST, PAIR_REVEAL, PAIR_CONFIRM; responder: HELLO, PAIR_RESPONSE, PAIR_CONFIRM
    let types = |k: &str| -> Vec<u8> {
        w[k].as_array()
            .unwrap()
            .iter()
            .map(|f| u8::from_str_radix(&f.as_str().unwrap()[8..10], 16).unwrap())
            .collect()
    };
    assert_eq!(types("wire_initiator"), vec![0x01, 0x02, 0x04, 0x05]);
    assert_eq!(types("wire_responder"), vec![0x01, 0x03, 0x05]);
    let t = &v["transfer"];
    let types = |k: &str| -> Vec<u8> {
        t[k].as_array()
            .unwrap()
            .iter()
            .map(|f| u8::from_str_radix(&f.as_str().unwrap()[8..10], 16).unwrap())
            .collect()
    };
    // sender: HELLO, AUTH, OFFER, CHUNK, DONE; receiver: HELLO, AUTH, ACCEPT, DONE
    assert_eq!(types("wire_sender"), vec![0x01, 0x10, 0x11, 0x14, 0x15]);
    assert_eq!(types("wire_receiver"), vec![0x01, 0x10, 0x12, 0x15]);
}

/// Write every non-ASCII character as a `\uXXXX` escape so invisible bidi/control characters in the
/// string cases are visible in review (and never trip "hidden Unicode" scanners).
fn escape_non_ascii(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    for c in json.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            for u in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{u:04x}"));
            }
        }
    }
    out
}

#[test]
fn escaping_round_trips() {
    let s = "a\u{202E}b😀é";
    let v = serde_json::json!({ "k": s });
    let text = escape_non_ascii(&serde_json::to_string(&v).unwrap());
    assert!(text.is_ascii());
    let back: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(back, v);
}
