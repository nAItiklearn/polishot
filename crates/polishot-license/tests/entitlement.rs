//! Runs the shared `entitlementCases` vectors (`packages/license/test-vectors.json`) through the Rust
//! entitlement logic, the twin of the TypeScript `entitlement()` and the Kotlin port.

use polishot_license::{
    entitlement, entitlement_with_key, public_key_from_hex, verify, Entitlement, LicenseError,
};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/license/test-vectors.json"
    );
    let text = std::fs::read_to_string(path).expect("read test-vectors.json");
    serde_json::from_str(&text).expect("parse test-vectors.json")
}

fn test_key(doc: &Value) -> [u8; 32] {
    public_key_from_hex(doc["publicKeyHex"].as_str().expect("publicKeyHex")).expect("test key")
}

fn build_days(case: &Value) -> u32 {
    u32::try_from(case["buildDays"].as_u64().expect("buildDays")).expect("buildDays fits in u32")
}

#[test]
fn shared_entitlement_vectors() {
    let doc = vectors();
    let public_key = test_key(&doc);
    let cases = doc["entitlementCases"]
        .as_array()
        .expect("entitlementCases");
    assert!(cases.len() >= 10, "entitlement vectors look truncated");

    for case in cases {
        let name = case["name"].as_str().expect("name");
        let key = case["key"].as_str().expect("key");
        let got = entitlement_with_key(Some(key), &public_key, build_days(case));

        assert_eq!(got.pro, case["pro"].as_bool().expect("pro"), "{name}");
        assert_eq!(got.reason, case["reason"].as_str(), "{name}");
        assert_eq!(
            got.updates_until_days.map(u64::from),
            case["updatesUntilDays"].as_u64(),
            "{name}"
        );
        // `reason` is present exactly when Pro is off.
        assert_eq!(got.reason.is_some(), !got.pro, "{name}");

        // The key text decides nothing else: a blank key is the same as passing None.
        if key.trim().is_empty() {
            assert_eq!(
                entitlement_with_key(None, &public_key, build_days(case)),
                got,
                "{name}"
            );
        }
    }
}

#[test]
fn vectors_cover_the_boundary_and_every_reason() {
    let doc = vectors();
    let cases = doc["entitlementCases"].as_array().unwrap();
    let until = |c: &Value| c["updatesUntilDays"].as_u64();

    // Inclusive boundary: a pro case built exactly on the last covered day.
    assert!(cases
        .iter()
        .any(|c| c["pro"] == true && until(c) == c["buildDays"].as_u64()));
    // One day after the boundary: expired.
    assert!(cases.iter().any(|c| {
        c["reason"] == "updates-expired" && until(c).map(|u| u + 1) == c["buildDays"].as_u64()
    }));
    for reason in ["no-key", "invalid", "updates-expired"] {
        assert!(cases.iter().any(|c| c["reason"] == reason), "{reason}");
    }
    // The saturation vector: issued on day u32::MAX, so the window ends at u32::MAX.
    assert!(cases
        .iter()
        .any(|c| until(c) == Some(u64::from(u32::MAX)) && c["pro"] == true));
}

#[test]
fn rust_and_vectors_agree_on_the_window_for_every_valid_key() {
    let doc = vectors();
    let public_key = test_key(&doc);
    for case in doc["cases"].as_array().unwrap() {
        if case["valid"] != true {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        let info = verify(case["key"].as_str().unwrap(), &public_key).unwrap();
        let issued = case["issuedDays"].as_u64().unwrap();
        assert_eq!(
            u64::from(info.updates_until_days()),
            (issued + 365).min(u64::from(u32::MAX)),
            "{name}"
        );
        assert!(info.covers_build(info.updates_until_days()), "{name}");
        if let Some(next) = info.updates_until_days().checked_add(1) {
            assert!(!info.covers_build(next), "{name}");
        }
    }
}

#[test]
fn the_production_key_never_accepts_a_test_vector() {
    let doc = vectors();
    for case in doc["entitlementCases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let key = case["key"].as_str().unwrap();
        let got = entitlement(Some(key), build_days(case));
        assert!(!got.pro, "{name} unlocked Pro under the production key");
        if key.trim().is_empty() {
            assert_eq!(got, Entitlement::NO_KEY, "{name}");
        } else {
            assert_eq!(got, Entitlement::INVALID, "{name}");
        }
    }
    assert_eq!(entitlement(None, 20_000), Entitlement::NO_KEY);
}

#[test]
fn verification_errors_never_leak_into_the_entitlement() {
    // An unreadable public key cannot verify anything, so every non-blank key is invalid.
    let doc = vectors();
    let valid = doc["cases"][0]["key"].as_str().unwrap();
    let wrong_key = [0u8; 32];
    assert_eq!(verify(valid, &wrong_key), Err(LicenseError::Signature));
    assert_eq!(
        entitlement_with_key(Some(valid), &wrong_key, 20_000),
        Entitlement::INVALID
    );
}
