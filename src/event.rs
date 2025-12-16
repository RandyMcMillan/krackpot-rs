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
