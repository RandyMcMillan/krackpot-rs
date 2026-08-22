import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('shared header renders nav and active state', async () => {
  const source = await readFile(new URL('../demo/shared/page-header.mjs', import.meta.url), 'utf8');
  const { createSharedHeader } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
  const root = {
    classList: { add() {} },
    innerHTML: '',
  };

  createSharedHeader(root, {
    title: 'nostr-dag',
    subtitleHtml: 'Shared chrome',
    navItems: [
      { label: 'Demo', href: './', current: true },
      { label: 'Git viewer', href: './git/' },
    ],
  });

  assert.match(root.innerHTML, /Primary navigation/);
  assert.match(root.innerHTML, /aria-current="page"/);
  assert.match(root.innerHTML, />Git viewer<\/a>/);
});
