// ═══════════════════════════════════════════════════════════════════════════
// CryptoRadar Proxy v2
//
// Tiny Node.js HTTP server that forwards requests to multiple upstream APIs.
// Deploy in a permissive region (Singapore) so Cloudflare Worker can reach
// IP-restricted services even when its own egress IPs are blocked.
//
// Routes:
//   GET  /                  → health check (returns "alive", no auth)
//   ANY  /binance/<path>    → forwards to https://api.binance.com/<path>
//   GET  /coingecko/<path>  → forwards to https://api.coingecko.com/<path>  (NEW in v2)
//
// All non-health paths require x-proxy-secret header matching PROXY_SECRET env var.
//
// Setup:
//   Set PROXY_SECRET env var (Render Environment Variables tab)
//   Run: node index.js
// ═══════════════════════════════════════════════════════════════════════════

const http = require('http');

const PORT = process.env.PORT || 8080;
const PROXY_SECRET = process.env.PROXY_SECRET || '';

if (!PROXY_SECRET) {
  console.error('FATAL: PROXY_SECRET environment variable must be set.');
  process.exit(1);
}

if (PROXY_SECRET.length < 16) {
  console.warn('WARNING: PROXY_SECRET is short (<16 chars). Use a longer random string.');
}

// Upstream routing table — path prefix → upstream base URL
const UPSTREAMS = {
  '/binance/':   'https://api.binance.com',
  '/coingecko/': 'https://api.coingecko.com',
};

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  try {
    // ── Health check (no auth required) ───────────────────────────────────
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('CryptoRadar Proxy v2 — alive · binance + coingecko routing');
      return;
    }

    // ── Authenticate ──────────────────────────────────────────────────────
    if (req.headers['x-proxy-secret'] !== PROXY_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // ── Determine upstream from path prefix ───────────────────────────────
    let upstream = null;
    let prefixLen = 0;
    for (const [prefix, baseUrl] of Object.entries(UPSTREAMS)) {
      if (req.url.startsWith(prefix)) {
        upstream = baseUrl;
        prefixLen = prefix.length - 1; // keep the leading slash from the path
        break;
      }
    }
    if (!upstream) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown route prefix. supported: /binance/* /coingecko/*' }));
      return;
    }

    // Strip the matched prefix to get the upstream path
    const upstreamPath = req.url.slice(prefixLen);
    const upstreamUrl  = upstream + upstreamPath;

    // Collect request body (for POSTs)
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reqBody = Buffer.concat(chunks);

    // Build headers to forward — only API-key style headers we explicitly allow
    const forwardHeaders = {};
    if (req.headers['x-mbx-apikey'])  forwardHeaders['X-MBX-APIKEY']  = req.headers['x-mbx-apikey'];
    // CoinGecko doesn't need a special header for free tier; queries pass via query string

    const upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: (req.method !== 'GET' && reqBody.length > 0) ? reqBody : undefined,
    });

    const respBody = await upstreamResp.arrayBuffer();
    const contentType = upstreamResp.headers.get('content-type') || 'application/json';

    res.writeHead(upstreamResp.status, { 'Content-Type': contentType });
    res.end(Buffer.from(respBody));

    const ms = Date.now() - startTime;
    console.log(`${req.method} ${upstreamPath} → ${upstreamResp.status} (${ms}ms) [${upstream}]`);
  } catch (e) {
    console.error('Proxy error:', e.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`CryptoRadar Proxy v2 listening on port ${PORT}`);
  console.log(`Upstreams: ${Object.entries(UPSTREAMS).map(([p,u]) => p + ' → ' + u).join(', ')}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
