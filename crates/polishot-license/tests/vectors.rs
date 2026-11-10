//! Runs the shared vectors (`packages/license/test-vectors.json`) and a garbage-input sweep.

use polishot_license::{public_key_from_hex, verify, verify_prod, Edition, LicenseError};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/license/test-vectors.json"
    );
    let text = std::fs::read_to_string(path).expect("read test-vectors.json");
    serde_json::from_str(&text).expect("parse test-vectors.json")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn reason_to_error(reason: &str) -> LicenseError {
    match reason {
        "format" => LicenseError::Format,
        "length" => LicenseError::Length,
        "version" => LicenseError::Version,
        "signature" => LicenseError::Signature,
        other => panic!("unknown reason {other:?} in vectors"),
    }
}

#[test]
fn shared_vectors() {
    let doc = vectors();
    let public_key = public_key_from_hex(doc["publicKeyHex"].as_str().expect("publicKeyHex"))
        .expect("test public key");
    let cases = doc["cases"].as_array().expect("cases");
    assert!(cases.len() >= 11, "vectors file looks truncated");

    let (mut valid, mut invalid) = (0, 0);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let key = case["key"].as_str().expect("key");
        let result = verify(key, &public_key);

        if case["valid"].as_bool().expect("valid") {
            valid += 1;
            let info = result.unwrap_or_else(|e| panic!("{name}: expected valid, got {e:?}"));
            assert_eq!(info.version, 1, "{name}");
            assert_eq!(
                info.edition.as_str(),
                case["edition"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(
                u64::from(info.issued_days),
                case["issuedDays"].as_u64().unwrap(),
                "{name}"
            );
            assert_eq!(
                info.key_id_hex(),
                case["keyIdHex"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(hex(&info.key_id), info.key_id_hex(), "{name}");
            assert_eq!(
                info.licensee_hash_hex(),
                case["licenseeHash"].as_str().unwrap(),
                "{name}"
            );
        } else {
            invalid += 1;
            let expected = reason_to_error(case["reason"].as_str().expect("reason"));
            assert_eq!(result, Err(expected), "{name}");
        }
    }
    assert!(
        valid >= 3 && invalid >= 8,
        "valid={valid} invalid={invalid}"
    );
}

#[test]
fn vectors_cover_every_error_and_both_editions() {
    let doc = vectors();
    let cases = doc["cases"].as_array().unwrap();
    for reason in ["format", "length", "version", "signature"] {
        assert!(
            cases.iter().any(|c| c["reason"] == reason),
            "no vector for {reason}"
        );
    }
    for edition in ["personal", "team"] {
        assert!(cases.iter().any(|c| c["edition"] == edition));
    }
    // Sanity check on the typed API.
    let public_key = public_key_from_hex(doc["publicKeyHex"].as_str().unwrap()).unwrap();
    let team = cases.iter().find(|c| c["name"] == "valid-team").unwrap();
    let info = verify(team["key"].as_str().unwrap(), &public_key).unwrap();
    assert_eq!(info.edition, Edition::Team);
}

#[test]
fn test_vectors_do_not_verify_against_the_production_key() {
    let doc = vectors();
    for case in doc["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let key = case["key"].as_str().unwrap();
        let result = verify_prod(key);
        assert!(
            result.is_err(),
            "{name} verified against the production key"
        );
    }
}

#[test]
fn production_key_is_a_usable_ed25519_key() {
    // Any well-formed key fails at the signature step, never at "public key unreadable".
    let doc = vectors();
    let valid = doc["cases"][0]["key"].as_str().unwrap();
    assert_eq!(verify_prod(valid), Err(LicenseError::Signature));
}

#[test]
fn garbage_never_panics_and_never_verifies() {
    let doc = vectors();
    let public_key = public_key_from_hex(doc["publicKeyHex"].as_str().unwrap()).unwrap();
    let valid = doc["cases"][0]["key"].as_str().unwrap().to_owned();

    let mut inputs: Vec<String> = vec![
        String::new(),
        " ".into(),
        "PSHOT-".into(),
        "pshot-".into(),
        "PSHOT".into(),
        "-".into(),
        "U".into(),
        "!".into(),
        "\0".into(),
        "\u{feff}".into(),
        "\u{00a0}".into(),
        "日本語".into(),
        "🙂".repeat(100),
        "A".repeat(150),
        "A".repeat(151),
        "A".repeat(152),
        "0".repeat(299),
        "0".repeat(300),
        "0".repeat(301),
        "0".repeat(10_000),
        "-".repeat(299),
        valid[..valid.len() - 1].to_owned(),
        format!("{valid}0"),
        format!("{valid}U"),
        valid.replace('-', ""),
    ];
    // Cut a valid key at every position (UTF-8 safe because the key is ASCII).
    for end in 0..valid.len() {
        inputs.push(valid[..end].to_owned());
    }
    // Deterministic pseudo-random strings over mixed alphabets.
    let alphabets: [&[char]; 3] = [
        &['0', '1', 'A', 'Z', 'O', 'I', 'L', 'o', 'i', 'l', '-', ' '],
        &[
            'U', 'u', '!', '#', '_', '=', '\n', '\t', '\r', '\u{b}', '\u{c}',
        ],
        &['é', '日', '🙂', '\u{0}', '\u{ffff}', '–', 'A', '0'],
    ];
    let mut state = 0x9e37_79b9_u32;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state
    };
    for i in 0..2000 {
        let alphabet = alphabets[i % alphabets.len()];
        let len = (next() % 320) as usize;
        let s: String = (0..len)
            .map(|_| alphabet[(next() as usize) % alphabet.len()])
            .collect();
        inputs.push(s);
    }

    for input in &inputs {
        // Cut keys are never valid; everything else here is garbage.
        assert!(
            verify(input, &public_key).is_err(),
            "unexpectedly valid: {input:?}"
        );
    }
}

#[test]
fn limits_and_precedence() {
    let doc = vectors();
    let public_key = public_key_from_hex(doc["publicKeyHex"].as_str().unwrap()).unwrap();
    let valid = doc["cases"][0]["key"].as_str().unwrap();

    // Exactly 300 bytes is still parsed; 301 is rejected before anything else.
    let padded = format!("{valid}{}", " ".repeat(300 - valid.len()));
    assert_eq!(padded.len(), 300);
    assert!(verify(&padded, &public_key).is_ok());
    assert_eq!(
        verify(&format!("{padded} "), &public_key),
        Err(LicenseError::Length)
    );
    assert_eq!(
        verify(&"!".repeat(301), &public_key),
        Err(LicenseError::Length)
    );

    // A bad character is reported before a bad length.
    assert_eq!(verify("PSHOT-U", &public_key), Err(LicenseError::Format));
    // Case-insensitive prefix, and ASCII whitespace variants.
    assert!(verify(&valid.to_lowercase(), &public_key).is_ok());
    assert!(verify(
        &format!("PSHOT-{}", valid[6..].replace('-', " ")),
        &public_key
    )
    .is_ok());
    assert!(
        verify(&valid[6..], &public_key).is_ok(),
        "prefix is optional"
    );
    assert!(verify(&format!("\u{b}\u{c}{valid}\r\n"), &public_key).is_ok());
    // Non-ASCII whitespace is not whitespace.
    assert_eq!(
        verify(&format!("\u{a0}{valid}"), &public_key),
        Err(LicenseError::Format)
    );
}
