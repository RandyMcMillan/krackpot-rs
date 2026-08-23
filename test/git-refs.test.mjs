import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('remoteTagNames extracts unique remote tag names', async () => {
  const source = await readFile(new URL('../demo/shared/git-refs.mjs', import.meta.url), 'utf8');
  const { remoteTagNames } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);

  assert.deepEqual(remoteTagNames([
    { ref: 'refs/heads/main' },
    { ref: 'refs/tags/v0.2.0' },
    { ref: 'refs/tags/v0.2.0^{}' },
    { ref: 'refs/tags/v0.3.0' },
  ]), ['v0.2.0', 'v0.3.0']);
});
