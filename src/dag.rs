use std::collections::{BTreeSet, HashMap, HashSet};

use nostr::{Event, EventId, PublicKey};

use crate::event::parents_of;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InsertResult {
    Inserted(EventId),
    Buffered {
        event_id: EventId,
        missing: Vec<EventId>,
    },
    Duplicate,
}

pub struct Dag {
    events: HashMap<EventId, Event>,
    seen_by: HashMap<EventId, BTreeSet<PublicKey>>,
    participants: BTreeSet<PublicKey>,
    threshold: usize,
    depth_cache: HashMap<EventId, u64>,
    children: HashMap<EventId, BTreeSet<EventId>>,
    pending: HashMap<EventId, Event>,
    waiting_for: HashMap<EventId, HashSet<EventId>>,
}

impl Dag {
    pub fn new(participants: impl IntoIterator<Item = PublicKey>) -> Self {
        let participants: BTreeSet<PublicKey> = participants.into_iter().collect();
        let threshold = participants.len() / 2;

        Self {
            events: HashMap::new(),
            seen_by: HashMap::new(),
            participants,
            threshold,
            depth_cache: HashMap::new(),
            children: HashMap::new(),
            pending: HashMap::new(),
            waiting_for: HashMap::new(),
        }
    }

    pub fn insert(&mut self, event: Event) -> InsertResult {
        let id = event.id;

        if self.events.contains_key(&id) || self.pending.contains_key(&id) {
            return InsertResult::Duplicate;
        }

        let missing: Vec<EventId> = parents_of(&event)
            .filter(|parent_id| !self.events.contains_key(parent_id))
            .collect();

        if missing.is_empty() {
            self.insert_ready(event);
            self.process_unblocked(id);
            InsertResult::Inserted(id)
        } else {
            for parent_id in &missing {
                self.waiting_for.entry(*parent_id).or_default().insert(id);
            }
            self.pending.insert(id, event);
            InsertResult::Buffered {
                event_id: id,
                missing,
            }
        }
    }

    fn insert_ready(&mut self, event: Event) {
        let id = event.id;
        let author = event.pubkey;

        for parent_id in parents_of(&event) {
            self.children.entry(parent_id).or_default().insert(id);
        }

        let depth = self.compute_depth(&event);
        self.depth_cache.insert(id, depth);

        self.events.insert(id, event);
        self.seen_by.entry(id).or_default();

        if self.participants.contains(&author) {
            self.mark_seen_by_ancestors(id, author);
        }
    }

    fn process_unblocked(&mut self, inserted_id: EventId) {
        let Some(waiting) = self.waiting_for.remove(&inserted_id) else {
            return;
        };

        let mut to_process: Vec<EventId> = waiting.into_iter().collect();

        while let Some(candidate_id) = to_process.pop() {
            let Some(event) = self.pending.get(&candidate_id) else {
                continue;
            };

            let still_missing: Vec<EventId> = parents_of(event)
                .filter(|p| !self.events.contains_key(p))
                .collect();

            if still_missing.is_empty() {
                let event = self.pending.remove(&candidate_id).unwrap();
                self.insert_ready(event);

                if let Some(newly_unblocked) = self.waiting_for.remove(&candidate_id) {
                    to_process.extend(newly_unblocked);
                }
            }
        }
    }

    fn mark_seen_by_ancestors(&mut self, id: EventId, participant: PublicKey) {
        let mut stack = vec![id];
        while let Some(current) = stack.pop() {
            if self.seen_by.entry(current).or_default().insert(participant) {
                if let Some(event) = self.events.get(&current) {
                    stack.extend(parents_of(event));
                }
            }
        }
    }

    fn compute_depth(&self, event: &Event) -> u64 {
        parents_of(event)
            .filter_map(|p| self.depth_cache.get(&p))
            .max()
            .map(|d| d + 1)
            .unwrap_or(0)
    }

    pub fn depth(&self, id: EventId) -> Option<u64> {
        self.depth_cache.get(&id).copied()
    }

    pub fn is_canonical(&self, id: EventId) -> bool {
        self.seen_by
            .get(&id)
            .map(|s| s.len() > self.threshold)
            .unwrap_or(false)
    }

    pub fn tips(&self) -> impl Iterator<Item = EventId> + '_ {
        self.events.keys().copied().filter(|id| {
            self.children
                .get(id)
                .map(|c| c.is_empty())
                .unwrap_or(true)
        })
    }

    pub fn canonical_order(&self) -> Vec<EventId> {
        let mut canonical: Vec<EventId> = self
            .events
            .keys()
            .copied()
            .filter(|id| self.is_canonical(*id))
            .collect();

        canonical.sort_by_key(|id| {
            let depth = self.depth(*id).unwrap_or(0);
            (depth, *id)
        });

        canonical
    }

    pub fn get(&self, id: &EventId) -> Option<&Event> {
        self.events.get(id)
    }

    pub fn participants(&self) -> &BTreeSet<PublicKey> {
        &self.participants
    }

    pub fn seen_by(&self, id: EventId) -> Option<&BTreeSet<PublicKey>> {
        self.seen_by.get(&id)
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn missing_parents(&self) -> impl Iterator<Item = EventId> + '_ {
        self.waiting_for.keys().copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::create_ack_event;
    use nostr::Keys;

    fn unwrap_inserted(result: InsertResult) -> EventId {
        match result {
            InsertResult::Inserted(id) => id,
            other => panic!("expected Inserted, got {:?}", other),
        }
    }

    #[test]
    fn single_participant_genesis_is_canonical() {
        let keys = Keys::generate();
        let mut dag = Dag::new([keys.public_key()]);

        let event = create_ack_event(&keys, &[]).unwrap();
        let id = unwrap_inserted(dag.insert(event));

        assert!(dag.is_canonical(id));
        assert_eq!(dag.depth(id), Some(0));
        assert_eq!(dag.tips().collect::<Vec<_>>(), vec![id]);
    }

    #[test]
    fn two_participants_need_both_for_canonical() {
        let alice = Keys::generate();
        let bob = Keys::generate();
        let mut dag = Dag::new([alice.public_key(), bob.public_key()]);

        let genesis = create_ack_event(&alice, &[]).unwrap();
        let genesis_id = unwrap_inserted(dag.insert(genesis));

        assert!(!dag.is_canonical(genesis_id));

        let ack = create_ack_event(&bob, &[genesis_id]).unwrap();
        let ack_id = unwrap_inserted(dag.insert(ack));

        assert!(dag.is_canonical(genesis_id));
        assert!(!dag.is_canonical(ack_id));

        let ack2 = create_ack_event(&alice, &[ack_id]).unwrap();
        unwrap_inserted(dag.insert(ack2));

        assert!(dag.is_canonical(ack_id));
    }

    #[test]
    fn three_participants_need_two_for_canonical() {
        let alice = Keys::generate();
        let bob = Keys::generate();
        let carol = Keys::generate();
        let mut dag = Dag::new([alice.public_key(), bob.public_key(), carol.public_key()]);

        let genesis = create_ack_event(&alice, &[]).unwrap();
        let genesis_id = unwrap_inserted(dag.insert(genesis));

        assert!(!dag.is_canonical(genesis_id));

        let ack = create_ack_event(&bob, &[genesis_id]).unwrap();
        unwrap_inserted(dag.insert(ack));

        assert!(dag.is_canonical(genesis_id));
    }

    #[test]
    fn depth_increases_through_chain() {
        let keys = Keys::generate();
        let mut dag = Dag::new([keys.public_key()]);

        let e0 = create_ack_event(&keys, &[]).unwrap();
        let id0 = unwrap_inserted(dag.insert(e0));
        assert_eq!(dag.depth(id0), Some(0));

        let e1 = create_ack_event(&keys, &[id0]).unwrap();
        let id1 = unwrap_inserted(dag.insert(e1));
        assert_eq!(dag.depth(id1), Some(1));

        let e2 = create_ack_event(&keys, &[id1]).unwrap();
        let id2 = unwrap_inserted(dag.insert(e2));
        assert_eq!(dag.depth(id2), Some(2));
    }

    #[test]
    fn tips_updated_correctly() {
        let keys = Keys::generate();
        let mut dag = Dag::new([keys.public_key()]);

        let e0 = create_ack_event(&keys, &[]).unwrap();
        let id0 = unwrap_inserted(dag.insert(e0));

        assert_eq!(dag.tips().collect::<Vec<_>>(), vec![id0]);

        let e1 = create_ack_event(&keys, &[id0]).unwrap();
        let id1 = unwrap_inserted(dag.insert(e1));

        assert_eq!(dag.tips().collect::<Vec<_>>(), vec![id1]);
    }

    #[test]
    fn canonical_order_is_deterministic() {
        let alice = Keys::generate();
        let bob = Keys::generate();
        let mut dag = Dag::new([alice.public_key(), bob.public_key()]);

        let genesis = create_ack_event(&alice, &[]).unwrap();
        let genesis_id = unwrap_inserted(dag.insert(genesis));

        let a1 = create_ack_event(&alice, &[genesis_id]).unwrap();
        let a1_id = unwrap_inserted(dag.insert(a1));

        let b1 = create_ack_event(&bob, &[genesis_id]).unwrap();
        let b1_id = unwrap_inserted(dag.insert(b1));

        let merge = create_ack_event(&alice, &[a1_id, b1_id]).unwrap();
        let merge_id = unwrap_inserted(dag.insert(merge));

        let final_ack = create_ack_event(&bob, &[merge_id]).unwrap();
        unwrap_inserted(dag.insert(final_ack));

        let order = dag.canonical_order();

        assert_eq!(order.len(), 4);
        assert_eq!(order[0], genesis_id);

        let concurrent = &order[1..3];
        assert!(concurrent.contains(&a1_id));
        assert!(concurrent.contains(&b1_id));

        let expected_second = if a1_id < b1_id { a1_id } else { b1_id };
        assert_eq!(order[1], expected_second);

        assert_eq!(order[3], merge_id);
    }

    #[test]
    fn buffers_unknown_parent() {
        let keys = Keys::generate();
        let mut dag = Dag::new([keys.public_key()]);

        let fake_parent = EventId::all_zeros();
        let event = create_ack_event(&keys, &[fake_parent]).unwrap();
        let event_id = event.id;

        let result = dag.insert(event);
        assert!(matches!(
            result,
            InsertResult::Buffered { event_id: id, missing } if id == event_id && missing == vec![fake_parent]
        ));
        assert_eq!(dag.pending_count(), 1);
        assert_eq!(dag.missing_parents().collect::<Vec<_>>(), vec![fake_parent]);
    }

    #[test]
    fn rejects_duplicate_event() {
        let keys = Keys::generate();
        let mut dag = Dag::new([keys.public_key()]);

        let event = create_ack_event(&keys, &[]).unwrap();
        unwrap_inserted(dag.insert(event.clone()));

        let result = dag.insert(event);
        assert!(matches!(result, InsertResult::Duplicate));
    }

    #[test]
    fn processes_buffered_when_parent_arrives() {
        let keys = Keys::generate();
        let mut dag = Dag::new([keys.public_key()]);

        let e0 = create_ack_event(&keys, &[]).unwrap();
        let id0 = e0.id;

        let e1 = create_ack_event(&keys, &[id0]).unwrap();
        let id1 = e1.id;

        let e2 = create_ack_event(&keys, &[id1]).unwrap();
        let id2 = e2.id;

        assert!(matches!(dag.insert(e2), InsertResult::Buffered { .. }));
        assert!(matches!(dag.insert(e1), InsertResult::Buffered { .. }));
        assert_eq!(dag.pending_count(), 2);

        unwrap_inserted(dag.insert(e0));

        assert_eq!(dag.pending_count(), 0);
        assert_eq!(dag.len(), 3);
        assert!(dag.is_canonical(id0));
        assert!(dag.is_canonical(id1));
        assert!(dag.is_canonical(id2));
    }

    #[test]
    fn non_participant_event_not_canonical_until_acked() {
        let federation = Keys::generate();
        let user = Keys::generate();
        let mut dag = Dag::new([federation.public_key()]);

        let user_msg = create_ack_event(&user, &[]).unwrap();
        let msg_id = unwrap_inserted(dag.insert(user_msg));

        assert!(!dag.is_canonical(msg_id));
        assert_eq!(dag.seen_by(msg_id), Some(&BTreeSet::new()));

        let ack = create_ack_event(&federation, &[msg_id]).unwrap();
        unwrap_inserted(dag.insert(ack));

        assert!(dag.is_canonical(msg_id));
    }
}
