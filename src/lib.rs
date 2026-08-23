mod dag;
mod error;
mod event;
mod assets;

pub use assets::{ICON_CIRCLE_BITCOIN_SVG, ICON_CIRCLE_WHITE_SVG};
pub use assets::FAVICON_ICO;
pub use dag::{Dag, InsertResult};
pub use error::DagError;
pub use event::{create_ack_event, parents_of, DAG_EVENT_KIND};

#[cfg(feature = "wasm")]
mod wasm {
    use wasm_bindgen::prelude::*;

    use crate::dag::{Dag, InsertResult};

    #[wasm_bindgen]
    pub struct WasmDag {
        inner: Dag,
    }

    #[wasm_bindgen]
    impl WasmDag {
        /// Create a new DAG with the given participant public keys (hex strings).
        #[wasm_bindgen(constructor)]
        pub fn new(pubkeys_json: &str) -> Result<WasmDag, JsValue> {
            let hex_keys: Vec<String> = serde_json::from_str(pubkeys_json)
                .map_err(|e| JsValue::from_str(&e.to_string()))?;

            let participants: Result<Vec<nostr::PublicKey>, _> = hex_keys
                .iter()
                .map(|h| nostr::PublicKey::from_hex(h))
                .collect();
            let participants =
                participants.map_err(|e: nostr::key::Error| JsValue::from_str(&e.to_string()))?;

            Ok(WasmDag {
                inner: Dag::new(participants),
            })
        }

        /// Insert a JSON-serialised Nostr event.
        /// Returns a JSON string with the result: `{"type":"Inserted","id":"..."}`,
        /// `{"type":"Buffered","id":"...","missing":[...]}`, or `{"type":"Duplicate"}`.
        pub fn insert(&mut self, event_json: &str) -> Result<String, JsValue> {
            let event: nostr::Event = serde_json::from_str(event_json)
                .map_err(|e| JsValue::from_str(&e.to_string()))?;

            let result = self.inner.insert(event);
            let json = match result {
                InsertResult::Inserted(id) => {
                    format!(r#"{{"type":"Inserted","id":"{}"}}"#, id.to_hex())
                }
                InsertResult::Buffered { event_id, missing } => {
                    let missing_json: Vec<String> =
                        missing.iter().map(|id| id.to_hex()).collect();
                    format!(
                        r#"{{"type":"Buffered","id":"{}","missing":{}}}"#,
                        event_id.to_hex(),
                        serde_json::to_string(&missing_json).unwrap()
                    )
                }
                InsertResult::Duplicate => r#"{"type":"Duplicate"}"#.to_string(),
            };
            Ok(json)
        }

        /// Return the IDs (hex) of all canonical events as a JSON array.
        pub fn canonical_ids(&self) -> String {
            let ids: Vec<String> = self
                .inner
                .canonical_events()
                .map(|id| id.to_hex())
                .collect();
            serde_json::to_string(&ids).unwrap()
        }

        /// Return the IDs (hex) of current DAG tips as a JSON array.
        pub fn tip_ids(&self) -> String {
            let ids: Vec<String> = self.inner.tips().map(|id| id.to_hex()).collect();
            serde_json::to_string(&ids).unwrap()
        }
    }
}
