use bitcoin::key::PrivateKey;
use bitcoin::secp256k1::{Secp256k1, SecretKey};
use bitcoin::{Address, Network};

struct Vector {
    n: u128,
    compressed: bool,
    wif: &'static str,
    address: &'static str,
}

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
fn valid_scalar_vectors_match_expected_outputs() {
    let vectors = [
        Vector {
            n: 2,
            compressed: false,
            wif: "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAvUcVfH",
            address: "1LagHJk2FyCV2VzrNHVqg3gYG4TSYwDV4m",
        },
        Vector {
            n: 3,
            compressed: true,
            wif: "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU74sHUHy8S",
            address: "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb",
        },
        Vector {
            n: 3,
            compressed: false,
            wif: "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreB1FQ8BZ",
            address: "1NZUP3JAc9JkmbvmoTv7nVgZGtyJjirKV1",
        },
        Vector {
            n: 4,
            compressed: false,
            wif: "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreB4AD8Yi",
            address: "1MnyqgrXCmcWJHBYEsAWf7oMyqJAS81eC",
        },
        Vector {
            n: 8,
            compressed: true,
            wif: "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU77MfhviY5",
            address: "1EhqbyUMvvs7BfL8goY6qcPbD6YKfPqb7e",
        },
        Vector {
            n: 16,
            compressed: false,
            wif: "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreCUtzTQw",
            address: "18XrReT5ChW8qgXecNgKTU5T6MrMMLnV8H",
        },
        Vector {
            n: 128,
            compressed: false,
            wif: "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreR42AY81",
            address: "1EoXPE6MzT4EnHvk2Ldj64M2ks2EAcZyH4",
        },
        Vector {
            n: 65_536,
            compressed: false,
            wif: "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEstqeYvoUVo",
            address: "1AH93tcUoyFtioff7U5aucuQLkFL2rnDpn",
        },
    ];

    for vector in vectors {
        let (wif, address) = derive(vector.n, vector.compressed);
        assert_eq!(wif, vector.wif, "WIF mismatch for N={}", vector.n);
        assert_eq!(address, vector.address, "address mismatch for N={}", vector.n);
    }
}
