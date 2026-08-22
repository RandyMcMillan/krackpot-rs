export function remoteTagNames(serverRefs) {
  if (!Array.isArray(serverRefs)) return [];
  return [...new Set(
    serverRefs
      .map((entry) => String(entry?.ref || ''))
      .filter((ref) => ref.startsWith('refs/tags/'))
      .map((ref) => ref.replace('refs/tags/', '').replace(/\^\{\}$/u, ''))
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}
