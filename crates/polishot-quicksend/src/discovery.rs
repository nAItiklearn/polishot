//! mDNS / DNS-SD advertise and browse (spec section 4). Compiled only with the `discovery` feature.
//!
//! Everything learned here is an untrusted hint. Pairing and transfer authenticate with keys, never with
//! what an advertisement claims.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

use crate::content::validate_device_name;
use crate::error::{Error, Result};
use crate::identity::DeviceId;
use crate::proto::{PROTOCOL_MAX, SERVICE_TYPE};

fn derr(e: mdns_sd::Error) -> Error {
    Error::Discovery(e.to_string())
}

/// TXT records for an advertisement: `v`, `id`, `name`.
pub fn txt_properties(id: &DeviceId, name: &str) -> Result<HashMap<String, String>> {
    validate_device_name(name)?;
    let mut m = HashMap::new();
    m.insert("v".to_string(), PROTOCOL_MAX.to_string());
    m.insert("id".to_string(), id.to_string());
    m.insert("name".to_string(), name.to_string());
    Ok(m)
}

/// Parse and validate TXT records. Returns `(id, name, version)`; anything malformed is rejected.
pub fn parse_txt(get: impl Fn(&str) -> Option<String>) -> Result<(DeviceId, String, u8)> {
    let v = get("v").ok_or(Error::Protocol("advertisement has no version"))?;
    let version: u8 = v
        .trim()
        .parse()
        .map_err(|_| Error::Protocol("advertisement version is not a number"))?;
    let id: DeviceId = get("id")
        .ok_or(Error::Protocol("advertisement has no id"))?
        .parse()?;
    let name = get("name").ok_or(Error::Protocol("advertisement has no name"))?;
    validate_device_name(&name)?;
    Ok((id, name, version))
}

/// A device seen on the network.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Peer {
    /// Advertised device id (a hint; verified by keys during pairing/transfer).
    pub id: DeviceId,
    /// Advertised name (untrusted; prefer the pair record's name).
    pub name: String,
    /// Advertised highest protocol version.
    pub version: u8,
    /// TCP port.
    pub port: u16,
    /// Addresses, IPv4 first.
    pub addrs: Vec<IpAddr>,
}

impl Peer {
    /// Addresses ready for `TcpStream::connect_timeout`.
    pub fn socket_addrs(&self) -> Vec<SocketAddr> {
        self.addrs
            .iter()
            .map(|a| SocketAddr::new(*a, self.port))
            .collect()
    }
}

/// Browse results.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeerEvent {
    /// A device appeared or its record changed.
    Found(Peer),
    /// A device went away.
    Lost(DeviceId),
}

/// Keeps a service registered while alive; dropping it unregisters and stops the daemon.
pub struct Advertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Advertiser {
    /// Advertise this device on `port` (the port your listener actually bound).
    pub fn start(id: &DeviceId, name: &str, port: u16) -> Result<Advertiser> {
        let props = txt_properties(id, name)?;
        let instance = id.to_string();
        let host = format!("{instance}.local.");
        let info = ServiceInfo::new(SERVICE_TYPE, &instance, &host, (), port, props)
            .map_err(derr)?
            .enable_addr_auto();
        let fullname = info.get_fullname().to_string();
        let daemon = ServiceDaemon::new().map_err(derr)?;
        daemon.register(info).map_err(derr)?;
        Ok(Advertiser { daemon, fullname })
    }
}

impl Drop for Advertiser {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

/// Browses for peers; dropping it stops the search.
pub struct Browser {
    daemon: ServiceDaemon,
    rx: mdns_sd::Receiver<ServiceEvent>,
    own: DeviceId,
}

impl Browser {
    /// Start browsing, ignoring the device `own`.
    pub fn start(own: DeviceId) -> Result<Browser> {
        let daemon = ServiceDaemon::new().map_err(derr)?;
        let rx = daemon.browse(SERVICE_TYPE).map_err(derr)?;
        Ok(Browser { daemon, rx, own })
    }

    /// Wait up to `timeout` for the next peer event; `Ok(None)` means nothing happened in time.
    /// Records that fail validation are skipped silently.
    pub fn next_event(&self, timeout: Duration) -> Result<Option<PeerEvent>> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let ev = match self.rx.recv_timeout(left) {
                Ok(ev) => ev,
                Err(mdns_sd::RecvTimeoutError::Timeout) => return Ok(None),
                Err(mdns_sd::RecvTimeoutError::Disconnected) => {
                    return Err(Error::Discovery("browser stopped".to_string()))
                }
            };
            match ev {
                ServiceEvent::ServiceResolved(svc) => {
                    let parsed = parse_txt(|k| svc.get_property_val_str(k).map(str::to_string));
                    let Ok((id, name, version)) = parsed else {
                        continue;
                    };
                    if id == self.own {
                        continue;
                    }
                    let mut addrs: Vec<IpAddr> =
                        svc.get_addresses().iter().map(|a| a.to_ip_addr()).collect();
                    addrs.sort_by_key(|a| (a.is_ipv6(), *a));
                    if addrs.is_empty() || svc.get_port() == 0 {
                        continue;
                    }
                    return Ok(Some(PeerEvent::Found(Peer {
                        id,
                        name,
                        version,
                        port: svc.get_port(),
                        addrs,
                    })));
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    let instance = fullname.split('.').next().unwrap_or("");
                    if let Ok(id) = instance.parse::<DeviceId>() {
                        if id != self.own {
                            return Ok(Some(PeerEvent::Lost(id)));
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.daemon.stop_browse(SERVICE_TYPE);
        let _ = self.daemon.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_round_trip() {
        let id = DeviceId::from_bytes([7; 10]);
        let m = txt_properties(&id, "Studio PC").unwrap();
        assert_eq!(m["v"], "1");
        let (pid, name, v) = parse_txt(|k| m.get(k).cloned()).unwrap();
        assert_eq!((pid, name.as_str(), v), (id, "Studio PC", 1));
        assert!(txt_properties(&id, &"x".repeat(33)).is_err());
    }

    #[test]
    fn txt_rejects_garbage() {
        let get = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(a, _)| *a == k)
                    .map(|(_, b)| b.to_string())
            }
        };
        assert!(parse_txt(get(&[("id", "MZXW6YTBOJRGC6TR"), ("name", "A")])).is_err()); // no v
        assert!(parse_txt(get(&[
            ("v", "x"),
            ("id", "MZXW6YTBOJRGC6TR"),
            ("name", "A")
        ]))
        .is_err());
        assert!(parse_txt(get(&[("v", "1"), ("id", "short"), ("name", "A")])).is_err());
        assert!(parse_txt(get(&[("v", "1"), ("id", "MZXW6YTBOJRGC6TR"), ("name", "")])).is_err());
        assert!(parse_txt(get(&[
            ("v", "1"),
            ("id", "MZXW6YTBOJRGC6TR"),
            ("name", "A\u{202E}B")
        ]))
        .is_err());
        assert!(parse_txt(get(&[
            ("v", "1"),
            ("id", "MZXW6YTBOJRGC6TR"),
            ("name", "A")
        ]))
        .is_ok());
    }

    /// Needs a multicast-capable network; run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn advertise_and_browse_on_this_machine() {
        let a = DeviceId::from_bytes([1; 10]);
        let b = DeviceId::from_bytes([2; 10]);
        let _adv = Advertiser::start(&a, "Loopback test", 40123).unwrap();
        let browser = Browser::start(b).unwrap();
        let end = std::time::Instant::now() + Duration::from_secs(15);
        while std::time::Instant::now() < end {
            if let Some(PeerEvent::Found(p)) = browser.next_event(Duration::from_secs(1)).unwrap() {
                assert_eq!(p.id, a);
                assert_eq!(p.port, 40123);
                return;
            }
        }
        panic!("peer not discovered");
    }
}
