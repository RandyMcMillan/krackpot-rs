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
  const navItems = Array.isArray(options.navItems) ? options.navItems : [];

  root.classList.add('sticky-header');
  root.innerHTML = `
    <div class="header-container">
      <div>
        <div class="logo">${escapeHtml(title)}</div>
        ${subtitleHtml ? `<div class="muted header-subtitle">${subtitleHtml}</div>` : ''}
      </div>
      ${navItems.length ? `
        <nav aria-label="Primary navigation">
          <ul class="nav-links">
            ${navItems
              .map((item) => {
                const label = escapeHtml(item.label || '');
                const href = escapeHtml(item.href || '#');
                const current = item.current ? ' aria-current="page"' : '';
                return `<li>${
                  item.current
                    ? `<span class="nav-link current"${current}>${label}</span>`
                    : `<a href="${href}"${current}>${label}</a>`
                }</li>`;
              })
              .join('')}
          </ul>
        </nav>
      ` : ''}
    </div>
  `;

  return {
    render() {},
  };
}
