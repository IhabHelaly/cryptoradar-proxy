// ═══════════════════════════════════════════════════════════════════════════
// CryptoRadar Binance Proxy v1
//
// A tiny Node.js HTTP server that forwards authenticated requests to Binance.
// Deploy this somewhere in a Binance-allowed region (Singapore recommended)
// so your Cloudflare Worker can reach Binance even when its own IPs are
// geo-blocked (HTTP 451).
//
// How it works:
//   1. Cloudflare Worker makes a request to https://YOUR_PROXY/binance/<path>
//   2. Worker includes header x-proxy-secret: <shared secret>
//   3. This proxy verifies the secret, strips /binance prefix, forwards to
//      https://api.binance.com/<path> with the X-MBX-APIKEY header intact
//   4. Returns Binance's response verbatim
//
// Setup:
//   - Set PROXY_SECRET env var to any random string (must match what you set
//     in your Cloudflare Worker)
//   - Optional: set PORT (defaults to 8080)
//   - Run: node index.js
//
// Security notes:
//   - PROXY_SECRET prevents random people from using your proxy
//   - The proxy never reads or stores your Binance API key/secret
//   - Only forwards X-MBX-APIKEY header; all signing happens in the worker
//   - Health check at /  (returns "alive" without auth — used for uptime checks)
// ═══════════════════════════════════════════════════════════════════════════

const http = require('http');

const PORT = process.env.PORT || 8080;
const PROXY_SECRET = process.env.PROXY_SECRET || '';

if (!PROXY_SECRET) {
  console.error('FATAL: PROXY_SECRET environment variable must be set.');
  console.error('Generate a random string and set it in your hosting platform.');
  process.exit(1);
}

if (PROXY_SECRET.length < 16) {
  console.warn('WARNING: PROXY_SECRET is short (<16 chars). Use a longer random string.');
}

const BINANCE_BASE = 'https://api.binance.com';

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  try {
    // ── Health check (no auth required) ───────────────────────────────────
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('CryptoRadar Binance Proxy v1 — alive');
      return;
    }

    // ── Authenticate ──────────────────────────────────────────────────────
    if (req.headers['x-proxy-secret'] !== PROXY_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // ── Only allow /binance/* paths ───────────────────────────────────────
    if (!req.url.startsWith('/binance/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path must start with /binance/' }));
      return;
    }

    // ── Strip /binance prefix, forward to Binance ─────────────────────────
    const binancePath = req.url.slice('/binance'.length); // keeps leading /
    const binanceUrl  = BINANCE_BASE + binancePath;

    // Collect request body (for POST endpoints like /sapi/v1/asset/get-funding-asset)
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reqBody = Buffer.concat(chunks);

    // Build headers to forward — only the Binance API key header
    const forwardHeaders = {};
    if (req.headers['x-mbx-apikey']) {
      forwardHeaders['X-MBX-APIKEY'] = req.headers['x-mbx-apikey'];
    }

    // Forward to Binance using native fetch (Node 18+)
    const binanceResp = await fetch(binanceUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: (req.method !== 'GET' && reqBody.length > 0) ? reqBody : undefined,
    });

    const respBody = await binanceResp.arrayBuffer();
    const contentType = binanceResp.headers.get('content-type') || 'application/json';

    res.writeHead(binanceResp.status, { 'Content-Type': contentType });
    res.end(Buffer.from(respBody));

    const ms = Date.now() - startTime;
    console.log(`${req.method} ${binancePath} → ${binanceResp.status} (${ms}ms)`);
  } catch (e) {
    console.error('Proxy error:', e.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`CryptoRadar Binance Proxy v1 listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
