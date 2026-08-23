use bitcoin::key::PrivateKey;
use bitcoin::secp256k1::{Secp256k1, SecretKey};
use bitcoin::{Address, Network};

fn derive(n: u128, compressed: bool) -> (String, String) {
    let secp = Secp256k1::new();

    let mut bytes = [0u8; 32];
    bytes[16..32].copy_from_slice(&n.to_be_bytes());

    let secret_key = SecretKey::from_slice(&bytes).expect("valid scalar");
    let priv_key = PrivateKey {
        inner: secret_key,
        network: Network::Bitcoin.into(),
        compressed,
    };

    let pubkey = priv_key.public_key(&secp);
    let address = Address::p2pkh(&pubkey, Network::Bitcoin);

    (priv_key.to_wif(), address.to_string())
}

#[test]
fn valid_scalar_series() {
    println!("BigInteger (N),WIF Private Key,Address Type,P2PKH Address");

    for n in 1u128..=65_536 {
        for &compressed in &[false, true] {
            let (wif, address) = derive(n, compressed);
            println!(
                "{n},{wif},{},{address}",
                if compressed {
                    "Compressed"
                } else {
                    "Uncompressed"
                }
            );
        }
    }
}
