const encoder = new TextEncoder();
const decoder = new TextDecoder();

const openDb = (name, storeName) => new Promise((resolve, reject) => {
  const req = indexedDB.open(name, 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(storeName)) {
      const store = db.createObjectStore(storeName, { keyPath: "id" });
      store.createIndex("by_type", "type", { unique: false });
      store.createIndex("by_created_at", "createdAt", { unique: false });
    }
  };
  req.onerror = () => reject(req.error);
  req.onsuccess = () => resolve(req.result);
});

const txPromise = (db, mode, storeName, fn) => new Promise((resolve, reject) => {
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const result = fn(store);
  tx.oncomplete = () => resolve(result);
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

const getAllRecords = (db, storeName) => txPromise(db, "readonly", storeName, (store) => new Promise((resolve, reject) => {
  const req = store.getAll();
  req.onerror = () => reject(req.error);
  req.onsuccess = () => resolve(req.result || []);
}));

const putRecord = (db, storeName, record) => txPromise(db, "readwrite", storeName, (store) => new Promise((resolve, reject) => {
  const req = store.put(record);
  req.onerror = () => reject(req.error);
  req.onsuccess = () => resolve(record);
}));

const sha256Hex = async (value) => {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

const stableStringify = (value) => JSON.stringify(value, (key, v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  return Object.keys(v).sort().reduce((out, k) => {
    out[k] = v[k];
    return out;
  }, {});
});

export const createReplicatedArchive = async ({
  namespace,
  topic,
  node,
  buildSnapshot,
  applySnapshot,
  onStatus,
  onRecord,
  onPeer,
} = {}) => {
  if (!namespace) throw new Error("createReplicatedArchive: namespace is required");
  if (!topic) throw new Error("createReplicatedArchive: topic is required");
  if (typeof buildSnapshot !== "function") throw new Error("createReplicatedArchive: buildSnapshot is required");
  if (typeof applySnapshot !== "function") throw new Error("createReplicatedArchive: applySnapshot is required");

  const dbName = `krackpot-rs-archive:${namespace}`;
  const storeName = "records";
  const db = await openDb(dbName, storeName);
  const seenIds = new Set((await getAllRecords(db, storeName)).map((record) => record.id));
  const pubsub = node?.services?.pubsub || node?.pubsub || null;
  let latestSnapshot = null;
  let publishing = false;

  const emitStatus = (message, ok = true) => {
    onStatus?.(message, ok);
  };

  emitStatus(`archive db ready: ${dbName}`, true);
  emitStatus(`archive topic: ${topic}`, true);
  emitStatus(`archive pubsub: ${pubsub ? "available" : "missing"}`, !!pubsub);
  emitStatus(`archive records seen: ${seenIds.size}`, true);

  const applyRecord = async (record, { local = false } = {}) => {
    if (!record || typeof record !== "object") return false;
    if (!record.id || seenIds.has(record.id)) return false;
    seenIds.add(record.id);
    await putRecord(db, storeName, record);
    onRecord?.(record, { local });
    emitStatus(`${local ? "stored local" : "stored remote"} ${record.type}: ${record.id}`, true);
    emitStatus(`archive record payload keys: ${Object.keys(record.payload || {}).join(",") || "none"}`, true);

    if (record.type === "snapshot") {
      const currentTime = latestSnapshot?.createdAt ?? 0;
      if (!latestSnapshot || record.createdAt >= currentTime) {
        latestSnapshot = record;
        emitStatus(`applied snapshot ${record.id}`, true);
        applySnapshot(record.payload, { local, record });
      }
    }

    return true;
  };

  const publishRecord = async (type, payload, meta = {}) => {
    emitStatus(`publishing ${type}`, true);
    const snapshot = {
      id: meta.id || await sha256Hex(stableStringify({
        namespace,
        type,
        payload,
        createdAt: meta.createdAt || Date.now(),
        peerId: meta.peerId || node?.peerId?.toString?.() || null,
      })),
      namespace,
      type,
      createdAt: meta.createdAt || Date.now(),
      peerId: meta.peerId || node?.peerId?.toString?.() || null,
      payload,
    };

    await applyRecord(snapshot, { local: true });
    emitStatus(`built ${type} ${snapshot.id}`, true);

    if (!pubsub?.publish) return snapshot;
    if (publishing) return snapshot;

    publishing = true;
    try {
      emitStatus(`publishing ${type} ${snapshot.id}`, true);
      await pubsub.publish(topic, encoder.encode(JSON.stringify(snapshot)));
      emitStatus(`published ${type}`, true);
    } catch (e) {
      emitStatus(`p2p publish failed: ${e.message}`, false);
    } finally {
      publishing = false;
    }
    return snapshot;
  };

  const syncSnapshot = async () => {
    emitStatus("sync snapshot start", true);
    const payload = buildSnapshot();
    const result = await publishRecord("snapshot", payload);
    emitStatus("sync snapshot done", true);
    return result;
  };

  const loadLatest = async () => {
    emitStatus("loading latest snapshot", true);
    if (latestSnapshot) {
      emitStatus(`reusing latest snapshot ${latestSnapshot.id}`, true);
      applySnapshot(latestSnapshot.payload, { local: true, record: latestSnapshot });
      return latestSnapshot;
    }

    const all = await getAllRecords(db, storeName);
    const snapshots = all.filter((record) => record.type === "snapshot");
    emitStatus(`loaded ${all.length} stored record${all.length === 1 ? "" : "s"}`, true);
    emitStatus(`loaded ${snapshots.length} stored snapshot${snapshots.length === 1 ? "" : "s"}`, true);
    latestSnapshot = snapshots.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).at(-1) || null;
    if (latestSnapshot) {
      emitStatus(`loaded latest snapshot ${latestSnapshot.id}`, true);
      applySnapshot(latestSnapshot.payload, { local: true, record: latestSnapshot });
    } else {
      emitStatus("no stored snapshots found", true);
    }
    return latestSnapshot;
  };

  const subscribe = async () => {
    if (!pubsub?.subscribe) {
      emitStatus("pubsub subscribe unavailable", false);
      return;
    }
    emitStatus(`subscribing to ${topic}`, true);
    await pubsub.subscribe(topic);
    pubsub.addEventListener?.("message", async (event) => {
      const detail = event?.detail || event;
      const data = detail?.data || detail?.message?.data;
      const messageTopic = detail?.topic || detail?.message?.topic;
      if (messageTopic !== topic || !data) return;
      try {
        emitStatus(`received p2p message (${data.byteLength || data.length || 0} bytes)`, true);
        const record = JSON.parse(decoder.decode(data));
        emitStatus(`received remote ${record?.type || "record"} ${record?.id || "unknown"}`, true);
        await applyRecord(record, { local: false });
      } catch {
        emitStatus("ignored malformed remote record", false);
      }
    });
  };

  const start = async () => {
    emitStatus("archive start", true);
    await loadLatest();
    await subscribe();
    await syncSnapshot();
    emitStatus("archive ready", true);
  };

  const stop = async () => {
    try {
      emitStatus(`unsubscribing from ${topic}`, true);
      await pubsub?.unsubscribe?.(topic);
      emitStatus("archive stopped", true);
    } catch {
      // best-effort
    }
  };

  return {
    db,
    topic,
    namespace,
    loadLatest,
    publishRecord,
    syncSnapshot,
    start,
    stop,
    getLatestSnapshot: () => latestSnapshot,
  };
};
