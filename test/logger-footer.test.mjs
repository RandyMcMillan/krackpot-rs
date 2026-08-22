import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function createFakeNode() {
  return {
    className: '',
    hidden: false,
    title: '',
    attrs: {},
    innerHTML: '',
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
  };
}

function createFakeRoot() {
  const statusEl = createFakeNode();
  const toggleEl = createFakeNode();
  const chevronEl = createFakeNode();
  const levelEl = createFakeNode();
  const logEl = createFakeNode();

  return {
    classList: { add() {} },
    innerHTML: '',
    querySelector(selector) {
      if (selector === '[data-footer-status]') return statusEl;
      if (selector === '[data-footer-toggle]') return toggleEl;
      if (selector === '[data-footer-chevron]') return chevronEl;
      if (selector === '[data-footer-level]') return levelEl;
      if (selector === '[data-footer-log]') return logEl;
      return null;
    },
    nodes: { statusEl, toggleEl, chevronEl, levelEl, logEl },
  };
}

test('logger footer stays closed at none and opens for visible levels', async () => {
  const source = await readFile(new URL('../demo/shared/logger-footer.js', import.meta.url), 'utf8');
  const { createLoggerFooter } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
  const root = createFakeRoot();
  const footer = createLoggerFooter(root);

  assert.equal(footer.getLevel(), 'none');
  assert.equal(root.nodes.logEl.hidden, true);

  footer.setLevel('info');
  assert.equal(footer.getLevel(), 'info');
  assert.equal(root.nodes.logEl.hidden, false);
  assert.equal(root.nodes.toggleEl.attrs['aria-expanded'], 'true');

  footer.setLevel('none');
  assert.equal(footer.getLevel(), 'none');
  assert.equal(root.nodes.logEl.hidden, true);
  assert.equal(root.nodes.toggleEl.attrs['aria-expanded'], 'false');
});
