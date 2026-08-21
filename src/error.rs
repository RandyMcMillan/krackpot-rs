use nostr::EventId;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DagError {
    #[error("event {0} references unknown parent {1}")]
    UnknownParent(EventId, EventId),

    #[error("event already exists: {0}")]
    DuplicateEvent(EventId),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_parent_display() {
        let id = EventId::all_zeros();
        let parent = EventId::all_zeros();
        let err = DagError::UnknownParent(id, parent);
        let msg = err.to_string();
        assert!(msg.contains("references unknown parent"));
    }

    #[test]
    fn duplicate_event_display() {
        let id = EventId::all_zeros();
        let err = DagError::DuplicateEvent(id);
        let msg = err.to_string();
        assert!(msg.contains("event already exists"));
    }
}
