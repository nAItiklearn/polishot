//! A hand-driven malicious sender: authenticated (it holds a valid pair key) but free to send any sealed
//! messages. Proves the receiver enforces every limit itself and never trusts the sender to follow the rules.

use std::thread;
use std::time::Duration;

use crate::crypto::{sha256, KeyPair};
use crate::error::{Error, Result};
use crate::frame::Conn;
use crate::identity::{Identity, PairRecord};
use crate::proto::{frame_type, Config, ErrorCode, CHUNK_SIZE, MAX_FILE_SIZE, MAX_FRAME};
use crate::transfer::{encode_offer, receive, sender_handshake, ReceivedFile};
use crate::transport::{duplex, MemoryStream};

struct Fixture {
    a: Identity,
    b: Identity,
    a_has_b: PairRecord,
    b_has_a: PairRecord,
}

fn fixture() -> Fixture {
    let a = Identity::generate();
    let b = Identity::generate();
    let key = [0x42u8; 32];
    let a_has_b = PairRecord::new(b.public(), key, "Phone").unwrap();
    let b_has_a = PairRecord::new(a.public(), key, "Studio PC").unwrap();
    Fixture {
        a,
        b,
        a_has_b,
        b_has_a,
    }
}

const PNG: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

fn png(len: usize) -> Vec<u8> {
    let mut v = PNG.to_vec();
    v.resize(len, 7);
    v
}

/// Drive a malicious sender through `script` against a real receiver that accepts every offer.
fn attack(
    script: impl FnOnce(&mut Conn<MemoryStream>) -> Result<()> + Send,
) -> (Result<ReceivedFile>, Result<()>) {
    let f = fixture();
    let (sa, sb) = duplex();
    thread::scope(|s| {
        let rx = s.spawn(|| receive(sb, &f.b, std::slice::from_ref(&f.b_has_a), |_| true));
        let mut conn = Conn::new(sa, Config::default()).unwrap();
        let eph = KeyPair::generate().unwrap();
        let r = sender_handshake(&mut conn, &f.a, &f.a_has_b, &eph).and_then(|_| script(&mut conn));
        drop(conn);
        let got = rx.join().unwrap();
        (got, r)
    })
}

fn offer(size: u64, data: &[u8], mime: &str, name: &str) -> Vec<u8> {
    encode_offer(size, &sha256(&[data]), mime, name).unwrap()
}

fn expect_accept(conn: &mut Conn<MemoryStream>) -> Result<()> {
    let (ty, _) = conn.recv_sealed(Duration::from_secs(5))?;
    assert_eq!(ty, frame_type::ACCEPT);
    Ok(())
}

#[test]
fn oversized_offer_is_rejected() {
    let (got, sent) = attack(|c| {
        c.send_sealed(
            frame_type::OFFER,
            &offer(MAX_FILE_SIZE + 1, b"x", "image/png", "a.png"),
        )?;
        c.recv_sealed(Duration::from_secs(5)).map(|_| ())
    });
    assert!(matches!(got, Err(Error::TooLarge)), "{got:?}");
    assert!(
        matches!(sent, Err(Error::Remote(ErrorCode::TooLarge))),
        "{sent:?}"
    );
}

#[test]
fn exactly_the_maximum_size_is_still_offered_to_the_user() {
    let (got, _) = attack(|c| {
        c.send_sealed(
            frame_type::OFFER,
            &offer(MAX_FILE_SIZE, b"x", "image/png", "a.png"),
        )?;
        expect_accept(c)
    });
    // accepted, then the sender hangs up: a clean close, not a size error
    assert!(matches!(got, Err(Error::Closed)), "{got:?}");
}

#[test]
fn zero_size_offer_is_rejected() {
    let (got, _) =
        attack(|c| c.send_sealed(frame_type::OFFER, &offer(0, b"", "image/png", "a.png")));
    assert!(matches!(got, Err(Error::Protocol(_))), "{got:?}");
}

#[test]
fn disallowed_mime_is_rejected() {
    for mime in [
        "image/gif",
        "image/svg+xml",
        "application/octet-stream",
        "IMAGE/PNG",
        "image/png; x=1",
        "",
    ] {
        let (got, sent) = attack(|c| {
            c.send_sealed(frame_type::OFFER, &offer(10, b"0123456789", mime, "a.png"))?;
            c.recv_sealed(Duration::from_secs(5)).map(|_| ())
        });
        assert!(
            matches!(got, Err(Error::UnsupportedType)),
            "{mime}: {got:?}"
        );
        assert!(
            matches!(sent, Err(Error::Remote(ErrorCode::UnsupportedType))),
            "{mime}: {sent:?}"
        );
    }
}

#[test]
fn bad_file_names_are_rejected() {
    let long = "x".repeat(129);
    for name in ["", "a\nb.png", "evil\u{202E}gnp.exe", long.as_str()] {
        let (got, _) = attack(|c| {
            c.send_sealed(
                frame_type::OFFER,
                &offer(10, b"0123456789", "image/png", name),
            )
        });
        assert!(matches!(got, Err(Error::Protocol(_))), "{name:?}: {got:?}");
    }
}

#[test]
fn path_tricks_in_names_are_neutralised_not_trusted() {
    let data = png(64);
    let (got, sent) = attack(|c| {
        c.send_sealed(
            frame_type::OFFER,
            &offer(64, &data, "image/png", "..\\..\\Windows\\evil.png"),
        )?;
        expect_accept(c)?;
        c.send_sealed(frame_type::CHUNK, &data)?;
        c.send_sealed(frame_type::DONE, &64u64.to_be_bytes())?;
        c.recv_sealed(Duration::from_secs(5)).map(|_| ())
    });
    sent.unwrap();
    let file = got.unwrap();
    assert_eq!(file.name, "_.._Windows_evil.png");
    assert!(!file.name.contains(['/', '\\', ':']));
}

#[test]
fn right_mime_wrong_magic_bytes_is_rejected() {
    let gif = b"GIF89a-this-is-not-a-png-at-all".to_vec();
    let n = gif.len() as u64;
    let (got, sent) = attack(|c| {
        c.send_sealed(frame_type::OFFER, &offer(n, &gif, "image/png", "a.png"))?;
        expect_accept(c)?;
        c.send_sealed(frame_type::CHUNK, &gif)?;
        c.send_sealed(frame_type::DONE, &n.to_be_bytes())?;
        c.recv_sealed(Duration::from_secs(5)).map(|_| ())
    });
    assert!(matches!(got, Err(Error::BadContent(_))), "{got:?}");
    assert!(
        matches!(sent, Err(Error::Remote(ErrorCode::BadContent))),
        "{sent:?}"
    );
}

#[test]
fn hash_mismatch_is_rejected() {
    let data = png(100);
    let (got, sent) = attack(|c| {
        // promise the hash of different bytes
        c.send_sealed(
            frame_type::OFFER,
            &offer(100, &png(101), "image/png", "a.png"),
        )?;
        expect_accept(c)?;
        c.send_sealed(frame_type::CHUNK, &data)?;
        c.send_sealed(frame_type::DONE, &100u64.to_be_bytes())?;
        c.recv_sealed(Duration::from_secs(5)).map(|_| ())
    });
    assert!(matches!(got, Err(Error::BadContent(_))), "{got:?}");
    assert!(
        matches!(sent, Err(Error::Remote(ErrorCode::BadContent))),
        "{sent:?}"
    );
}

#[test]
fn chunks_must_match_the_declared_layout() {
    // a short first chunk
    let data = png(CHUNK_SIZE + 10);
    let (got, _) = attack(|c| {
        c.send_sealed(
            frame_type::OFFER,
            &offer(data.len() as u64, &data, "image/png", "a.png"),
        )?;
        expect_accept(c)?;
        c.send_sealed(frame_type::CHUNK, &data[..100])
    });
    assert!(matches!(got, Err(Error::Protocol(_))), "{got:?}");

    // a chunk that overshoots the declared size
    let data = png(50);
    let (got, _) = attack(|c| {
        c.send_sealed(frame_type::OFFER, &offer(50, &data, "image/png", "a.png"))?;
        expect_accept(c)?;
        c.send_sealed(frame_type::CHUNK, &png(80))
    });
    assert!(matches!(got, Err(Error::Protocol(_))), "{got:?}");

    // an empty chunk
    let (got, _) = attack(|c| {
        c.send_sealed(frame_type::OFFER, &offer(50, &data, "image/png", "a.png"))?;
        expect_accept(c)?;
        c.send_sealed(frame_type::CHUNK, &[])
    });
    assert!(matches!(got, Err(Error::Protocol(_))), "{got:?}");

    // more data after the last byte instead of DONE
    let (got, _) = attack(|c| {
        c.send_sealed(frame_type::OFFER, &offer(50, &data, "image/png", "a.png"))?;
        expect_accept(c)?;
        c.send_sealed(frame_type::CHUNK, &data)?;
        c.send_sealed(frame_type::CHUNK, &data)
    });
    assert!(matches!(got, Err(Error::Protocol(_))), "{got:?}");

    // DONE announcing a different total
    let (got, _) = attack(|c| {
        c.send_sealed(frame_type::OFFER, &offer(50, &data, "image/png", "a.png"))?;
        expect_accept(c)?;
        c.send_sealed(frame_type::CHUNK, &data)?;
        c.send_sealed(frame_type::DONE, &51u64.to_be_bytes())
    });
    assert!(matches!(got, Err(Error::BadContent(_))), "{got:?}");
}

#[test]
fn sealed_frame_header_over_one_mebibyte_is_refused() {
    let data = png(50);
    let (got, _) = attack(|c| {
        c.send_sealed(frame_type::OFFER, &offer(50, &data, "image/png", "a.png"))?;
        expect_accept(c)?;
        // our own writer refuses to build such a frame, so write the header by hand
        let mut raw = Vec::new();
        raw.extend_from_slice(&((MAX_FRAME as u32) + 1).to_be_bytes());
        raw.push(frame_type::CHUNK);
        std::io::Write::write_all(c.io_mut(), &raw)?;
        Ok(())
    });
    assert!(matches!(got, Err(Error::FrameTooLarge(_))), "{got:?}");
}

#[test]
fn well_formed_script_succeeds_through_the_same_harness() {
    let data = png(CHUNK_SIZE * 2 + 5);
    let (got, sent) = attack(|c| {
        c.send_sealed(
            frame_type::OFFER,
            &offer(data.len() as u64, &data, "image/png", "ok.png"),
        )?;
        expect_accept(c)?;
        for chunk in data.chunks(CHUNK_SIZE) {
            c.send_sealed(frame_type::CHUNK, chunk)?;
        }
        c.send_sealed(frame_type::DONE, &(data.len() as u64).to_be_bytes())?;
        let (ty, body) = c.recv_sealed(Duration::from_secs(5))?;
        assert_eq!((ty, body.len()), (frame_type::DONE, 0));
        Ok(())
    });
    sent.unwrap();
    assert_eq!(got.unwrap().data, data);
}
