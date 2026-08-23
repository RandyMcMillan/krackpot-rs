export function summarizeGitProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    return { text: 'progress', phase: '', percent: null };
  }

  const phase = String(progress.phase || progress.message || progress.status || progress.stage || '').trim();
  const loaded = Number(progress.loaded ?? progress.completed ?? progress.current);
  const total = Number(progress.total ?? progress.length ?? progress.expected);

  let percent = null;
  let counts = '';
  if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
    percent = Math.min(100, Math.max(0, Math.floor((loaded / total) * 100)));
    counts = `${loaded}/${total} (${percent}%)`;
  } else if (Number.isFinite(loaded) && Number.isFinite(total)) {
    counts = `${loaded}/${total}`;
  } else if (Number.isFinite(loaded)) {
    counts = `${loaded}`;
  }

  const text = [phase, counts].filter(Boolean).join(' ');
  return { text: text || 'progress', phase, percent };
}

function progressBucket(info) {
  return info.percent === null ? null : Math.floor(info.percent / 5);
}

/**
 * Build a small progress reporter that deduplicates repeated progress events.
 * The browser UI logs the returned message at trace level so the footer stays
 * readable while still showing clone/fetch activity like native git.
 */
export function createGitProgressReporter(repoName, operation, context = '') {
  const state = { signature: null, bucket: null, phase: '' };
  const contextLabel = String(context || '').trim();
  const prefix = contextLabel ? `${repoName} ${operation} (${contextLabel})` : `${repoName} ${operation}`;

  return (progress, done = false) => {
    const info = summarizeGitProgress(progress);
    const bucket = progressBucket(info);
    const signature = `${info.phase}|${bucket}|${info.text}`;

    if (!done && state.signature === signature) {
      return null;
    }

    if (!done && bucket !== null && state.bucket === bucket && state.phase === info.phase) {
      return null;
    }

    state.signature = signature;
    state.bucket = bucket;
    state.phase = info.phase;

    return `${prefix}${done ? ' complete' : `: ${info.text}`}`;
  };
}
