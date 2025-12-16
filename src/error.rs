use nostr::EventId;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DagError {
    #[error("event {0} references unknown parent {1}")]
    UnknownParent(EventId, EventId),

    #[error("event already exists: {0}")]
    DuplicateEvent(EventId),
}
