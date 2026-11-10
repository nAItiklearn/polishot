//! Blocking byte-stream abstraction with timeouts, plus an in-memory duplex for tests and embedding.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// A blocking, bidirectional byte stream whose reads can time out.
///
/// The protocol sets a read timeout before every read so that a stalled or slow peer cannot hold a session
/// open (spec section 10).
pub trait Transport: Read + Write {
    /// Set the timeout for the next `read` calls. `None` means block forever.
    fn set_read_timeout(&mut self, dur: Option<Duration>) -> io::Result<()>;
    /// Set the timeout for the next `write` calls.
    fn set_write_timeout(&mut self, dur: Option<Duration>) -> io::Result<()>;
}

impl Transport for TcpStream {
    fn set_read_timeout(&mut self, dur: Option<Duration>) -> io::Result<()> {
        TcpStream::set_read_timeout(self, dur)
    }
    fn set_write_timeout(&mut self, dur: Option<Duration>) -> io::Result<()> {
        TcpStream::set_write_timeout(self, dur)
    }
}

impl<T: Transport + ?Sized> Transport for &mut T {
    fn set_read_timeout(&mut self, dur: Option<Duration>) -> io::Result<()> {
        (**self).set_read_timeout(dur)
    }
    fn set_write_timeout(&mut self, dur: Option<Duration>) -> io::Result<()> {
        (**self).set_write_timeout(dur)
    }
}

impl<T: Transport + ?Sized> Transport for Box<T> {
    fn set_read_timeout(&mut self, dur: Option<Duration>) -> io::Result<()> {
        (**self).set_read_timeout(dur)
    }
    fn set_write_timeout(&mut self, dur: Option<Duration>) -> io::Result<()> {
        (**self).set_write_timeout(dur)
    }
}

#[derive(Default)]
struct PipeState {
    data: VecDeque<u8>,
    /// The writing end was dropped: readers see EOF once the buffer drains.
    writer_gone: bool,
    /// The reading end was dropped: writers see a broken pipe.
    reader_gone: bool,
}

#[derive(Default)]
struct Pipe {
    state: Mutex<PipeState>,
    cv: Condvar,
}

fn lock(p: &Pipe) -> std::sync::MutexGuard<'_, PipeState> {
    p.state.lock().unwrap_or_else(|e| e.into_inner())
}

/// One end of an in-memory duplex connection created by [`duplex`].
pub struct MemoryStream {
    rx: Arc<Pipe>,
    tx: Arc<Pipe>,
    read_timeout: Option<Duration>,
}

/// Create two connected in-memory streams. Dropping one end gives the other EOF on read and `BrokenPipe` on write.
pub fn duplex() -> (MemoryStream, MemoryStream) {
    let a = Arc::new(Pipe::default());
    let b = Arc::new(Pipe::default());
    (
        MemoryStream {
            rx: a.clone(),
            tx: b.clone(),
            read_timeout: None,
        },
        MemoryStream {
            rx: b,
            tx: a,
            read_timeout: None,
        },
    )
}

impl Read for MemoryStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let deadline = self.read_timeout.map(|d| Instant::now() + d);
        let mut st = lock(&self.rx);
        loop {
            if !st.data.is_empty() {
                let n = buf.len().min(st.data.len());
                for slot in buf.iter_mut().take(n) {
                    // the buffer is non-empty for the whole loop, so pop_front always yields
                    *slot = st.data.pop_front().unwrap_or(0);
                }
                return Ok(n);
            }
            if st.writer_gone {
                return Ok(0);
            }
            match deadline {
                None => st = self.rx.cv.wait(st).unwrap_or_else(|e| e.into_inner()),
                Some(dl) => {
                    let now = Instant::now();
                    if now >= dl {
                        return Err(io::Error::new(io::ErrorKind::TimedOut, "read timed out"));
                    }
                    let (g, _) = self
                        .rx
                        .cv
                        .wait_timeout(st, dl - now)
                        .unwrap_or_else(|e| e.into_inner());
                    st = g;
                }
            }
        }
    }
}

impl Write for MemoryStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut st = lock(&self.tx);
        if st.reader_gone {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "peer closed"));
        }
        st.data.extend(buf.iter().copied());
        self.tx.cv.notify_all();
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Transport for MemoryStream {
    fn set_read_timeout(&mut self, dur: Option<Duration>) -> io::Result<()> {
        self.read_timeout = dur;
        Ok(())
    }
    fn set_write_timeout(&mut self, _dur: Option<Duration>) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for MemoryStream {
    fn drop(&mut self) {
        {
            let mut st = lock(&self.tx);
            st.writer_gone = true;
            self.tx.cv.notify_all();
        }
        let mut st = lock(&self.rx);
        st.reader_gone = true;
        self.rx.cv.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplex_moves_bytes_and_signals_close() {
        let (mut a, mut b) = duplex();
        a.write_all(b"hello").unwrap();
        let mut buf = [0u8; 5];
        b.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"hello");
        drop(a);
        assert_eq!(b.read(&mut buf).unwrap(), 0);
        assert_eq!(b.write(b"x").unwrap_err().kind(), io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn read_times_out() {
        let (mut a, _b) = duplex();
        a.set_read_timeout(Some(Duration::from_millis(30))).unwrap();
        let mut buf = [0u8; 1];
        assert_eq!(
            a.read(&mut buf).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }
}
