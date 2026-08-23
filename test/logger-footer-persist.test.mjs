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
    className: '',
    classList: {
      add(name) {
        this.owner.className = this.owner.className ? `${this.owner.className} ${name}` : name;
      },
      owner: null,
    },
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

test('logger footer restores persisted open and level state', async () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
  globalThis.location = { pathname: '/git/' };

  const source = await readFile(new URL('../demo/shared/logger-footer.js', import.meta.url), 'utf8');
  const { createLoggerFooter } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);

  const firstRoot = createFakeRoot();
  firstRoot.classList.owner = firstRoot;
  const footer = createLoggerFooter(firstRoot, { title: 'Logger' });
  footer.setLevel('debug');
  footer.open();

  const secondRoot = createFakeRoot();
  secondRoot.classList.owner = secondRoot;
  const restored = createLoggerFooter(secondRoot, { title: 'Logger' });

  assert.equal(restored.getLevel(), 'debug');
  assert.equal(secondRoot.nodes.logEl.hidden, false);
});
