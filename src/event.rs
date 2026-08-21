use nostr::{Event, EventBuilder, EventId, Keys, Kind, Tag};

pub const DAG_EVENT_KIND: Kind = Kind::Custom(21000);

pub fn create_ack_event(
    keys: &Keys,
    parents: &[EventId],
) -> Result<Event, nostr::event::builder::Error> {
    let tags: Vec<Tag> = parents.iter().map(|id| Tag::event(*id)).collect();

    EventBuilder::new(DAG_EVENT_KIND, "")
        .tags(tags)
        .sign_with_keys(keys)
}

pub fn parents_of(event: &Event) -> impl Iterator<Item = EventId> + '_ {
    event.tags.event_ids().copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    #[test]
    fn dag_event_kind_is_custom_21000() {
        assert_eq!(DAG_EVENT_KIND, Kind::Custom(21000));
    }

    #[test]
    fn create_ack_event_no_parents() {
        let keys = Keys::generate();
        let event = create_ack_event(&keys, &[]).unwrap();
        assert_eq!(event.kind, DAG_EVENT_KIND);
        assert_eq!(event.pubkey, keys.public_key());
        assert_eq!(parents_of(&event).count(), 0);
    }

    #[test]
    fn create_ack_event_with_parents() {
        let keys = Keys::generate();
        let genesis = create_ack_event(&keys, &[]).unwrap();
        let child = create_ack_event(&keys, &[genesis.id]).unwrap();
        let collected: Vec<EventId> = parents_of(&child).collect();
        assert_eq!(collected, vec![genesis.id]);
    }

    #[test]
    fn create_ack_event_multiple_parents() {
        let keys = Keys::generate();
        let a = create_ack_event(&keys, &[]).unwrap();
        let b = create_ack_event(&keys, &[]).unwrap();
        let merge = create_ack_event(&keys, &[a.id, b.id]).unwrap();
        let parents: Vec<EventId> = parents_of(&merge).collect();
        assert_eq!(parents.len(), 2);
        assert!(parents.contains(&a.id));
        assert!(parents.contains(&b.id));
    }

    #[test]
    fn parents_of_no_event_tags() {
        let keys = Keys::generate();
        let event = create_ack_event(&keys, &[]).unwrap();
        assert_eq!(parents_of(&event).count(), 0);
    }
}
