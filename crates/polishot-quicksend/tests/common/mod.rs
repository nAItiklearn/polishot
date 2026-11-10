//! Shared helpers for the integration tests: pairing fixtures, test images, and a frame-level relay that
//! plays an on-path attacker (drop, duplicate, reorder, modify frames).
#![allow(dead_code)]

use std::io::{Read, Write};
use std::thread;
use std::time::Duration;

use polishot_quicksend::{
    duplex, pair_initiator, pair_responder, Identity, MemoryStream, PairRecord, Transport,
};

pub const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// A deterministic fake PNG of `len` bytes (valid magic, arbitrary body).
pub fn fake_png(len: usize) -> Vec<u8> {
    let mut v = PNG_MAGIC.to_vec();
    let mut x: u32 = 0x1234_5678;
    while v.len() < len {
        x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        v.push((x >> 24) as u8);
    }
    v.truncate(len);
    v
}

pub struct Paired {
    pub a: Identity,
    pub b: Identity,
    /// What `a` stored about `b`.
    pub a_has_b: PairRecord,
    /// What `b` stored about `a`.
    pub b_has_a: PairRecord,
    pub sas: String,
}

/// Run a real pairing between two fresh identities over an in-memory duplex.
pub fn pair_devices() -> Paired {
    let a = Identity::generate();
    let b = Identity::generate();
    let (sa, sb) = duplex();
    let (a_has_b, b_has_a, sas) = thread::scope(|s| {
        let h = s.spawn(|| {
            let p = pair_responder(sb, &b, "Phone").unwrap();
            let sas = p.sas().to_string();
            (p.confirm(true).unwrap(), sas)
        });
        let pa = pair_initiator(sa, &a, "Studio PC").unwrap();
        let sas_a = pa.sas().to_string();
        let rec_a = pa.confirm(true).unwrap();
        let (rec_b, sas_b) = h.join().unwrap();
        assert_eq!(sas_a, sas_b);
        (rec_a, rec_b, sas_a)
    });
    Paired {
        a,
        b,
        a_has_b,
        b_has_a,
        sas,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    /// From the connecting side to the listening side.
    ToServer,
    ToClient,
}

/// Forward whole frames between `client` and `server`, letting `mutate` rewrite each one.
///
/// `mutate(direction, index_within_direction, frame_bytes)` returns the frames to deliver instead (empty
/// drops, two copies replay, ...). Returns when either side hangs up and everything pending is delivered.
pub fn relay(
    mut client: MemoryStream,
    mut server: MemoryStream,
    mut mutate: impl FnMut(Dir, usize, Vec<u8>) -> Vec<Vec<u8>>,
) {
    let mut buf_c: Vec<u8> = Vec::new();
    let mut buf_s: Vec<u8> = Vec::new();
    let mut idx_c = 0usize;
    let mut idx_s = 0usize;
    let mut closed = false;
    let mut idle = 0u32;
    client
        .set_read_timeout(Some(Duration::from_millis(2)))
        .unwrap();
    server
        .set_read_timeout(Some(Duration::from_millis(2)))
        .unwrap();
    while !closed && idle < 5000 {
        let mut progressed = false;
        for src_is_client in [true, false] {
            let mut tmp = [0u8; 4096];
            let res = if src_is_client {
                client.read(&mut tmp)
            } else {
                server.read(&mut tmp)
            };
            match res {
                Ok(0) => closed = true,
                Ok(n) => {
                    progressed = true;
                    if src_is_client {
                        buf_c.extend_from_slice(&tmp[..n]);
                    } else {
                        buf_s.extend_from_slice(&tmp[..n]);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => closed = true,
            }
            let (buf, idx, dir) = if src_is_client {
                (&mut buf_c, &mut idx_c, Dir::ToServer)
            } else {
                (&mut buf_s, &mut idx_s, Dir::ToClient)
            };
            while buf.len() >= 4 {
                let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
                if buf.len() < 4 + len {
                    break;
                }
                let frame: Vec<u8> = buf.drain(..4 + len).collect();
                progressed = true;
                for out in mutate(dir, *idx, frame) {
                    let dest: &mut MemoryStream = if src_is_client {
                        &mut server
                    } else {
                        &mut client
                    };
                    let _ = dest.write_all(&out);
                }
                *idx += 1;
            }
        }
        if progressed {
            idle = 0;
        } else {
            idle += 1;
        }
    }
}

/// Offset of the first body byte in a raw frame (`len(4) || type(1)`).
pub const BODY: usize = 5;
