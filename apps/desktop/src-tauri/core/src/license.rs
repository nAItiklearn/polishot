//! License activation on top of `polishot-license`.
//!
//! The key is verified offline (Ed25519) and stored in Windows Credential Manager under the
//! target `<product>/license`. Verification is injected so tests can use the shared vectors'
//! test-only public key while production uses `verify_prod`.

use polishot_license::{LicenseError, LicenseInfo};
use serde::Serialize;

/// Updates included with a key: it covers every build dated up to `issued + 365` days
/// (CONTRACTS section 5b).
pub const UPDATE_WINDOW_DAYS: u32 = 365;

pub fn updates_until_days(info: &LicenseInfo) -> u32 {
    info.issued_days.saturating_add(UPDATE_WINDOW_DAYS)
}

pub fn covers_build(info: &LicenseInfo, build_days: u32) -> bool {
    build_days <= updates_until_days(info)
}

/// `YYYY-MM-DD` for a count of days since 1970-01-01 (proleptic Gregorian, UTC).
pub fn iso_date(days_since_epoch: u32) -> String {
    // Howard Hinnant's civil_from_days.
    let z = i64::from(days_since_epoch) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// `LicenseStatus` from CONTRACTS sections 5 and 5b. `licensed` means *Pro is active*.
/// `issuedAt` is Unix epoch milliseconds; `updatesUntil` is an ISO date.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub licensed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issued_at: Option<u64>,
    /// `no-key`, `invalid` or `updates-expired` whenever `licensed` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updates_until: Option<String>,
}

impl LicenseStatus {
    pub fn unlicensed() -> Self {
        Self::without_pro("no-key")
    }

    fn without_pro(reason: &'static str) -> Self {
        Self {
            licensed: false,
            edition: None,
            key_id: None,
            issued_at: None,
            reason: Some(reason),
            updates_until: None,
        }
    }

    /// Status for a verified key and the build date of this app.
    pub fn from_info(info: &LicenseInfo, build_days: u32) -> Self {
        let covered = covers_build(info, build_days);
        Self {
            licensed: covered,
            edition: Some(info.edition.as_str().to_string()),
            key_id: Some(info.key_id_hex()),
            issued_at: Some(info.issued_at_unix_secs() * 1000),
            reason: (!covered).then_some("updates-expired"),
            updates_until: Some(iso_date(updates_until_days(info))),
        }
    }
}

/// Where the activated key lives.
pub trait SecretStore {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, secret: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

pub type Verifier<'a> = dyn Fn(&str) -> Result<LicenseInfo, LicenseError> + 'a;

/// Production verifier: the public key embedded in `polishot-license`.
pub fn prod_verifier(key: &str) -> Result<LicenseInfo, LicenseError> {
    polishot_license::verify_prod(key)
}

pub fn error_message(e: LicenseError) -> &'static str {
    match e {
        LicenseError::Format => {
            "That does not look like a license key. Check for typos and paste the whole key."
        }
        LicenseError::Length => {
            "That license key is the wrong length. Paste the whole key, including every group."
        }
        LicenseError::Version => {
            "That license key was made for a newer version of the app. Update and try again."
        }
        LicenseError::Signature => "That license key could not be verified. Check it for typos.",
    }
}

/// Verify and store a key. Nothing is stored unless verification succeeds.
pub fn activate(
    store: &dyn SecretStore,
    verify: &Verifier<'_>,
    key: &str,
    build_days: u32,
) -> Result<LicenseStatus, String> {
    let trimmed = key.trim();
    let info = verify(trimmed).map_err(|e| error_message(e).to_string())?;
    // A genuine key is kept even when this build is newer than its update window: the status
    // then reads `updates-expired` and the UI explains it.
    store.write(trimmed)?;
    Ok(LicenseStatus::from_info(&info, build_days))
}

/// Re-verify whatever is stored. A stored key that no longer verifies counts as unlicensed.
pub fn current(store: &dyn SecretStore, verify: &Verifier<'_>, build_days: u32) -> LicenseStatus {
    match store.read() {
        Ok(Some(key)) => verify(&key)
            .map(|info| LicenseStatus::from_info(&info, build_days))
            .unwrap_or_else(|_| LicenseStatus::without_pro("invalid")),
        _ => LicenseStatus::unlicensed(),
    }
}

pub fn deactivate(store: &dyn SecretStore) -> Result<LicenseStatus, String> {
    store.delete()?;
    Ok(LicenseStatus::unlicensed())
}

// ---- Windows Credential Manager ---------------------------------------------------------------

pub struct CredentialStore {
    target: String,
}

impl CredentialStore {
    pub fn new(target: impl Into<String>) -> Self {
        Self {
            target: target.into(),
        }
    }
}

mod cred {
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_NOT_FOUND, WIN32_ERROR};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn is_not_found(e: &windows::core::Error) -> bool {
        e.code() == windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0)
            || WIN32_ERROR(e.code().0 as u32 & 0xFFFF) == ERROR_NOT_FOUND
    }

    pub fn write(target: &str, secret: &[u8]) -> Result<(), String> {
        let target_w = HSTRING::from(target);
        let user_w = HSTRING::from("license");
        let mut blob = secret.to_vec();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target_w.as_ptr() as *mut u16),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user_w.as_ptr() as *mut u16),
            ..Default::default()
        };
        // SAFETY: `cred` points at buffers that live until the call returns; the API copies them.
        unsafe { CredWriteW(&cred, 0) }
            .map_err(|_| "Could not store the license in Windows Credential Manager.".to_string())
    }

    pub fn read(target: &str) -> Result<Option<Vec<u8>>, String> {
        let target_w = HSTRING::from(target);
        let mut out: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: on success `out` receives a buffer we must release with `CredFree`.
        let res =
            unsafe { CredReadW(PCWSTR(target_w.as_ptr()), CRED_TYPE_GENERIC, None, &mut out) };
        match res {
            Ok(()) => {
                // SAFETY: `out` is non-null after a successful read and the blob lies within it.
                let bytes = unsafe {
                    let c = &*out;
                    let v = if c.CredentialBlob.is_null() || c.CredentialBlobSize == 0 {
                        Vec::new()
                    } else {
                        std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize)
                            .to_vec()
                    };
                    CredFree(out as *const _);
                    v
                };
                Ok(Some(bytes))
            }
            Err(e) if is_not_found(&e) => Ok(None),
            Err(_) => Err("Could not read Windows Credential Manager.".to_string()),
        }
    }

    pub fn delete(target: &str) -> Result<(), String> {
        let target_w = HSTRING::from(target);
        // SAFETY: valid NUL-terminated wide string for the duration of the call.
        match unsafe { CredDeleteW(PCWSTR(target_w.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(e) if is_not_found(&e) => Ok(()),
            Err(_) => {
                Err("Could not remove the license from Windows Credential Manager.".to_string())
            }
        }
    }
}

impl SecretStore for CredentialStore {
    fn read(&self) -> Result<Option<String>, String> {
        Ok(cred::read(&self.target)?.and_then(|b| String::from_utf8(b).ok()))
    }

    fn write(&self, secret: &str) -> Result<(), String> {
        cred::write(&self.target, secret.as_bytes())
    }

    fn delete(&self) -> Result<(), String> {
        cred::delete(&self.target)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use serde::Deserialize;

    use super::*;

    #[derive(Default)]
    struct MemStore(RefCell<Option<String>>);

    impl SecretStore for MemStore {
        fn read(&self) -> Result<Option<String>, String> {
            Ok(self.0.borrow().clone())
        }
        fn write(&self, secret: &str) -> Result<(), String> {
            *self.0.borrow_mut() = Some(secret.to_string());
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            *self.0.borrow_mut() = None;
            Ok(())
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        public_key_hex: String,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        key: String,
        valid: bool,
        reason: Option<String>,
        edition: Option<String>,
        issued_days: Option<u64>,
        key_id_hex: Option<String>,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!(
            "../../../../../packages/license/test-vectors.json"
        ))
        .expect("shared license vectors parse")
    }

    fn build_inside_window(c: &Case) -> u32 {
        c.issued_days
            .map_or(0, |d| d.min(u64::from(u32::MAX)) as u32)
    }

    #[test]
    fn activation_matches_every_shared_vector() {
        let v = vectors();
        let pk = polishot_license::public_key_from_hex(&v.public_key_hex).unwrap();
        let verify = |k: &str| polishot_license::verify(k, &pk);
        assert!(v.cases.len() >= 20);
        for c in &v.cases {
            let store = MemStore::default();
            let build = build_inside_window(c);
            let res = activate(&store, &verify, &c.key, build);
            if c.valid {
                let st = res.unwrap_or_else(|e| panic!("{}: {e}", c.name));
                assert!(st.licensed, "{}", c.name);
                assert_eq!(st.reason, None, "{}", c.name);
                assert_eq!(st.edition, c.edition, "{}", c.name);
                assert_eq!(st.key_id, c.key_id_hex, "{}", c.name);
                assert_eq!(
                    st.issued_at,
                    c.issued_days.map(|d| d * 86_400 * 1000),
                    "{}",
                    c.name
                );
                assert_eq!(
                    st.updates_until,
                    Some(iso_date(build.saturating_add(UPDATE_WINDOW_DAYS))),
                    "{}",
                    c.name
                );
                assert!(store.read().unwrap().is_some(), "{}: key stored", c.name);
                assert_eq!(current(&store, &verify, build), st, "{}", c.name);
            } else {
                let msg = res.err().unwrap_or_else(|| panic!("{}: must fail", c.name));
                let expected = match c.reason.as_deref() {
                    Some("format") => error_message(LicenseError::Format),
                    Some("length") => error_message(LicenseError::Length),
                    Some("version") => error_message(LicenseError::Version),
                    Some("signature") => error_message(LicenseError::Signature),
                    other => panic!("{}: unknown reason {other:?}", c.name),
                };
                assert_eq!(msg, expected, "{}", c.name);
                assert!(
                    store.read().unwrap().is_none(),
                    "{}: nothing stored",
                    c.name
                );
                let st = current(&store, &verify, build);
                assert!(!st.licensed, "{}", c.name);
                assert_eq!(st.reason, Some("no-key"), "{}", c.name);
            }
        }
    }

    #[test]
    fn builds_after_the_update_window_behave_as_free_but_keep_the_license() {
        let v = vectors();
        let pk = polishot_license::public_key_from_hex(&v.public_key_hex).unwrap();
        let verify = |k: &str| polishot_license::verify(k, &pk);
        let good = v
            .cases
            .iter()
            .find(|c| c.valid && c.issued_days == Some(20468))
            .unwrap();
        let issued = 20468u32;
        for (build, pro) in [
            (0, true),
            (issued, true),
            (issued + UPDATE_WINDOW_DAYS, true), // last covered day
            (issued + UPDATE_WINDOW_DAYS + 1, false),
            (u32::MAX, false),
        ] {
            let store = MemStore::default();
            let st = activate(&store, &verify, &good.key, build).unwrap();
            assert_eq!(st.licensed, pro, "build {build}");
            assert_eq!(
                st.reason,
                (!pro).then_some("updates-expired"),
                "build {build}"
            );
            assert_eq!(st.edition.as_deref(), Some("personal"));
            assert_eq!(st.updates_until.as_deref(), Some("2027-01-15"));
            assert!(
                store.read().unwrap().is_some(),
                "the key is kept either way"
            );
            assert_eq!(current(&store, &verify, build), st);
        }
    }

    #[test]
    fn iso_dates() {
        assert_eq!(iso_date(0), "1970-01-01");
        assert_eq!(iso_date(59), "1970-03-01");
        assert_eq!(iso_date(789), "1972-02-29");
        assert_eq!(iso_date(19_723), "2024-01-01");
        assert_eq!(iso_date(20_454), "2026-01-01");
        assert_eq!(iso_date(20_468), "2026-01-15");
        assert_eq!(iso_date(20_833), "2027-01-15");
        assert!(iso_date(u32::MAX).starts_with("1176"));
    }

    #[test]
    fn deactivate_removes_the_key() {
        let v = vectors();
        let pk = polishot_license::public_key_from_hex(&v.public_key_hex).unwrap();
        let verify = |k: &str| polishot_license::verify(k, &pk);
        let good = v.cases.iter().find(|c| c.valid).unwrap();
        let build = build_inside_window(good);
        let store = MemStore::default();
        assert!(
            activate(&store, &verify, &good.key, build)
                .unwrap()
                .licensed
        );
        assert_eq!(deactivate(&store).unwrap(), LicenseStatus::unlicensed());
        assert!(store.read().unwrap().is_none());
        assert!(!current(&store, &verify, build).licensed);
        // Deactivating twice is fine.
        assert!(deactivate(&store).is_ok());
    }

    #[test]
    fn a_stored_key_that_stops_verifying_is_reported_invalid() {
        let store = MemStore::default();
        store.write("PSHOT-garbage").unwrap();
        let verify = |k: &str| polishot_license::verify(k, &[0u8; 32]);
        let st = current(&store, &verify, 0);
        assert!(!st.licensed);
        assert_eq!(st.reason, Some("invalid"));
    }

    #[test]
    fn production_key_rejects_test_vector_keys() {
        let v = vectors();
        let good = v.cases.iter().find(|c| c.valid).unwrap();
        let store = MemStore::default();
        // Test vectors are signed with a test-only key, so the production verifier must refuse them.
        assert!(activate(&store, &prod_verifier, &good.key, 0).is_err());
    }

    #[test]
    fn status_json_shape() {
        let json = serde_json::to_string(&LicenseStatus::unlicensed()).unwrap();
        assert_eq!(json, r#"{"licensed":false,"reason":"no-key"}"#);
        let s = LicenseStatus {
            licensed: true,
            edition: Some("team".into()),
            key_id: Some("00ff".into()),
            issued_at: Some(5),
            reason: None,
            updates_until: Some("2027-01-01".into()),
        };
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"licensed":true,"edition":"team","keyId":"00ff","issuedAt":5,"updatesUntil":"2027-01-01"}"#
        );
    }

    /// Real Windows Credential Manager round trip under a throwaway target.
    #[test]
    fn credential_manager_round_trip() {
        let target = format!("PolishotTest/license-{}", crate::ids::new_id());
        let store = CredentialStore::new(target);
        assert_eq!(store.read().unwrap(), None);
        store.write("PSHOT-ABC").unwrap();
        assert_eq!(store.read().unwrap().as_deref(), Some("PSHOT-ABC"));
        store.write("PSHOT-DEF").unwrap();
        assert_eq!(store.read().unwrap().as_deref(), Some("PSHOT-DEF"));
        store.delete().unwrap();
        assert_eq!(store.read().unwrap(), None);
        store.delete().unwrap();
    }
}
