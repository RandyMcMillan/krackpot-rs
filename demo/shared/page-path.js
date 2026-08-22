export function resolveHref(relativePath, baseHref = window.location.href) {
  const url = new URL(relativePath, baseHref);
  return `${url.pathname}${url.search}${url.hash}`;
}
