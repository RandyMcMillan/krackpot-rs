import { createLibp2p } from "https://esm.sh/libp2p";
import { autoNAT } from "https://esm.sh/@libp2p/autonat";
import { bootstrap } from "https://esm.sh/@libp2p/bootstrap";
import { circuitRelayTransport } from "https://esm.sh/@libp2p/circuit-relay-v2";
import { dcutr } from "https://esm.sh/@libp2p/dcutr";
import { gossipsub } from "https://esm.sh/@libp2p/gossipsub";
import { identify } from "https://esm.sh/@libp2p/identify";
import { webSockets } from "https://esm.sh/@libp2p/websockets";
import { webRTC } from "https://esm.sh/@libp2p/webrtc";
import { webRTCDirect } from "https://esm.sh/@libp2p/webrtc-direct";
import { noise } from "https://esm.sh/@chainsafe/libp2p-noise";
import { yamux } from "https://esm.sh/@chainsafe/libp2p-yamux";

export const DEFAULT_BOOTSTRAP_PEERS = [
  "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
];

const peerLabel = (event) => event?.detail?.peerId?.toString?.() || event?.detail?.remotePeer?.toString?.() || "peer";

const emitLog = (onLog, level, text, state = "checking") => {
  onLog?.(level, text, state);
  if (level !== "debug") {
    onLog?.("debug", `[${level}] ${text}`, state);
  }
};

const emitPeerEvent = (onPeer, onLog, kind, event, level = "debug", state = "checking") => {
  const peer = peerLabel(event);
  onPeer?.({ kind, peer, detail: event?.detail || null });
  emitLog(onLog, level, `peer ${kind}: ${peer}`, state);
};

export async function createSharedLibp2pStack({
  bootstrapPeers = DEFAULT_BOOTSTRAP_PEERS,
  onLog,
  onPeer,
  onStatus,
} = {}) {
  const peers = [...new Set(bootstrapPeers.filter(Boolean))];
  emitLog(onLog, "info", `bootstrapping with ${peers.length} peer${peers.length === 1 ? "" : "s"}`, "checking");
  emitLog(onLog, "debug", `bootstrap peers configured: ${peers.length}`, "checking");
  emitLog(onLog, "trace", "shared libp2p stack configuring transports and services", "checking");

  const node = await createLibp2p({
    transports: [
      webSockets(),
      webRTC(),
      webRTCDirect(),
      circuitRelayTransport({ discoverRelays: 2 }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    addresses: {
      listen: ["/webrtc", "/p2p-circuit"],
    },
    services: {
      identify: identify(),
      autoNAT: autoNAT(),
      dcutr: dcutr(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: true,
      }),
    },
    peerDiscovery: peers.length ? [
      bootstrap({
        list: peers,
        interval: 60_000,
        timeout: 3_000,
      }),
    ] : [],
  });

  node.addEventListener("peer:discovery", (event) => {
    emitPeerEvent(onPeer, onLog, "discovered", event, "debug", "checking");
  });
  node.addEventListener("peer:connect", (event) => {
    emitPeerEvent(onPeer, onLog, "connected", event, "info", "available");
  });
  node.addEventListener("peer:disconnect", (event) => {
    emitPeerEvent(onPeer, onLog, "disconnected", event, "debug", "checking");
  });

  await node.start();
  emitLog(onLog, "trace", "shared libp2p node started", "available");
  onStatus?.("started", node.peerId.toString());
  emitLog(onLog, "info", `node started: ${node.peerId.toString()}`, "available");

  return {
    node,
    bootstrapPeers: peers,
  };
}
