#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://krackpot.io/src/}"
OUT_DIR="${1:-demo/krackpot/src}"

mkdir -p "$OUT_DIR"

node - "$BASE_URL" "$OUT_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const baseUrl = process.argv[2];
const outDir = path.resolve(process.argv[3]);
const seen = new Set();
const queue = ['main.js'];
const files = new Map();

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        fetchText(next).then(resolve, reject);
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else reject(new Error(`status ${res.statusCode} for ${url}`));
      });
    }).on('error', reject);
  });
}

(async () => {
  while (queue.length) {
    const rel = queue.shift();
    const url = new URL(rel, baseUrl).href;
    if (seen.has(url)) continue;
    seen.add(url);

    let data;
    try {
      data = await fetchText(url);
    } catch (err) {
      console.error(`failed to fetch ${rel}: ${err.message}`);
      process.exitCode = 1;
      continue;
    }

    files.set(rel, data);
    const dirUrl = new URL('.', url).href;
    for (const match of data.matchAll(/(?:import\s+(?:[^'"\n]+?\s+from\s+)?|export\s+[^'"\n]*?from\s+|from\s+)['"](\.\.\/[^'"\n]+|\.\/[^'"\n]+)['"]/g)) {
      let spec = match[1];
      if (!/\.[a-zA-Z0-9]+$/.test(spec)) spec += '.js';
      const resolved = new URL(spec, dirUrl).href;
      if (!resolved.startsWith(baseUrl)) continue;
      queue.push(resolved.slice(baseUrl.length));
    }
  }

  for (const [rel, data] of [...files.entries()].sort()) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }

  console.log(`wrote ${files.size} files to ${outDir}`);
})();
NODE
