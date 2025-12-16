use nostr::Keys;

fn main() {
    println!("Generating 5 federation keys...\n");

    let mut pubkeys = Vec::new();
    let mut secrets = Vec::new();

    for i in 1..=5 {
        let keys = Keys::generate();
        let sk_hex = keys.secret_key().to_secret_hex();
        let pk_hex = keys.public_key().to_hex();

        println!("=== Federation Member {} ===", i);
        println!("Secret key: {}", sk_hex);
        println!("Public key: {}", pk_hex);
        println!();

        secrets.push(sk_hex);
        pubkeys.push(pk_hex);
    }

    let all_pubkeys = pubkeys.join(",");

    println!("=== Configuration ===\n");
    println!("FEDERATION_PUBKEYS={}\n", all_pubkeys);

    println!("=== Start Commands ===\n");
    for (i, sk) in secrets.iter().enumerate() {
        println!(
            "# Terminal {}\nFEDERATION_KEY={} RELAY_URL=ws://localhost:8080 FEDERATION_PUBKEYS={} cargo run --bin federation\n",
            i + 1,
            sk,
            all_pubkeys
        );
    }

    println!("=== Frontend Config ===\n");
    println!("Paste this into the 'Federation Pubkeys' field:\n{}", all_pubkeys);
}
