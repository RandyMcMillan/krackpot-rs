import assert from 'node:assert/strict';
import test from 'node:test';

import { createGitProgressReporter, summarizeGitProgress } from '../demo/shared/git-progress.mjs';

test('summarizeGitProgress formats native-style counters', () => {
  assert.deepEqual(summarizeGitProgress(null), { text: 'progress', phase: '', percent: null });
  assert.deepEqual(
    summarizeGitProgress({ phase: 'fetching objects', loaded: 2, total: 10 }),
    { text: 'fetching objects 2/10 (20%)', phase: 'fetching objects', percent: 20 },
  );
  assert.deepEqual(
    summarizeGitProgress({ message: 'resolving deltas', current: 7 }),
    { text: 'resolving deltas 7', phase: 'resolving deltas', percent: null },
  );
});

test('createGitProgressReporter deduplicates repeated updates and emits completion', () => {
  const report = createGitProgressReporter('nostr-dag', 'clone');

  assert.equal(report({ phase: 'counting objects', loaded: 1, total: 20 }), 'nostr-dag clone: counting objects 1/20 (5%)');
  assert.equal(report({ phase: 'counting objects', loaded: 1, total: 20 }), null);
  assert.equal(report({ phase: 'counting objects', loaded: 2, total: 20 }), 'nostr-dag clone: counting objects 2/20 (10%)');
  assert.equal(report({ phase: 'done' }, true), 'nostr-dag clone complete');
});
