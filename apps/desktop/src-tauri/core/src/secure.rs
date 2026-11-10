//! Windows DPAPI (`CryptProtectData`): secrets stored on disk are bound to the current Windows
//! user, so copying the file to another account or machine yields nothing readable.

use windows::core::w;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

/// Extra secret mixed into the key so other programs running as this user cannot trivially
/// unprotect our blobs by calling DPAPI without it.
const ENTROPY: &[u8] = b"polishot.quicksend.v1";

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    }
}

/// Copy the system-allocated output blob and free it.
///
/// # Safety
/// `out` must have been filled by a successful DPAPI call.
unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let v = if out.pbData.is_null() {
        Vec::new()
    } else {
        std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec()
    };
    if !out.pbData.is_null() {
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut std::ffi::c_void)));
    }
    v
}

/// Encrypt `plain` for the current user.
pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    let input = blob(plain);
    let entropy = blob(ENTROPY);
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: the input blobs point at live slices for the duration of the call; `out` is freed by
    // `take`.
    unsafe {
        CryptProtectData(
            &input,
            w!("Polishot"),
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .map_err(|_| "Could not protect the data with Windows.".to_string())?;
        Ok(take(out))
    }
}

/// Decrypt a blob produced by [`protect`] for this user. Tampered or foreign data fails.
pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.is_empty() {
        return Err("Nothing to unprotect.".to_string());
    }
    let input = blob(sealed);
    let entropy = blob(ENTROPY);
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in `protect`.
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .map_err(|_| "The stored data could not be unlocked.".to_string())?;
        Ok(take(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_ciphertext_differs() {
        let secret = b"0123456789abcdef0123456789abcdef";
        let sealed = protect(secret).unwrap();
        assert_ne!(&sealed[..], &secret[..]);
        assert!(sealed.len() > secret.len());
        assert!(!sealed.windows(secret.len()).any(|w| w == secret));
        assert_eq!(unprotect(&sealed).unwrap(), secret);
    }

    #[test]
    fn empty_and_large_payloads() {
        assert_eq!(unprotect(&protect(b"").unwrap()).unwrap(), b"");
        let big = vec![7u8; 100_000];
        assert_eq!(unprotect(&protect(&big).unwrap()).unwrap(), big);
    }

    #[test]
    fn tampering_is_detected() {
        let mut sealed = protect(b"secret").unwrap();
        let mid = sealed.len() / 2;
        sealed[mid] ^= 0x01;
        assert!(unprotect(&sealed).is_err());
        assert!(unprotect(&[]).is_err());
        assert!(unprotect(b"not a dpapi blob").is_err());
    }
}
