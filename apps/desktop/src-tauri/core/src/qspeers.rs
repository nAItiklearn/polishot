//! Who is on the network: merges discovery events and the paired list into the device list the UI
//! shows.

use std::collections::HashMap;
use std::net::SocketAddr;

use polishot_quicksend::discovery::{Peer, PeerEvent};
use polishot_quicksend::{DeviceId, PairRecord};
use serde::Serialize;

/// One row in the device list. `id` is the device id text (16 base32 characters).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub id: String,
    pub name: String,
    pub paired: bool,
    /// Currently visible on the local network.
    pub online: bool,
}

/// Most devices remembered at once. Anyone on the network can announce as many fake devices as
/// they like; past this many, new ones are ignored (known ones still update) so the table, the
/// device list and its events stay small.
pub const MAX_PEERS: usize = 256;

#[derive(Default)]
pub struct PeerTable {
    peers: HashMap<DeviceId, Peer>,
}

impl PeerTable {
    /// Apply a discovery event; returns true if the table changed.
    pub fn apply(&mut self, ev: PeerEvent) -> bool {
        match ev {
            PeerEvent::Found(p) => {
                if !self.peers.contains_key(&p.id) && self.peers.len() >= MAX_PEERS {
                    return false;
                }
                self.peers.insert(p.id, p.clone()).as_ref() != Some(&p)
            }
            PeerEvent::Lost(id) => self.peers.remove(&id).is_some(),
        }
    }

    /// Addresses to try for `id`, if it is online.
    pub fn addrs(&self, id: &DeviceId) -> Option<Vec<SocketAddr>> {
        self.peers
            .get(id)
            .map(Peer::socket_addrs)
            .filter(|a| !a.is_empty())
    }

    pub fn peer(&self, id: &DeviceId) -> Option<&Peer> {
        self.peers.get(id)
    }

    /// Paired devices first (names from the pair record, which is trusted), then unpaired devices
    /// that are visible; each group sorted by name.
    pub fn devices(&self, pairs: &[PairRecord]) -> Vec<DeviceEntry> {
        let mut paired: Vec<DeviceEntry> = pairs
            .iter()
            .map(|r| DeviceEntry {
                id: r.peer_id.to_string(),
                name: r.peer_name.clone(),
                paired: true,
                online: self.peers.contains_key(&r.peer_id),
            })
            .collect();
        let mut nearby: Vec<DeviceEntry> = self
            .peers
            .values()
            .filter(|p| !pairs.iter().any(|r| r.peer_id == p.id))
            .map(|p| DeviceEntry {
                id: p.id.to_string(),
                name: p.name.clone(),
                paired: false,
                online: true,
            })
            .collect();
        paired.sort_by(|a, b| a.name.cmp(&b.name));
        nearby.sort_by(|a, b| a.name.cmp(&b.name));
        paired.extend(nearby);
        paired
    }
}

/// Find a device id (text form) among the known paired records and visible peers.
pub fn find_device_id(text: &str, pairs: &[PairRecord], table: &PeerTable) -> Option<DeviceId> {
    pairs
        .iter()
        .map(|r| r.peer_id)
        .chain(table.peers.keys().copied())
        .find(|id| id.to_string() == text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use polishot_quicksend::Identity;
    use std::net::{IpAddr, Ipv4Addr};

    fn peer(id: DeviceId, name: &str, port: u16) -> Peer {
        Peer {
            id,
            name: name.to_string(),
            version: 1,
            port,
            addrs: vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))],
        }
    }

    fn record(name: &str) -> PairRecord {
        let id = Identity::generate();
        PairRecord::new(id.public(), [9; 32], name).unwrap()
    }

    #[test]
    fn events_update_the_table() {
        let mut t = PeerTable::default();
        let id = Identity::generate().id();
        assert!(t.apply(PeerEvent::Found(peer(id, "Pixel", 4000))));
        assert!(
            !t.apply(PeerEvent::Found(peer(id, "Pixel", 4000))),
            "no change"
        );
        assert!(
            t.apply(PeerEvent::Found(peer(id, "Pixel", 4001))),
            "port changed"
        );
        assert_eq!(t.addrs(&id).unwrap()[0].port(), 4001);
        assert!(t.apply(PeerEvent::Lost(id)));
        assert!(!t.apply(PeerEvent::Lost(id)));
        assert!(t.addrs(&id).is_none());
    }

    #[test]
    fn device_list_merges_pairs_and_nearby_peers() {
        let mut t = PeerTable::default();
        let pixel = record("Pixel");
        let galaxy = record("Galaxy");
        let stranger = Identity::generate().id();
        t.apply(PeerEvent::Found(peer(pixel.peer_id, "Spoofed name", 1)));
        t.apply(PeerEvent::Found(peer(stranger, "Guest phone", 2)));
        let list = t.devices(&[pixel.clone(), galaxy.clone()]);
        assert_eq!(list.len(), 3);
        // Paired first, sorted: Galaxy (offline), Pixel (online, trusted name); then the stranger.
        assert_eq!(list[0].name, "Galaxy");
        assert!(list[0].paired && !list[0].online);
        assert_eq!(
            list[1].name, "Pixel",
            "the pair record's name wins over the advertised one"
        );
        assert!(list[1].paired && list[1].online);
        assert_eq!(list[2].name, "Guest phone");
        assert!(!list[2].paired && list[2].online);
        assert_eq!(list[1].id, pixel.peer_id.to_string());
    }

    #[test]
    fn ids_are_found_by_their_text_form() {
        let mut t = PeerTable::default();
        let paired = record("A");
        let nearby = Identity::generate().id();
        t.apply(PeerEvent::Found(peer(nearby, "B", 1)));
        let pairs = [paired.clone()];
        assert_eq!(
            find_device_id(&paired.peer_id.to_string(), &pairs, &t),
            Some(paired.peer_id)
        );
        assert_eq!(
            find_device_id(&nearby.to_string(), &pairs, &t),
            Some(nearby)
        );
        assert_eq!(find_device_id("AAAAAAAAAAAAAAAA", &pairs, &t), None);
        assert_eq!(find_device_id("", &pairs, &t), None);
    }

    #[test]
    fn a_flood_of_announcements_cannot_grow_the_table_without_bound() {
        let mut t = PeerTable::default();
        for i in 0..(MAX_PEERS + 50) {
            let id = Identity::generate().id();
            let changed = t.apply(PeerEvent::Found(peer(id, "Flood", 1000 + i as u16)));
            assert_eq!(changed, i < MAX_PEERS, "peer {i}");
        }
        assert_eq!(t.devices(&[]).len(), MAX_PEERS);
        // A device that is already known still updates, and can still leave.
        let known = *t.peers.keys().next().unwrap();
        assert!(t.apply(PeerEvent::Found(peer(known, "Renamed", 9))));
        assert!(t.apply(PeerEvent::Lost(known)));
        let fresh = Identity::generate().id();
        assert!(
            t.apply(PeerEvent::Found(peer(fresh, "Newcomer", 1))),
            "a freed slot is usable again"
        );
    }

    #[test]
    fn peers_without_addresses_are_not_dialable() {
        let mut t = PeerTable::default();
        let id = Identity::generate().id();
        let mut p = peer(id, "X", 1);
        p.addrs.clear();
        t.apply(PeerEvent::Found(p));
        assert!(t.addrs(&id).is_none());
    }
}
