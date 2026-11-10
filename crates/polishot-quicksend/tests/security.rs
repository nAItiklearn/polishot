//! Active-attacker behaviour: tampering, replay, reordering, oversize frames, MITM during pairing.

mod common;

use std::io::{Read, Write};
use std::thread;

use common::{fake_png, pair_devices, relay, Dir, Paired, BODY};
use polishot_quicksend::{
    duplex, pair_initiator, pair_responder, receive, send_file, Error, ErrorCode, FileMeta,
    Identity,
};

/// Run one transfer through the relay and return (sender result, receiver result).
fn transfer_through(
    p: &Paired,
    data: &[u8],
    mutate: impl FnMut(Dir, usize, Vec<u8>) -> Vec<Vec<u8>> + Send,
) -> (
    Result<(), Error>,
    Result<polishot_quicksend::ReceivedFile, Error>,
) {
    let (client, relay_c) = duplex();
    let (relay_s, server) = duplex();
    thread::scope(|s| {
        s.spawn(move || relay(relay_c, relay_s, mutate));
        let rx = s.spawn(|| receive(server, &p.b, std::slice::from_ref(&p.b_has_a), |_| true));
        let tx = send_file(
            client,
            &p.a,
            &p.a_has_b,
            &FileMeta::new("a.png", "image/png"),
            data,
        );
        (tx, rx.join().unwrap())
    })
}

// to-server frame indices: 0 HELLO, 1 AUTH, 2 OFFER, 3.. CHUNK, last DONE
const FIRST_CHUNK: usize = 3;

#[test]
fn relay_that_changes_nothing_is_transparent() {
    let p = pair_devices();
    let data = fake_png(150_000);
    let (tx, rx) = transfer_through(&p, &data, |_, _, f| vec![f]);
    tx.unwrap();
    assert_eq!(rx.unwrap().data, data);
}

#[test]
fn tampered_chunk_is_rejected() {
    let p = pair_devices();
    let data = fake_png(150_000);
    let (tx, rx) = transfer_through(&p, &data, |dir, i, mut f| {
        if dir == Dir::ToServer && i == FIRST_CHUNK {
            f[BODY + 10] ^= 0x01;
        }
        vec![f]
    });
    assert!(matches!(rx, Err(Error::Crypto)), "{rx:?}");
    assert!(
        matches!(tx, Err(Error::Remote(ErrorCode::Protocol))),
        "{tx:?}"
    );
}

#[test]
fn tampered_frame_type_is_rejected() {
    let p = pair_devices();
    let data = fake_png(150_000);
    // change the type byte of a chunk to DONE: the type is authenticated data
    let (_, rx) = transfer_through(&p, &data, |dir, i, mut f| {
        if dir == Dir::ToServer && i == FIRST_CHUNK {
            f[4] = polishot_quicksend::frame_type::DONE;
        }
        vec![f]
    });
    assert!(matches!(rx, Err(Error::Crypto)), "{rx:?}");
}

#[test]
fn replayed_chunk_is_rejected() {
    let p = pair_devices();
    let data = fake_png(150_000);
    let (tx, rx) = transfer_through(&p, &data, |dir, i, f| {
        if dir == Dir::ToServer && i == FIRST_CHUNK {
            vec![f.clone(), f]
        } else {
            vec![f]
        }
    });
    assert!(matches!(rx, Err(Error::Crypto)), "{rx:?}");
    assert!(tx.is_err());
}

#[test]
fn reordered_chunks_are_rejected() {
    let p = pair_devices();
    let data = fake_png(150_000);
    let mut held: Option<Vec<u8>> = None;
    let (tx, rx) = transfer_through(&p, &data, move |dir, i, f| {
        if dir != Dir::ToServer {
            return vec![f];
        }
        if i == FIRST_CHUNK {
            held = Some(f);
            vec![]
        } else if i == FIRST_CHUNK + 1 {
            let first = held.take().unwrap();
            vec![f, first]
        } else {
            vec![f]
        }
    });
    assert!(matches!(rx, Err(Error::Crypto)), "{rx:?}");
    assert!(tx.is_err());
}

#[test]
fn dropped_chunk_is_rejected() {
    let p = pair_devices();
    let data = fake_png(150_000);
    let (tx, rx) = transfer_through(&p, &data, |dir, i, f| {
        if dir == Dir::ToServer && i == FIRST_CHUNK {
            vec![]
        } else {
            vec![f]
        }
    });
    assert!(matches!(rx, Err(Error::Crypto)), "{rx:?}");
    assert!(tx.is_err());
}

#[test]
fn replaying_a_frame_from_an_old_session_is_rejected() {
    // Session 1 is recorded; its chunk is injected into session 2 at the same position.
    let p = pair_devices();
    let data = fake_png(70_000);
    let mut recorded: Option<Vec<u8>> = None;
    let (tx, _) = transfer_through(&p, &data, |dir, i, f| {
        if dir == Dir::ToServer && i == FIRST_CHUNK {
            recorded = Some(f.clone());
        }
        vec![f]
    });
    tx.unwrap();
    let old = recorded.expect("a chunk was recorded");
    let (_, rx) = transfer_through(&p, &data, move |dir, i, f| {
        if dir == Dir::ToServer && i == FIRST_CHUNK {
            vec![old.clone()]
        } else {
            vec![f]
        }
    });
    assert!(matches!(rx, Err(Error::Crypto)), "{rx:?}");
}

#[test]
fn tampered_auth_mac_is_rejected() {
    let p = pair_devices();
    let data = fake_png(1000);
    let (tx, rx) = transfer_through(&p, &data, |dir, i, mut f| {
        if dir == Dir::ToServer && i == 1 {
            f[BODY] ^= 0x80;
        }
        vec![f]
    });
    assert!(matches!(rx, Err(Error::AuthFailed)), "{rx:?}");
    assert!(
        matches!(tx, Err(Error::Remote(ErrorCode::AuthFailed))),
        "{tx:?}"
    );
}

#[test]
fn oversized_frames_are_rejected_before_allocation() {
    let p = pair_devices();
    // before authentication: anything over 1024 bytes
    let (mut client, server) = duplex();
    client.write_all(&2000u32.to_be_bytes()).unwrap();
    client.write_all(&[1]).unwrap(); // HELLO type; the body never has to arrive
    let r = receive(server, &p.b, std::slice::from_ref(&p.b_has_a), |_| true);
    assert!(matches!(r, Err(Error::FrameTooLarge(2000))), "{r:?}");
    let mut err = [0u8; 4 + 1 + 2];
    client.read_exact(&mut err).unwrap();
    assert_eq!(err[4], polishot_quicksend::frame_type::ERROR);

    // an absurd length
    let (mut client, server) = duplex();
    client.write_all(&u32::MAX.to_be_bytes()).unwrap();
    let r = receive(server, &p.b, std::slice::from_ref(&p.b_has_a), |_| true);
    assert!(matches!(r, Err(Error::FrameTooLarge(_))), "{r:?}");
    // a zero-length frame
    let (mut client, server) = duplex();
    client.write_all(&0u32.to_be_bytes()).unwrap();
    let r = receive(server, &p.b, std::slice::from_ref(&p.b_has_a), |_| true);
    assert!(matches!(r, Err(Error::Protocol(_))), "{r:?}");
}

#[test]
fn truncated_stream_is_a_clean_error() {
    let p = pair_devices();
    let (mut client, server) = duplex();
    client.write_all(&20u32.to_be_bytes()).unwrap();
    client.write_all(&[1, 1, 1]).unwrap();
    drop(client);
    let r = receive(server, &p.b, std::slice::from_ref(&p.b_has_a), |_| true);
    assert!(matches!(r, Err(Error::Closed)), "{r:?}");
}

#[test]
fn unknown_version_range_is_refused_with_a_clean_code() {
    let responder = Identity::generate();
    let (mut client, server) = duplex();
    // HELLO: ver 2..3, intent pair, id, no ephemeral key
    let mut body = vec![2u8, 3, 1];
    body.extend_from_slice(&[9u8; 10]);
    body.push(0);
    client
        .write_all(&((1 + body.len()) as u32).to_be_bytes())
        .unwrap();
    client.write_all(&[1]).unwrap();
    client.write_all(&body).unwrap();
    let r = pair_responder(server, &responder, "PC");
    assert!(matches!(r, Err(Error::UnsupportedVersion)), "{r:?}");
    let mut resp = [0u8; 4 + 1 + 2];
    client.read_exact(&mut resp).unwrap();
    assert_eq!(&resp[..4], &3u32.to_be_bytes());
    assert_eq!(resp[4], polishot_quicksend::frame_type::ERROR);
    assert_eq!(
        u16::from_be_bytes([resp[5], resp[6]]),
        ErrorCode::UnsupportedVersion.to_u16()
    );
}

// ---- pairing under a man in the middle ----------------------------------------------------------------------

/// Mallory terminates both connections with real endpoints of her own and relays the user-visible result.
#[test]
fn sas_differs_when_a_man_in_the_middle_substitutes_keys() {
    let alice = Identity::generate();
    let bob = Identity::generate();
    let mallory = Identity::generate();
    let (a_wire, m_toward_a) = duplex(); // Alice <-> Mallory
    let (m_toward_b, b_wire) = duplex(); // Mallory <-> Bob

    let (sas_alice, sas_bob, sas_m_a, sas_m_b) = thread::scope(|s| {
        // Bob is the responder, Mallory initiates toward him
        let bob_t = s.spawn(|| {
            let p = pair_responder(b_wire, &bob, "Bob").unwrap();
            let sas = p.sas().to_string();
            let _ = p.confirm(false);
            sas
        });
        // Mallory answers Alice as a responder and connects to Bob as an initiator
        let mal_t = s.spawn(|| {
            let to_alice = pair_responder(m_toward_a, &mallory, "Bob").unwrap();
            let to_bob = pair_initiator(m_toward_b, &mallory, "Alice").unwrap();
            let r = (to_alice.sas().to_string(), to_bob.sas().to_string());
            let _ = to_alice.confirm(false);
            let _ = to_bob.confirm(false);
            r
        });
        let pa = pair_initiator(a_wire, &alice, "Alice").unwrap();
        let sas_alice = pa.sas().to_string();
        let _ = pa.confirm(false);
        let sas_bob = bob_t.join().unwrap();
        let (m_a, m_b) = mal_t.join().unwrap();
        (sas_alice, sas_bob, m_a, m_b)
    });
    // each leg is internally consistent...
    assert_eq!(sas_alice, sas_m_a);
    assert_eq!(sas_bob, sas_m_b);
    // ...but the two humans see different codes (1 in 10^6 flake chance, accepted)
    assert_ne!(sas_alice, sas_bob);
}

#[test]
fn a_substituted_responder_key_is_caught_by_the_device_id_check() {
    let alice = Identity::generate();
    let bob = Identity::generate();
    let mallory = Identity::generate();
    let (client, relay_c) = duplex();
    let (relay_s, server) = duplex();
    let mallory_pub = *mallory.public();
    let r = thread::scope(|s| {
        s.spawn(move || {
            relay(relay_c, relay_s, move |dir, i, mut f| {
                // PAIR_RESPONSE is the 2nd frame toward the client: swap in Mallory's long-term key
                if dir == Dir::ToClient && i == 1 {
                    f[BODY..BODY + 65].copy_from_slice(&mallory_pub);
                }
                vec![f]
            })
        });
        s.spawn(|| {
            let _ = pair_responder(server, &bob, "Bob");
        });
        pair_initiator(client, &alice, "Alice")
    });
    assert!(matches!(r, Err(Error::Protocol(_))), "{r:?}");
}

#[test]
fn reveal_that_does_not_open_the_commitment_is_rejected() {
    let alice = Identity::generate();
    let bob = Identity::generate();
    let other_eph = Identity::generate(); // any valid P-256 point works as a substitute ephemeral key
    let swap = *other_eph.public();
    let (client, relay_c) = duplex();
    let (relay_s, server) = duplex();
    let (init, resp) = thread::scope(|s| {
        s.spawn(move || {
            relay(relay_c, relay_s, move |dir, i, mut f| {
                // PAIR_REVEAL is the 3rd frame toward the server
                if dir == Dir::ToServer && i == 2 {
                    f[BODY..BODY + 65].copy_from_slice(&swap);
                }
                vec![f]
            })
        });
        let h = s.spawn(|| pair_responder(server, &bob, "Bob").map(|_| ()));
        let init = pair_initiator(client, &alice, "Alice").map(|p| p.sas().to_string());
        (init, h.join().unwrap())
    });
    assert!(matches!(resp, Err(Error::BadCommitment)), "{resp:?}");
    let _ = init;
}

#[test]
fn pairing_with_yourself_is_refused() {
    let me = Identity::generate();
    let (a, b) = duplex();
    let r = thread::scope(|s| {
        let h = s.spawn(|| pair_responder(b, &me, "PC").map(|_| ()));
        let r = pair_initiator(a, &me, "PC").map(|_| ());
        (r, h.join().unwrap())
    });
    assert!(r.0.is_err());
    assert!(matches!(r.1, Err(Error::SelfPairing)), "{:?}", r.1);
}
