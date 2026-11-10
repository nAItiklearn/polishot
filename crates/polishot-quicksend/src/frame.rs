//! Frame layer: length-prefixed frames, optional AES-256-GCM sealing, deadlines on every read.

use std::time::{Duration, Instant};

use crate::crypto::Sealer;
use crate::error::{Error, Result};
use crate::proto::{frame_type, Config, ErrorCode, MAX_FRAME, MAX_PLAIN_FRAME, TAG_LEN};
use crate::transport::Transport;

/// A transport plus the record-layer state of one session.
pub(crate) struct Conn<S: Transport> {
    io: S,
    cfg: Config,
    send: Option<Sealer>,
    recv: Option<Sealer>,
}

impl<S: Transport> Conn<S> {
    pub(crate) fn new(mut io: S, cfg: Config) -> Result<Self> {
        io.set_write_timeout(Some(cfg.timeouts.write))?;
        Ok(Conn {
            io,
            cfg,
            send: None,
            recv: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn io_mut(&mut self) -> &mut S {
        &mut self.io
    }

    pub(crate) fn cfg(&self) -> &Config {
        &self.cfg
    }

    /// Switch both directions to AES-256-GCM sealing.
    pub(crate) fn start_encryption(&mut self, send: Sealer, recv: Sealer) {
        self.send = Some(send);
        self.recv = Some(recv);
    }

    pub(crate) fn is_sealed(&self) -> bool {
        self.send.is_some()
    }

    fn write_frame(&mut self, ty: u8, body: &[u8]) -> Result<()> {
        let len = 1 + body.len();
        if len > MAX_FRAME {
            return Err(Error::FrameTooLarge(len));
        }
        let mut buf = Vec::with_capacity(4 + len);
        // len <= MAX_FRAME < 2^32
        buf.extend_from_slice(&(len as u32).to_be_bytes());
        buf.push(ty);
        buf.extend_from_slice(body);
        std::io::Write::write_all(&mut self.io, &buf)?;
        std::io::Write::flush(&mut self.io)?;
        Ok(())
    }

    pub(crate) fn send_plain(&mut self, ty: u8, body: &[u8]) -> Result<()> {
        if 1 + body.len() > MAX_PLAIN_FRAME {
            return Err(Error::FrameTooLarge(1 + body.len()));
        }
        self.write_frame(ty, body)
    }

    pub(crate) fn send_sealed(&mut self, ty: u8, body: &[u8]) -> Result<()> {
        let sealer = self
            .send
            .as_mut()
            .ok_or(Error::Protocol("sealed frame before keys"))?;
        let ct = sealer.seal(ty, body)?;
        self.write_frame(ty, &ct)
    }

    /// Best effort: tell the peer why we are hanging up. Never fails the caller.
    pub(crate) fn send_error(&mut self, code: ErrorCode) {
        let body = code.to_u16().to_be_bytes();
        let _ = if self.is_sealed() {
            self.send_sealed(frame_type::ERROR, &body)
        } else {
            self.send_plain(frame_type::ERROR, &body)
        };
    }

    /// Report a fatal local error to the peer when that is useful.
    pub(crate) fn report(&mut self, e: &Error) {
        match e {
            Error::Closed | Error::Io(_) | Error::Remote(_) | Error::Declined => {}
            other => self.send_error(other.code()),
        }
    }

    fn read_exact_by(&mut self, buf: &mut [u8], deadline: Instant) -> Result<()> {
        let mut filled = 0;
        while filled < buf.len() {
            let now = Instant::now();
            if now >= deadline {
                return Err(Error::Timeout);
            }
            self.io.set_read_timeout(Some(deadline - now))?;
            match std::io::Read::read(&mut self.io, &mut buf[filled..]) {
                Ok(0) => return Err(Error::Closed),
                Ok(n) => filled += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

    /// Read one raw frame, enforcing `max_len` before the body is allocated.
    fn read_frame(&mut self, timeout: Duration, max_len: usize) -> Result<(u8, Vec<u8>)> {
        let deadline = Instant::now() + timeout;
        let mut hdr = [0u8; 4];
        self.read_exact_by(&mut hdr, deadline)?;
        let len = u32::from_be_bytes(hdr) as usize;
        if len == 0 {
            return Err(Error::Protocol("empty frame"));
        }
        if len > max_len {
            return Err(Error::FrameTooLarge(len));
        }
        let mut ty = [0u8; 1];
        self.read_exact_by(&mut ty, deadline)?;
        let mut body = vec![0u8; len - 1];
        self.read_exact_by(&mut body, deadline)?;
        Ok((ty[0], body))
    }

    fn peer_error(body: &[u8]) -> Error {
        match <[u8; 2]>::try_from(body) {
            Ok(b) => Error::Remote(ErrorCode::from_u16(u16::from_be_bytes(b))),
            Err(_) => Error::Protocol("malformed error frame"),
        }
    }

    /// Read a plain (pre-authentication) frame. A peer ERROR becomes `Err(Error::Remote(..))`.
    pub(crate) fn recv_plain(&mut self, timeout: Duration) -> Result<(u8, Vec<u8>)> {
        let (ty, body) = self.read_frame(timeout, MAX_PLAIN_FRAME)?;
        if ty == frame_type::ERROR {
            return Err(Self::peer_error(&body));
        }
        Ok((ty, body))
    }

    /// Read and open a sealed frame. A peer ERROR becomes `Err(Error::Remote(..))`.
    pub(crate) fn recv_sealed(&mut self, timeout: Duration) -> Result<(u8, Vec<u8>)> {
        let (ty, ct) = self.read_frame(timeout, MAX_FRAME)?;
        if ct.len() < TAG_LEN {
            return Err(Error::Crypto);
        }
        let sealer = self
            .recv
            .as_mut()
            .ok_or(Error::Protocol("sealed frame before keys"))?;
        let body = sealer.open(ty, &ct)?;
        if ty == frame_type::ERROR {
            return Err(Self::peer_error(&body));
        }
        Ok((ty, body))
    }
}

/// Bounds-checked reader over a message body. Every accessor fails with a protocol error instead of panicking.
pub(crate) struct Parser<'a> {
    buf: &'a [u8],
}

impl<'a> Parser<'a> {
    pub(crate) fn new(buf: &'a [u8]) -> Self {
        Parser { buf }
    }

    pub(crate) fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.buf.len() < n {
            return Err(Error::Protocol("message too short"));
        }
        let (head, tail) = self.buf.split_at(n);
        self.buf = tail;
        Ok(head)
    }

    pub(crate) fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    pub(crate) fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    pub(crate) fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.array::<8>()?))
    }

    /// `str8`: length byte, then that many UTF-8 bytes, strictly decoded.
    pub(crate) fn str8(&mut self) -> Result<&'a str> {
        let n = usize::from(self.u8()?);
        std::str::from_utf8(self.take(n)?).map_err(|_| Error::Protocol("string is not valid UTF-8"))
    }

    /// Fail if bytes remain.
    pub(crate) fn finish(self) -> Result<()> {
        if self.buf.is_empty() {
            Ok(())
        } else {
            Err(Error::Protocol("trailing bytes in message"))
        }
    }
}

/// Append a `str8` field.
pub(crate) fn put_str8(out: &mut Vec<u8>, s: &str) -> Result<()> {
    let n =
        u8::try_from(s.len()).map_err(|_| Error::InvalidInput("string longer than 255 bytes"))?;
    out.push(n);
    out.extend_from_slice(s.as_bytes());
    Ok(())
}
