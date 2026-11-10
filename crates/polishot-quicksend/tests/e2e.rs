//! End-to-end behaviour: pairing, transfer, decline, TCP, listener gating.

mod common;

use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use common::{fake_png, pair_devices};
use polishot_quicksend::{
    duplex, pair_initiator, pair_responder, receive, receive_with, send_file, send_file_with,
    serve, Config, Error, ErrorCode, FileMeta, Identity, Incoming, PairingRateLimiter, ServeConfig,
};

#[test]
fn sas_matches_and_records_agree() {
    let p = pair_devices();
    assert_eq!(p.sas.len(), 6);
    assert!(p.sas.chars().all(|c| c.is_ascii_digit()));
    assert_eq!(p.a_has_b.pair_key, p.b_has_a.pair_key);
    assert_eq!(p.a_has_b.peer_id, p.b.id());
    assert_eq!(p.b_has_a.peer_id, p.a.id());
    assert_eq!(&p.a_has_b.peer_public, p.b.public());
    assert_eq!(p.a_has_b.peer_name, "Phone");
    assert_eq!(p.b_has_a.peer_name, "Studio PC");
}

#[test]
fn pairing_rejected_by_one_user_stores_nothing_on_either_side() {
    let a = Identity::generate();
    let b = Identity::generate();
    let (sa, sb) = duplex();
    thread::scope(|s| {
        let h = s.spawn(|| pair_responder(sb, &b, "Phone").unwrap().confirm(true));
        let pa = pair_initiator(sa, &a, "PC").unwrap();
        assert!(matches!(pa.confirm(false), Err(Error::PairingRejected)));
        assert!(matches!(h.join().unwrap(), Err(Error::PairingRejected)));
    });
}

#[test]
fn transfer_over_memory_duplex_with_progress() {
    let p = pair_devices();
    let data = fake_png(150_000); // three chunks, the last partial
    let (sa, sb) = duplex();
    let mut seen = Vec::new();
    thread::scope(|s| {
        let h = s.spawn(|| {
            send_file(
                sa,
                &p.a,
                &p.a_has_b,
                &FileMeta::new("Screenshot 1.png", "image/png"),
                &data,
            )
            .unwrap();
        });
        let got = receive_with(
            sb,
            &p.b,
            std::slice::from_ref(&p.b_has_a),
            &Config::default(),
            |offer| {
                assert_eq!(offer.size, 150_000);
                assert_eq!(offer.name, "Screenshot 1.png");
                assert_eq!(offer.mime, "image/png");
                assert_eq!(offer.peer_name, "Studio PC");
                true
            },
            &mut |done, total| seen.push((done, total)),
        )
        .unwrap();
        h.join().unwrap();
        assert_eq!(got.data, data);
        assert_eq!(got.peer_id, p.a.id());
        assert_eq!(got.name, "Screenshot 1.png");
    });
    assert_eq!(seen.first(), Some(&(0, 150_000)));
    assert_eq!(seen.last(), Some(&(150_000, 150_000)));
    assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0));
}

#[test]
fn sender_progress_reports_every_chunk() {
    let p = pair_devices();
    let data = fake_png(70_000);
    let (sa, sb) = duplex();
    let mut sent = Vec::new();
    thread::scope(|s| {
        let h = s.spawn(|| receive(sb, &p.b, std::slice::from_ref(&p.b_has_a), |_| true));
        send_file_with(
            sa,
            &p.a,
            &p.a_has_b,
            &FileMeta::new("a.png", "image/png"),
            &data,
            &Config::default(),
            &mut |d, t| sent.push((d, t)),
        )
        .unwrap();
        assert_eq!(h.join().unwrap().unwrap().data, data);
    });
    assert_eq!(sent, vec![(0, 70_000), (65_536, 70_000), (70_000, 70_000)]);
}

#[test]
fn declined_offer_reaches_the_sender() {
    let p = pair_devices();
    let data = fake_png(1000);
    let (sa, sb) = duplex();
    thread::scope(|s| {
        let h = s.spawn(|| receive(sb, &p.b, std::slice::from_ref(&p.b_has_a), |_| false));
        let r = send_file(
            sa,
            &p.a,
            &p.a_has_b,
            &FileMeta::new("a.png", "image/png"),
            &data,
        );
        assert!(matches!(r, Err(Error::Declined)), "{r:?}");
        assert!(matches!(h.join().unwrap(), Err(Error::Declined)));
    });
}

#[test]
fn unpaired_sender_is_refused() {
    let p = pair_devices();
    let stranger = Identity::generate();
    let data = fake_png(500);
    // the stranger holds a forged record for b
    let forged = polishot_quicksend::PairRecord::new(p.b.public(), [5u8; 32], "Phone").unwrap();
    let (sa, sb) = duplex();
    thread::scope(|s| {
        let h = s.spawn(|| receive(sb, &p.b, std::slice::from_ref(&p.b_has_a), |_| true));
        let r = send_file(
            sa,
            &stranger,
            &forged,
            &FileMeta::new("a.png", "image/png"),
            &data,
        );
        assert!(
            matches!(r, Err(Error::Remote(ErrorCode::Unpaired))),
            "{r:?}"
        );
        assert!(matches!(h.join().unwrap(), Err(Error::Unpaired)));
    });
}

#[test]
fn wrong_pair_key_fails_authentication_on_both_ends() {
    let p = pair_devices();
    let mut bad = p.a_has_b.clone();
    bad.pair_key[0] ^= 0x01;
    let data = fake_png(500);
    let (sa, sb) = duplex();
    thread::scope(|s| {
        let h = s.spawn(|| receive(sb, &p.b, std::slice::from_ref(&p.b_has_a), |_| true));
        let r = send_file(sa, &p.a, &bad, &FileMeta::new("a.png", "image/png"), &data);
        assert!(
            matches!(r, Err(Error::Remote(ErrorCode::AuthFailed))),
            "{r:?}"
        );
        assert!(matches!(h.join().unwrap(), Err(Error::AuthFailed)));
    });
}

#[test]
fn sender_validates_before_connecting() {
    let p = pair_devices();
    let png = fake_png(100);
    let meta = FileMeta::new("a.png", "image/png");
    let try_send = |meta: &FileMeta, data: &[u8]| {
        let (sa, _sb) = duplex();
        send_file(sa, &p.a, &p.a_has_b, meta, data)
    };
    assert!(matches!(
        try_send(&FileMeta::new("a.gif", "image/gif"), &png),
        Err(Error::UnsupportedType)
    ));
    assert!(matches!(
        try_send(&FileMeta::new("a.jpg", "image/jpeg"), &png),
        Err(Error::BadContent(_))
    ));
    assert!(matches!(try_send(&meta, b""), Err(Error::InvalidInput(_))));
    let huge = vec![0u8; 50 * 1024 * 1024 + 1];
    assert!(matches!(try_send(&meta, &huge), Err(Error::TooLarge)));
}

#[test]
fn silent_peer_times_out() {
    let id = Identity::generate();
    let (_keep_open, sb) = duplex();
    let mut cfg = Config::default();
    cfg.timeouts.handshake = Duration::from_millis(150);
    let r = receive_with(sb, &id, &[], &cfg, |_| true, &mut |_, _| {});
    assert!(matches!(r, Err(Error::Timeout)), "{r:?}");
}

#[test]
fn tcp_pairing_then_transfer_through_serve() {
    let server_id = Identity::generate();
    let client_id = Identity::generate();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let limiter = PairingRateLimiter::default();

    let data = fake_png(300_000);
    thread::scope(|s| {
        let server = s.spawn(|| {
            // 1st connection: pairing
            let (conn, _) = listener.accept().unwrap();
            let sc = ServeConfig {
                identity: &server_id,
                local_name: "Studio PC",
                pairs: &[],
                allow_pairing: true,
                rate_limiter: Some(&limiter),
                config: Config::default(),
            };
            let record = match serve(conn, &sc, |_| false).unwrap() {
                Incoming::Pairing(p) => {
                    let sas = p.sas().to_string();
                    (p.confirm(true).unwrap(), sas)
                }
                Incoming::Received(_) => panic!("expected pairing"),
            };
            // 2nd connection: transfer from the now-paired client
            let (conn, _) = listener.accept().unwrap();
            let pairs = [record.0.clone()];
            let sc = ServeConfig {
                identity: &server_id,
                local_name: "Studio PC",
                pairs: &pairs,
                allow_pairing: false,
                rate_limiter: Some(&limiter),
                config: Config::default(),
            };
            let file = match serve(conn, &sc, |o| o.mime == "image/png").unwrap() {
                Incoming::Received(f) => f,
                Incoming::Pairing(_) => panic!("expected a file"),
            };
            (record.1, file)
        });

        let stream = TcpStream::connect(addr).unwrap();
        let pending = pair_initiator(stream, &client_id, "Pixel").unwrap();
        let client_sas = pending.sas().to_string();
        let client_record = pending.confirm(true).unwrap();
        assert_eq!(client_record.peer_id, server_id.id());

        let stream = TcpStream::connect(addr).unwrap();
        send_file(
            stream,
            &client_id,
            &client_record,
            &FileMeta::new("tcp.png", "image/png"),
            &data,
        )
        .unwrap();

        let (server_sas, file) = server.join().unwrap();
        assert_eq!(server_sas, client_sas);
        assert_eq!(file.data, data);
        assert_eq!(file.peer_id, client_id.id());
        assert_eq!(file.name, "tcp.png");
    });
}

#[test]
fn serve_refuses_pairing_when_disabled_and_after_five_attempts() {
    let id = Identity::generate();
    let peer = Identity::generate();

    // disabled
    let (sa, sb) = duplex();
    thread::scope(|s| {
        let h = s.spawn(|| {
            let sc = ServeConfig {
                identity: &id,
                local_name: "PC",
                pairs: &[],
                allow_pairing: false,
                rate_limiter: None,
                config: Config::default(),
            };
            serve(sb, &sc, |_| true).map(|_| ())
        });
        let r = pair_initiator(sa, &peer, "Phone");
        assert!(
            matches!(r, Err(Error::Remote(ErrorCode::PairingDisabled))),
            "{r:?}"
        );
        assert!(matches!(h.join().unwrap(), Err(Error::PairingDisabled)));
    });

    // rate limited: the 6th attempt inside the window is refused
    let limiter = PairingRateLimiter::default();
    for attempt in 0..6 {
        let (sa, sb) = duplex();
        thread::scope(|s| {
            let h = s.spawn(|| {
                let sc = ServeConfig {
                    identity: &id,
                    local_name: "PC",
                    pairs: &[],
                    allow_pairing: true,
                    rate_limiter: Some(&limiter),
                    config: Config::default(),
                };
                serve(sb, &sc, |_| true).map(|inc| match inc {
                    Incoming::Pairing(p) => {
                        let _ = p.confirm(false);
                    }
                    Incoming::Received(_) => {}
                })
            });
            let r = pair_initiator(sa, &peer, "Phone");
            if attempt < 5 {
                let p = r.unwrap_or_else(|e| panic!("attempt {attempt}: {e}"));
                let _ = p.confirm(false);
                h.join().unwrap().unwrap();
            } else {
                assert!(
                    matches!(r, Err(Error::Remote(ErrorCode::RateLimited))),
                    "{r:?}"
                );
                assert!(matches!(h.join().unwrap(), Err(Error::RateLimited)));
            }
        });
    }
}

#[test]
fn pair_record_survives_storage_and_still_authenticates() {
    let p = pair_devices();
    let restored_a = polishot_quicksend::PairRecord::from_bytes(&p.a_has_b.to_bytes()).unwrap();
    let restored_b = polishot_quicksend::PairRecord::from_bytes(&p.b_has_a.to_bytes()).unwrap();
    let a2 = Identity::from_bytes(&p.a.to_bytes()[..]).unwrap();
    let data = fake_png(2000);
    let (sa, sb) = duplex();
    thread::scope(|s| {
        let h = s.spawn(|| receive(sb, &p.b, std::slice::from_ref(&restored_b), |_| true));
        send_file(
            sa,
            &a2,
            &restored_a,
            &FileMeta::new("x.png", "image/png"),
            &data,
        )
        .unwrap();
        assert_eq!(h.join().unwrap().unwrap().data, data);
    });
}
