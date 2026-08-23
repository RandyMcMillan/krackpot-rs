use bitcoin::key::PrivateKey;
use bitcoin::secp256k1::{Secp256k1, SecretKey};
use bitcoin::{Address, Network};

fn verify_pattern(scalar_num: u128, compressed: bool) {
    let secp = Secp256k1::new();

    // 1. Convert BigInteger scalar to 32-byte big-endian private key array
    let mut bytes = [0u8; 32];
    bytes[16..32].copy_from_slice(&scalar_num.to_be_bytes());

    // 2. Parse secret key on secp256k1
    let secret_key = SecretKey::from_slice(&bytes).expect("Valid scalar");

    // 3. Construct Bitcoin Private Key struct (handles Base58Check WIF generation)
    let priv_key = PrivateKey {
        inner: secret_key,
        network: Network::Bitcoin.into(),
        compressed,
    };

    // 4. Derive P2PKH (Legacy 1...) Public Address
    let pubkey = priv_key.public_key(&secp);
    let address = Address::p2pkh(&pubkey, Network::Bitcoin);

    println!("WIF Private Key: {}", priv_key.to_wif());
    println!("P2PKH Address:   {}", address);
    println!("BigInteger:      {}\n", scalar_num);
}

fn main() {
    // Uncompressed N=2
    verify_pattern(2, false);
    // Compressed N=3
    verify_pattern(3, true);
}
