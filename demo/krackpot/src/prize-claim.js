// Build and sign a Bitcoin transaction that pays the user a flat 6 BTC and
// sends the remainder (after the network fee) to the developer's hardcoded
// address. The dev output is dropped if it would land at or below standard
// dust, in which case the leftover sats absorb into the fee.
//
// Uses @scure/btc-signer (pure JS, no Buffer dependency). Legacy P2PKH inputs
// require the full previous transaction hex (PSBT non-witness UTXO rule),
// which is embedded in src/puzzle-utxos.js by scripts/capture-utxos.mjs.

import * as btc from "https://esm.sh/@scure/btc-signer@1.3.0";
import { hex } from "https://esm.sh/@scure/base@1.1.5";

export const DEV_ADDRESS         = "bc1qq5y98nxyscu6x74z30ym44wwyz4usu95ryende";
export const USER_PAYOUT_SATS    = 600_000_000n;   // exactly 6 BTC to the cruncher
export const DEV_DUST_LIMIT_SATS = 546n;           // standard P2WPKH dust threshold
export const FEE_RATE_SAT_PER_VB = 69n;

const P2PKH_INPUT_VBYTES = 148n;
const OUTPUT_VBYTES      = 34n;
const TX_OVERHEAD_VBYTES = 10n;

const estimateVbytes = (numInputs, numOutputs) =>
  TX_OVERHEAD_VBYTES + BigInt(numInputs) * P2PKH_INPUT_VBYTES + BigInt(numOutputs) * OUTPUT_VBYTES;

const bigIntToBytes32 = (n) => {
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xFFn);
    x >>= 8n;
  }
  return out;
};

export const buildSignedTx = ({ privBigInt, userAddress, utxos }) => {
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error("no UTXOs supplied to spend");
  }
  for (const u of utxos) {
    if (!u.prevTxHex) {
      throw new Error(
        `UTXO ${u.txid}:${u.vout} is missing prevTxHex — re-run scripts/capture-utxos.mjs to refresh the snapshot`
      );
    }
  }

  const totalInput = utxos.reduce((acc, u) => acc + BigInt(u.value), 0n);
  const feeTwoOut  = estimateVbytes(utxos.length, 2) * FEE_RATE_SAT_PER_VB;
  const feeOneOut  = estimateVbytes(utxos.length, 1) * FEE_RATE_SAT_PER_VB;

  if (totalInput < USER_PAYOUT_SATS + feeOneOut) {
    throw new Error(
      `puzzle prize (${totalInput} sats) cannot cover the fixed ${USER_PAYOUT_SATS} sat user payout plus fee`
    );
  }

  const userAmount = USER_PAYOUT_SATS;
  let devAmount = totalInput - feeTwoOut - userAmount;
  let fee = feeTwoOut;
  let includeDev = true;
  if (devAmount <= DEV_DUST_LIMIT_SATS) {
    includeDev = false;
    fee = totalInput - userAmount;
    devAmount = 0n;
  }

  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  for (const u of utxos) {
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      nonWitnessUtxo: hex.decode(u.prevTxHex),
    });
  }
  tx.addOutputAddress(userAddress, userAmount);
  if (includeDev) {
    tx.addOutputAddress(DEV_ADDRESS, devAmount);
  }

  const privBytes = bigIntToBytes32(privBigInt);
  tx.sign(privBytes);
  tx.finalize();

  const txBytes = tx.extract();
  return {
    hex: hex.encode(txBytes),
    txid: tx.id,
    totalInput: Number(totalInput),
    fee:        Number(fee),
    userAmount: Number(userAmount),
    devAmount:  Number(devAmount),
  };
};

export const buildShieldTx = ({ privBigInt, userAddress, utxos, shieldAddress, shieldFeerateSatPerVb }) => {
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error("no UTXOs supplied to spend");
  }
  if (!shieldAddress) throw new Error("buildShieldTx: missing shieldAddress (from /info)");
  const feerate = BigInt(shieldFeerateSatPerVb);
  if (feerate <= 0n) throw new Error("buildShieldTx: shieldFeerateSatPerVb must be > 0");
  for (const u of utxos) {
    if (!u.prevTxHex) {
      throw new Error(
        `UTXO ${u.txid}:${u.vout} is missing prevTxHex — re-run scripts/capture-utxos.mjs to refresh the snapshot`
      );
    }
  }

  const totalInput = utxos.reduce((acc, u) => acc + BigInt(u.value), 0n);
  const userAmount = USER_PAYOUT_SATS;

  let shieldFee   = feerate * estimateVbytes(utxos.length, 3);
  let devAmount   = totalInput - userAmount - shieldFee;
  let includeDev  = true;
  let onChainFee  = 0n;

  if (devAmount <= DEV_DUST_LIMIT_SATS) {
    includeDev = false;
    shieldFee  = feerate * estimateVbytes(utxos.length, 2);
    devAmount  = 0n;
    onChainFee = totalInput - userAmount - shieldFee;
  }

  if (totalInput < userAmount + shieldFee || onChainFee < 0n) {
    throw new Error(
      `puzzle prize (${totalInput} sats) cannot cover the ${userAmount} sat user payout plus the Shield fee (${shieldFee} sats)`
    );
  }

  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  for (const u of utxos) {
    tx.addInput({ txid: u.txid, index: u.vout, nonWitnessUtxo: hex.decode(u.prevTxHex) });
  }
  tx.addOutputAddress(userAddress, userAmount);
  if (includeDev) tx.addOutputAddress(DEV_ADDRESS, devAmount);
  tx.addOutputAddress(shieldAddress, shieldFee);

  const privBytes = bigIntToBytes32(privBigInt);
  tx.sign(privBytes);
  tx.finalize();

  const txBytes = tx.extract();
  return {
    hex: hex.encode(txBytes),
    txid: tx.id,
    totalInput: Number(totalInput),
    onChainFee: Number(onChainFee),
    shieldFee:  Number(shieldFee),
    shieldAddress,
    userAmount: Number(userAmount),
    devAmount:  Number(devAmount),
  };
};
