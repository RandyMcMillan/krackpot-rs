function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Render the shared page header and navigation bar used by the demo and Git viewer.
 * Keep the page-specific content below this shared chrome so both entry points stay aligned.
 */
export function createSharedHeader(root, options = {}) {
  if (!root) {
    return {
      render() {},
    };
  }

  const title = options.title || 'nostr-dag';
  const subtitleHtml = options.subtitleHtml || '';
  const actionsHtml = options.actionsHtml || '';
  const navItems = Array.isArray(options.navItems) ? options.navItems : [];

  root.innerHTML = `
    <header class="panel" style="position:sticky; top:0; z-index:45; backdrop-filter:blur(8px);">
      <div class="row" style="justify-content:space-between; align-items:flex-start;">
        <div>
          <h1>${escapeHtml(title)}</h1>
          ${subtitleHtml ? `<div class="muted">${subtitleHtml}</div>` : ''}
        </div>
        ${actionsHtml ? `<div class="row" style="justify-content:flex-end;">${actionsHtml}</div>` : ''}
      </div>
      ${navItems.length ? `
        <nav class="row" aria-label="Primary navigation" style="margin-top:10px;">
          ${navItems
            .map((item) => {
              const label = escapeHtml(item.label || '');
              const href = escapeHtml(item.href || '#');
              const current = item.current ? ' aria-current="page"' : '';
              return item.current
                ? `<span class="button" aria-current="page">${label}</span>`
                : `<a class="button" href="${href}"${current}>${label}</a>`;
            })
            .join('')}
        </nav>
      ` : ''}
    </header>
  `;

  return {
    render() {},
  };
}
