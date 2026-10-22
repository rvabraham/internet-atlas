export function canonicalSourceUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^old\.reddit\.com$/, 'reddit.com');
    if (host === 'news.ycombinator.com' && url.pathname === '/item') return /^\d+$/.test(url.searchParams.get('id') || '') ? `hn:${url.searchParams.get('id')}` : null;
    if (host === 'github.com') return `github:${url.pathname.replace(/\/$/, '').toLowerCase()}${/^#issuecomment-\d+$/.test(url.hash) ? url.hash : ''}`;
    if (['x.com', 'twitter.com'].includes(host)) {
      const status = url.pathname.match(/\/status\/(\d+)/)?.[1];
      if (status) return `x:${status}`;
    }
    url.hash = ''; url.protocol = 'https:'; url.hostname = host;
    for (const name of [...url.searchParams.keys()]) if (/^utm_|^(ref|s|t|fbclid)$/.test(name)) url.searchParams.delete(name);
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

export function citedSourceIds(text, records) {
  return [...new Set(citedSourceOccurrences(text, records))];
}

export function citedSourceOccurrences(text, records, complete = true) {
  const index = new Map(records.map(record => [canonicalSourceUrl(record.url), record.id]).filter(([url]) => url));
  const found = [];
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"\]\)]+/g)) {
    // A streamed URL is not a citation until its closing boundary has arrived.
    if (!complete && match.index + match[0].length === text.length) continue;
    const id = index.get(canonicalSourceUrl(match[0].replace(/[.,;!?]+$/, '')));
    if (id) found.push(id);
  }
  return found;
}
