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
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    listeners: {},
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    addEventListener(name, handler) {
      this.listeners[name] = handler;
    },
    querySelectorAll() {
      return [];
    },
    trigger(name) {
      this.listeners[name]?.();
    },
  };
}

function createFakeRoot() {
  const statusEl = createFakeNode();
  const toggleEl = createFakeNode();
  const chevronEl = createFakeNode();
  const levelEl = createFakeNode();
  const logEl = createFakeNode();
  const root = {
    className: '',
    classList: {
      add(name) {
        root.className = root.className ? `${root.className} ${name}` : name;
      },
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
  return root;
}

test('logger footer scrolls to bottom unless user scrolls away', async () => {
  globalThis.requestAnimationFrame = (cb) => cb();
  globalThis.localStorage = {
    getItem() { return null; },
    setItem() {},
  };

  const source = await readFile(new URL('../demo/shared/logger-footer.js', import.meta.url), 'utf8');
  const { createLoggerFooter } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
  const root = createFakeRoot();
  const footer = createLoggerFooter(root, { title: 'Logger' });

  footer.setLevel('info');
  const logEl = root.nodes.logEl;

  logEl.scrollTop = 800;
  logEl.trigger('scroll');
  footer.log('git', 'one', 'info');
  assert.equal(logEl.scrollTop, logEl.scrollHeight);

  logEl.scrollTop = 100;
  logEl.trigger('pointerdown');
  footer.log('git', 'two', 'info');
  assert.equal(logEl.scrollTop, 100);
});
