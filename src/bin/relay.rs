//! Start the local Nostr relay used by the demo and federation processes.
//!
//! This binary binds a relay port, serves Nostr events, and prints `RELAY_URL=...`
//! so other local processes can connect to it.

use std::env;

use nostr_relay_builder::prelude::*;
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("relay=info".parse()?),
        )
        .init();

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080);

    let relay = LocalRelay::new(RelayBuilder::default().port(port));
    relay.run().await?;

    let url = relay.url().await;
    info!(%url, "Relay running");

    println!("RELAY_URL={}", url);

    tokio::signal::ctrl_c().await?;
    Ok(())
}
