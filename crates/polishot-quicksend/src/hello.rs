//! HELLO message and version negotiation (spec sections 6 and 7).

use std::time::Duration;

use crate::crypto::{validate_public, PublicKeyBytes};
use crate::error::{Error, Result};
use crate::frame::{Conn, Parser};
use crate::identity::DeviceId;
use crate::proto::{
    frame_type, INTENT_PAIR, INTENT_TRANSFER, PROTOCOL_MAX, PROTOCOL_MIN, PUBLIC_KEY_LEN,
};
use crate::transport::Transport;

#[derive(Clone, Debug)]
pub(crate) struct Hello {
    pub ver_min: u8,
    pub ver_max: u8,
    pub intent: u8,
    pub id: DeviceId,
    /// Ephemeral key, present exactly when `intent` is transfer.
    pub eph: Option<PublicKeyBytes>,
}

impl Hello {
    /// The initiator's opening HELLO: the full range of versions this build speaks.
    pub(crate) fn request(intent: u8, id: DeviceId, eph: Option<&PublicKeyBytes>) -> Hello {
        Hello {
            ver_min: PROTOCOL_MIN,
            ver_max: PROTOCOL_MAX,
            intent,
            id,
            eph: eph.copied(),
        }
    }

    /// The responder's HELLO: both bounds equal the chosen version.
    pub(crate) fn reply(ver: u8, intent: u8, id: DeviceId, eph: Option<&PublicKeyBytes>) -> Hello {
        Hello {
            ver_min: ver,
            ver_max: ver,
            intent,
            id,
            eph: eph.copied(),
        }
    }

    pub(crate) fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(14 + PUBLIC_KEY_LEN);
        out.push(self.ver_min);
        out.push(self.ver_max);
        out.push(self.intent);
        out.extend_from_slice(self.id.as_bytes());
        match &self.eph {
            Some(e) => {
                out.push(PUBLIC_KEY_LEN as u8);
                out.extend_from_slice(e);
            }
            None => out.push(0),
        }
        out
    }

    pub(crate) fn parse(body: &[u8]) -> Result<Hello> {
        let mut p = Parser::new(body);
        let ver_min = p.u8()?;
        let ver_max = p.u8()?;
        if ver_min > ver_max {
            return Err(Error::Protocol("hello version range is empty"));
        }
        let intent = p.u8()?;
        let id = DeviceId::from_bytes(p.array::<10>()?);
        let eph_len = usize::from(p.u8()?);
        let eph = match (intent, eph_len) {
            (INTENT_PAIR, 0) => None,
            (INTENT_TRANSFER, PUBLIC_KEY_LEN) => Some(validate_public(p.take(eph_len)?)?),
            (INTENT_PAIR | INTENT_TRANSFER, _) => {
                return Err(Error::Protocol(
                    "hello ephemeral key length does not fit the intent",
                ))
            }
            _ => return Err(Error::Protocol("unknown hello intent")),
        };
        p.finish()?;
        Ok(Hello {
            ver_min,
            ver_max,
            intent,
            id,
            eph,
        })
    }
}

/// Read the peer's HELLO.
pub(crate) fn recv_hello<S: Transport>(conn: &mut Conn<S>, timeout: Duration) -> Result<Hello> {
    let (ty, body) = conn.recv_plain(timeout)?;
    if ty != frame_type::HELLO {
        return Err(Error::Protocol("expected hello"));
    }
    Hello::parse(&body)
}

/// Responder side: pick the version for an initiator's HELLO.
pub(crate) fn negotiate(initiator: &Hello) -> Result<u8> {
    let chosen = initiator.ver_max.min(PROTOCOL_MAX);
    if chosen >= initiator.ver_min.max(PROTOCOL_MIN) {
        Ok(chosen)
    } else {
        Err(Error::UnsupportedVersion)
    }
}

/// Initiator side: validate the responder's reply and return the chosen version.
pub(crate) fn check_reply(reply: &Hello, intent: u8) -> Result<u8> {
    if reply.ver_min != reply.ver_max {
        return Err(Error::Protocol("hello reply must name exactly one version"));
    }
    let v = reply.ver_max;
    if !(PROTOCOL_MIN..=PROTOCOL_MAX).contains(&v) {
        return Err(Error::UnsupportedVersion);
    }
    if reply.intent != intent {
        return Err(Error::Protocol("hello reply has a different intent"));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::KeyPair;

    #[test]
    fn encode_parse_round_trip() {
        let k = KeyPair::generate().unwrap();
        let id = DeviceId::from_public(k.public());
        let h = Hello::request(INTENT_TRANSFER, id, Some(k.public()));
        let back = Hello::parse(&h.encode()).unwrap();
        assert_eq!(back.id, id);
        assert_eq!(back.eph.as_ref(), Some(k.public()));
        let h = Hello::request(INTENT_PAIR, id, None);
        assert!(Hello::parse(&h.encode()).unwrap().eph.is_none());
    }

    #[test]
    fn rejects_malformed() {
        let id = DeviceId::from_bytes([1; 10]);
        let mut ok = Hello::request(INTENT_PAIR, id, None).encode();
        assert!(Hello::parse(&ok).is_ok());
        ok.push(0);
        assert!(Hello::parse(&ok).is_err()); // trailing byte
        let mut bad_intent = Hello::request(INTENT_PAIR, id, None).encode();
        bad_intent[2] = 9;
        assert!(Hello::parse(&bad_intent).is_err());
        let mut empty_range = Hello::request(INTENT_PAIR, id, None).encode();
        empty_range[0] = 3;
        assert!(Hello::parse(&empty_range).is_err());
        // transfer without a key
        let mut no_key = Hello::request(INTENT_PAIR, id, None).encode();
        no_key[2] = INTENT_TRANSFER;
        assert!(Hello::parse(&no_key).is_err());
    }

    #[test]
    fn negotiation() {
        let id = DeviceId::from_bytes([1; 10]);
        let mut h = Hello::request(INTENT_PAIR, id, None);
        assert_eq!(negotiate(&h).unwrap(), 1);
        h.ver_min = 2;
        h.ver_max = 5;
        assert!(matches!(negotiate(&h), Err(Error::UnsupportedVersion)));
        h.ver_min = 0;
        h.ver_max = 0;
        assert!(matches!(negotiate(&h), Err(Error::UnsupportedVersion)));
        h.ver_min = 1;
        h.ver_max = 9;
        assert_eq!(negotiate(&h).unwrap(), 1);
    }
}
