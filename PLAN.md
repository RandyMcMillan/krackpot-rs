# Optimistic DAG Consensus

## Overview

A DAG-based consensus mechanism where application events become canonical once acknowledged by a majority of participants. This provides eventual consistency without requiring BFT consensus, relying instead on optimistic convergence.

## Core Concepts

### Events

Each event in the DAG contains:
- **Parents**: References to previous DAG tips (zero or more)
- **Author**: The participant who created the event
- **Content**: Optional application-specific payload (an "action")

Events with no content serve as pure acknowledgments ("I've seen these previous events").

### DAG Structure

```
     [A]         <- genesis (no parents)
      |
     [B]         <- single parent
    /   \
  [C]   [D]      <- concurrent events
    \   /
     [E]         <- merges two branches (multiple parents)
```

Each event references the current "tips" of the DAG as seen by its author. This creates a causal ordering where an event transitively includes all its ancestors.

### Participants

A fixed, known set of participants. Each participant:
- Can author events
- Is identified by a public key
- Has equal weight in determining canonicality

### Canonicality

An event becomes **canonical** when it has been transitively acknowledged by a majority of participants. Specifically:

An event E is canonical when:
```
|{ p ∈ participants : p has authored an event that includes E as an ancestor }| > n/2
```

This means if there are 3 participants, an event is canonical once 2 of them have (directly or transitively) acknowledged it.

### Canonical State

The **canonical state** is derived from applying all canonical events that contain actions, in canonical order.

## Canonical Ordering

The DAG defines a partial order (ancestors before descendants). We need a deterministic rule to derive a total order for concurrent events.

### Requirements

1. **Consistency**: All participants must derive the same total order
2. **Topological**: Parents always come before children
3. **Deterministic**: No randomness or external input

### Approach: Topological Sort with Hash Tiebreaker

1. Assign each event a **depth** = max(parent depths) + 1 (genesis has depth 0)
2. Events are ordered by depth (lower first)
3. Events at the same depth are ordered by their hash (lexicographically)

This gives a total order that respects causality and is deterministic.

### Alternative: Lamport-like Timestamps

Each event carries a logical timestamp:
- `timestamp = max(parent timestamps) + 1`
- Ties broken by hash

Equivalent to depth-based approach but more explicit.

## State Computation

Given the canonical ordering, state is computed by:

1. Filter canonical events to those with action content
2. Sort by canonical order
3. Apply actions sequentially to initial state

```
state_0 = initial_state
for event in canonical_events_with_actions().sorted_by_canonical_order():
    state = apply_action(state, event.action)
```

### State Identity

The state can be identified by a hash:
- Option A: Hash of the canonical event sequence (hashes of events in order)
- Option B: Hash of the resulting state after applying actions
- Option C: Hash of the "frontier" - the set of canonical tips

Option A is simplest and directly verifiable from the DAG.

## Optimistic Convergence

Without BFT consensus, participants may temporarily see different views:

1. **Lagging**: A participant hasn't received recent events yet
2. **Concurrent branches**: Multiple participants publish before seeing each other

The system handles this optimistically:
- Participants publish events referencing their current view
- Events propagate and eventually all participants see them
- Once majority acknowledges, events become canonical
- All participants converge to the same canonical state

### Fork Handling

True forks (conflicting actions) are prevented by:
1. Actions being additive/monotonic where possible
2. Application-level rules that reject invalid state transitions
3. Canonical ordering ensuring deterministic conflict resolution

## Event Maturity

An event "matures" (becomes canonical) when a majority of participants have acknowledged it. The key question is: how do we efficiently track who has seen what?

### Seen-By Tracking

For each event E, we define `seen_by(E)` as the set of participants who have transitively acknowledged E:

```
seen_by(E) = {E.author} ∪ ⋃{ seen_by(F) : F is a child of E }
```

Equivalently (working forward from E's perspective):
```
seen_by(E) = { P : ∃ event F authored by P where E is an ancestor of F }
```

An event E is **canonical** when `|seen_by(E)| > n/2`.

### Computing Seen-By

When a new event F arrives with author P:
1. F.author = P, so F is seen by P
2. All ancestors of F are now also seen by P (if they weren't already)

We can compute `seen_by` for each event:
- **Eager**: When event F arrives, walk all ancestors and add P to their seen_by sets
- **Lazy**: Compute seen_by on demand by walking descendants

Eager is O(ancestors) per insertion but O(1) for canonicality checks.
Lazy is O(1) insertion but O(descendants) for canonicality checks.

**Recommended**: Eager with caching. Track `seen_by: BTreeSet<PublicKey>` per event. When inserting F:
```rust
fn insert(&mut self, event: nostr::Event, action: Option<A>) -> EventId {
    let id = event.id;
    let author = event.author();
    self.events.insert(id, event);
    if let Some(a) = action {
        self.actions.insert(id, a);
    }

    // Propagate seen_by to all ancestors
    self.mark_seen_by_ancestors(id, author);

    id
}

fn mark_seen_by_ancestors(&mut self, id: EventId, participant: PublicKey) {
    let mut stack = vec![id];
    while let Some(current) = stack.pop() {
        if self.seen_by.entry(current).or_default().insert(participant) {
            // Newly seen - propagate to parents
            if let Some(event) = self.events.get(&current) {
                stack.extend(self.parents_of(event));
            }
        }
        // Already seen by this participant - ancestors must be too, stop
    }
}

fn parents_of(&self, event: &nostr::Event) -> impl Iterator<Item = EventId> + '_ {
    event.tags.iter().filter_map(|tag| tag.as_event().map(|(id, _, _)| id))
}
```

The early termination (`if insert returns false, stop`) makes this efficient in practice - we only visit the "frontier" of unseen events.

### Canonical Ordering

Once we know which events are canonical, we derive a total order:

1. **Depth**: Each event has depth = max(parent depths) + 1. Genesis events (no parents) have depth 0.

2. **Sort**: Canonical events sorted by `(depth, event_id)`

This ensures:
- Topological order (parents before children) since parents have lower depth
- Deterministic tiebreaker for concurrent events via hash

```rust
fn canonical_order(&self) -> Vec<EventId> {
    let mut canonical: Vec<_> = self.events.keys()
        .filter(|id| self.is_canonical(*id))
        .copied()
        .collect();

    canonical.sort_by_key(|id| (self.depth(*id), *id));
    canonical
}

fn depth(&self, id: EventId) -> u64 {
    // Could cache this
    let event = &self.events[&id];
    self.parents_of(event)
        .map(|p| self.depth(p))
        .max()
        .map(|d| d + 1)
        .unwrap_or(0)
}
```

### Incremental Updates

When the canonical set changes (new event causes ancestors to mature):
1. Find newly canonical events
2. Insert them into the canonical order at correct positions
3. Apply their actions (if any) to derive new state

The canonical order only grows - once canonical, always canonical.

## Data Structures

```rust
use nostr::{EventId, PublicKey, Event};

/// The DAG structure tracking events and their canonicality
///
/// Uses nostr types directly:
/// - `EventId` - content-addressed event identifier (SHA256)
/// - `PublicKey` - participant identifier (Nostr pubkey)
/// - `Event` - the full signed Nostr event
pub struct Dag<A> {
    events: HashMap<EventId, Event>,
    actions: HashMap<EventId, A>,  // parsed actions, if any
    seen_by: HashMap<EventId, BTreeSet<PublicKey>>,
    participants: BTreeSet<PublicKey>,
    threshold: usize,  // > threshold means canonical (typically n/2)
}

impl<A> Dag<A> {
    pub fn is_canonical(&self, id: EventId) -> bool {
        self.seen_by.get(&id).map(|s| s.len() > self.threshold).unwrap_or(false)
    }

    pub fn canonical_order(&self) -> Vec<EventId>;

    pub fn insert(&mut self, event: Event<A>) -> EventId;

    pub fn tips(&self) -> impl Iterator<Item = EventId>;
}
```

## Nostr Embedding

The DAG maps naturally onto Nostr events using the [rust-nostr](https://github.com/rust-nostr/nostr) library.

### Mapping

| DAG Concept | Nostr Equivalent |
|-------------|------------------|
| `EventId` | Nostr event `id` (SHA256 hash) |
| `Event.author` | Nostr `pubkey` |
| `Event.parents` | `e` tags (one per parent) |
| `Event.action` | `content` field (JSON/bincode serialized, empty for acks) |

### Event Structure

```json
{
  "id": "<sha256 of serialized event>",
  "pubkey": "<participant's public key>",
  "created_at": 1234567890,
  "kind": 21000,  // custom kind for DAG events (ephemeral range or regular)
  "tags": [
    ["e", "<parent-event-id-1>"],
    ["e", "<parent-event-id-2>"],
    ["p", "<participant-pubkey-1>"],  // optional: tag participants for discoverability
    ["p", "<participant-pubkey-2>"]
  ],
  "content": "{\"action\": ...}",  // or "" for pure ack
  "sig": "<signature>"
}
```

### Key Points

1. **Event ID**: Nostr computes `id = SHA256(serialized_event)` which includes pubkey, created_at, kind, tags, content. This replaces our `EventId::of()` - we just use Nostr's ID directly.

2. **Parents via `e` tags**: The `e` tag is standard for referencing other events: `["e", "<event-id>"]`. Multiple `e` tags = multiple parents.

3. **Event Kind**: Use a custom kind in the regular range (1000-9999) so relays store them. Could also use addressable range (30000-39999) if we want replaceable semantics.

4. **Content**: Serialize the `Option<A>` action. Empty string or `null` for pure acknowledgment events.

5. **Discoverability**: Add `p` tags for all participants so they can subscribe to events mentioning them.

### Rust Types (using rust-nostr)

```rust
use nostr::{EventBuilder, EventId, Kind, Tag, Keys};

const DAG_EVENT_KIND: Kind = Kind::Custom(21000);

fn create_dag_event<A: Serialize>(
    keys: &Keys,
    parents: &[EventId],
    action: Option<&A>,
) -> Event {
    let mut tags: Vec<Tag> = parents.iter()
        .map(|id| Tag::event(*id))
        .collect();

    let content = match action {
        Some(a) => serde_json::to_string(a).unwrap(),
        None => String::new(),
    };

    EventBuilder::new(DAG_EVENT_KIND, content)
        .tags(tags)
        .sign_with_keys(keys)
        .unwrap()
}

fn parse_dag_event<A: DeserializeOwned>(event: &Event) -> (Vec<EventId>, Option<A>) {
    let parents: Vec<EventId> = event.tags.iter()
        .filter_map(|tag| {
            if tag.kind() == TagKind::e {
                tag.content().and_then(|s| EventId::from_hex(s).ok())
            } else {
                None
            }
        })
        .collect();

    let action = if event.content.is_empty() {
        None
    } else {
        serde_json::from_str(&event.content).ok()
    };

    (parents, action)
}
```

### Subscribing to DAG Events

Participants subscribe to events with:
```rust
Filter::new()
    .kind(DAG_EVENT_KIND)
    .authors(participants.clone())  // events authored by participants
    // or
    .pubkeys(participants.clone())  // events mentioning participants via p-tag
```

## Equivocation

Equivocation occurs when a participant publishes conflicting events - e.g., two events with the same parents but different content, or events on divergent branches that don't reference each other.

### Approach: Tolerate It

We don't attempt to detect or punish equivocation. Instead:

1. **Both events exist in the DAG** - all valid Nostr events from participants are included
2. **Canonical ordering is deterministic** - sorted by `(depth, event_id)`, so everyone agrees on order
3. **Application layer validates** - state transitions must be valid; conflicting actions get rejected

This is robust because:
- Hard to distinguish malice from network issues (participant may not have received their own event back from relay)
- The system is safe regardless - invalid state transitions are rejected
- No complex equivocation detection or slashing needed

### Example

Participant P publishes events A and B with the same parents:
```
     [X]
    /   \
  [A]   [B]   <- both from P, same parent
```

Both A and B enter the DAG. Canonical order might be `[..., A, B]` (by hash). If A and B contain conflicting actions, the application applies A first, then rejects B as invalid for the resulting state.

### Future Consideration

If equivocation becomes a problem, we could add:
- Sequence numbers per author (event N must reference event N-1)
- Equivocation proofs that exclude a participant from the consensus
- Reputation/staking mechanisms

For now, the simple approach suffices.

## Open Questions

1. **Participant set changes**: How to handle adding/removing participants?
2. **Garbage collection**: Can old canonical events be pruned?
3. **Consistency proofs**: How to efficiently prove two participants have same state?
4. **Liveness**: What if a participant goes offline permanently?
5. **Event kind**: Should we register a NIP for this, or use an unregistered kind?
