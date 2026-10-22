const withheldStatuses = new Set(['deleted', 'removed', 'private', 'withdrawn', 'opted-out', 'optedout', 'redacted', 'unavailable']);
const withheldFlags = ['deleted', 'removed', 'opted_out', 'optedOut', 'optOut', 'redacted', 'withdrawn', 'private', 'unavailable', 'is_deleted', 'is_removed', 'is_opted_out', 'is_redacted', 'is_withdrawn', 'is_private', 'is_unavailable', 'synthetic', 'is_synthetic'];
const trueFlag = value => value === true || value === 1 || typeof value === 'string' && /^(?:true|1|yes)$/i.test(value.trim());

/** Public closed/resolved posts remain context. Withdrawn content is never shown. */
export function sourceVisible(source) {
  if (!source || typeof source !== 'object') return false;
  const status = String(source.status || '').trim().toLowerCase().replace(/[_ ]/g, '-');
  return !withheldStatuses.has(status) && !withheldFlags.some(key => trueFlag(source[key]))
    && !/^(?:\[deleted\]|\[removed\]|deleted)$/i.test(String(source.author || '').trim());
}
