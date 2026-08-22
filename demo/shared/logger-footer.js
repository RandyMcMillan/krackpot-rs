function normalizeState(text, fallback = 'idle') {
  const value = String(text || '').toLowerCase();
  if (!value) return fallback;
  if (value.includes('unavailable') || value.includes('failed') || value.includes('error')) return 'unavailable';
  if (
    value.includes('loading') ||
    value.includes('starting') ||
    value.includes('cloning') ||
    value.includes('fetching') ||
    value.includes('refresh') ||
    value.includes('caching') ||
    value.includes('reading') ||
    value.includes('writing') ||
    value.includes('committing')
  ) return 'checking';
  if (value.includes('ready') || value.includes('done') || value.includes('available') || value.includes('restored')) return 'available';
  return fallback;
}

const LOG_LEVELS = ['none', 'info', 'debug', 'trace', 'warn'];
const STORAGE_PREFIX = 'nostr-dag.logger-footer';

function normalizeLevel(value) {
  const level = String(value || 'info').toLowerCase();
  return LOG_LEVELS.includes(level) ? level : 'info';
}

function parseLogArgs(levelOrState = 'info', maybeState = null) {
  if (maybeState === null && !LOG_LEVELS.includes(String(levelOrState).toLowerCase())) {
    return {
      level: null,
      state: String(levelOrState || 'idle'),
    };
  }
  return {
    level: normalizeLevel(levelOrState),
    state: maybeState,
  };
}

function deriveLevelFromState(state) {
  const value = String(state || '').toLowerCase();
  if (value.includes('unavailable') || value.includes('failed') || value.includes('error')) return 'warn';
  if (value.includes('checking') || value.includes('refresh') || value.includes('loading') || value.includes('cloning') || value.includes('fetching') || value.includes('caching') || value.includes('starting') || value.includes('reading') || value.includes('writing') || value.includes('committing')) return 'debug';
  return 'info';
}

function getStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function resolveStorageKey(title, storageKey) {
  if (storageKey) return storageKey;
  const path = globalThis.location?.pathname || 'unknown';
  return `${STORAGE_PREFIX}:${title}:${path}`;
}

function loadPersistedFooterState(storageKey) {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      open: typeof parsed.open === 'boolean' ? parsed.open : null,
      level: typeof parsed.level === 'string' ? normalizeLevel(parsed.level) : null,
    };
  } catch {
    return null;
  }
}

function savePersistedFooterState(storageKey, state) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // best effort only
  }
}

export function createLoggerFooter(root, options = {}) {
  if (!root) {
    return {
      log() {},
      setState() {},
      open() {},
      close() {},
      toggle() {},
    };
  }

  const title = options.title || 'Logger';
  const initialState = options.initialState || 'idle';
  const initialTitle = options.initialTitle || 'starting...';
  const storageKey = resolveStorageKey(title, options.storageKey);
  const persisted = loadPersistedFooterState(storageKey);

  root.classList.add('sticky-footer');
  root.innerHTML = `
    <div class="sticky-footer-inner small muted">
      <div class="footer-header">
        <div class="footer-status-wrap">
          <span data-footer-status class="status status-idle" title=""></span>
        </div>
        <div class="footer-log-wrap">
          <div class="footer-controls">
            <button data-footer-toggle class="footer-toggle" type="button" aria-expanded="false" aria-controls="footerLogPanel">
              <span data-footer-chevron class="footer-chevron">▸</span>
              <span>${title}</span>
            </button>
            <div class="footer-level-pills" data-footer-level></div>
          </div>
        </div>
      </div>
      <div data-footer-log class="footer-log" hidden></div>
    </div>
  `;

  const statusEl = root.querySelector('[data-footer-status]');
  const toggleEl = root.querySelector('[data-footer-toggle]');
  const chevronEl = root.querySelector('[data-footer-chevron]');
  const levelEl = root.querySelector('[data-footer-level]');
  const logEl = root.querySelector('[data-footer-log]');
  const logs = [];
  let open = persisted?.open ?? false;
  let level = persisted?.level ?? normalizeLevel(options.initialLevel || 'none');
  let autoScroll = true;
  let scrollListenerBound = false;

  function persistState() {
    savePersistedFooterState(storageKey, { open, level });
  }

  function isNearBottom() {
    return (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight) < 24;
  }

  function scheduleScrollBottom() {
    if (!open || !autoScroll) return;
    const run = () => {
      logEl.scrollTop = logEl.scrollHeight;
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function bindScrollLock() {
    if (scrollListenerBound) return;
    scrollListenerBound = true;
    logEl.addEventListener('scroll', () => {
      autoScroll = isNearBottom();
    });
    logEl.addEventListener('pointerdown', () => {
      autoScroll = false;
    });
    logEl.addEventListener('wheel', () => {
      autoScroll = false;
    }, { passive: true });
    logEl.addEventListener('touchstart', () => {
      autoScroll = false;
    }, { passive: true });
  }

  function renderLevelPills() {
    levelEl.innerHTML = LOG_LEVELS.map((entryLevel) => `
      <button type="button" class="footer-pill${entryLevel === level ? ' active' : ''}" data-level-pill="${entryLevel}">
        ${entryLevel}
      </button>
    `).join('');
    levelEl.querySelectorAll('[data-level-pill]').forEach((button) => {
      button.addEventListener('click', () => {
        level = normalizeLevel(button.getAttribute('data-level-pill'));
        open = level !== 'none';
        persistState();
        render();
      });
    });
  }

  function render() {
    chevronEl.className = `footer-chevron${open ? ' open' : ''}`;
    toggleEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    renderLevelPills();
    logEl.hidden = !open;
    const visibleLogs = level === 'none' ? [] : logs.filter((entry) => entry.level === level);
    logEl.innerHTML = visibleLogs.length
      ? visibleLogs.map((entry) => `
        <div class="footer-log-item">
          <span class="footer-log-time mono">${entry.time}</span>
          <span>${entry.label ? `${entry.label}: ` : ''}${entry.text}</span>
        </div>
      `).join('')
      : '<div class="muted">No log entries yet.</div>';
    scheduleScrollBottom();
  }

  function setState(state, text) {
    const nextState = state || normalizeState(text);
    statusEl.className = `status status-${nextState}`;
    statusEl.title = text || initialTitle;
  }

  function log(label, text, levelOrState = 'info', maybeState = null) {
    const { level: providedLevel, state } = parseLogArgs(levelOrState, maybeState);
    const nextLevel = providedLevel || deriveLevelFromState(state);
    logs.push({
      time: new Date().toLocaleTimeString(),
      label: label || '',
      text: String(text),
      level: nextLevel,
    });
    while (logs.length > 24) logs.shift();
    setState(state || normalizeState(text), label ? `${label}: ${text}` : String(text));
    render();
  }

  toggleEl.addEventListener('click', () => {
    open = !open;
    persistState();
    render();
  });

  setState(initialState, initialTitle);
  bindScrollLock();
  render();

  return {
    log,
    setState,
    setLevel(nextLevel) {
      level = normalizeLevel(nextLevel);
      // Show the log panel as soon as the user picks a real level; hide it again for `none`.
      open = level !== 'none';
      persistState();
      render();
    },
    getLevel() {
      return level;
    },
    open() {
      open = true;
      persistState();
      render();
    },
    close() {
      open = false;
      persistState();
      render();
    },
    toggle() {
      open = !open;
      persistState();
      render();
    },
  };
}
