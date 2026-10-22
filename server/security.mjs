export function localOnly(port) {
  return (req, res, next) => {
    let host;
    try { host = new URL(`http://${req.headers.host || ''}`).hostname; } catch { return res.status(403).json({ error: 'Local requests only.' }); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return res.status(403).json({ error: 'Local requests only.' });
    const origin = req.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.port !== String(port)) return res.status(403).json({ error: 'Origin is not allowed.' });
      } catch { return res.status(403).json({ error: 'Origin is not allowed.' }); }
    }
    next();
  };
}
