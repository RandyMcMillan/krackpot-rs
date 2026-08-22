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

  root.classList.add('sticky-footer');
  root.innerHTML = `
    <div class="sticky-footer-inner small muted">
      <div class="footer-header">
        <div class="footer-status-wrap">
          <span data-footer-status class="status status-idle" title=""></span>
        </div>
        <div class="footer-log-wrap">
          <button data-footer-toggle class="footer-toggle" type="button" aria-expanded="false" aria-controls="footerLogPanel">
            <span data-footer-chevron class="footer-chevron">▸</span>
            <span>${title}</span>
          </button>
        </div>
      </div>
      <div data-footer-log class="footer-log" hidden></div>
    </div>
  `;

  const statusEl = root.querySelector('[data-footer-status]');
  const toggleEl = root.querySelector('[data-footer-toggle]');
  const chevronEl = root.querySelector('[data-footer-chevron]');
  const logEl = root.querySelector('[data-footer-log]');
  const logs = [];
  let open = false;

  function render() {
    chevronEl.className = `footer-chevron${open ? ' open' : ''}`;
    toggleEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    logEl.hidden = !open;
    logEl.innerHTML = logs.length
      ? logs.map((entry) => `
        <div class="footer-log-item">
          <span class="footer-log-time mono">${entry.time}</span>
          <span>${entry.label ? `${entry.label}: ` : ''}${entry.text}</span>
        </div>
      `).join('')
      : '<div class="muted">No log entries yet.</div>';
  }

  function setState(state, text) {
    const nextState = state || normalizeState(text);
    statusEl.className = `status status-${nextState}`;
    statusEl.title = text || initialTitle;
  }

  function log(label, text, state = null) {
    logs.push({
      time: new Date().toLocaleTimeString(),
      label: label || '',
      text: String(text),
    });
    while (logs.length > 24) logs.shift();
    setState(state || normalizeState(text), label ? `${label}: ${text}` : String(text));
    render();
  }

  toggleEl.addEventListener('click', () => {
    open = !open;
    render();
  });

  setState(initialState, initialTitle);
  render();

  return {
    log,
    setState,
    open() {
      open = true;
      render();
    },
    close() {
      open = false;
      render();
    },
    toggle() {
      open = !open;
      render();
    },
  };
}
