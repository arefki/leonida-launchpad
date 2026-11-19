// Dev-only JSON-RPC proxy for local verification.
// The sandbox's headless browser cannot reach external HTTPS directly, so the app
// is verified against this localhost proxy, which forwards JSON-RPC POSTs to the
// public GIWA Sepolia RPC. It is NOT part of the deployed app: in production the
// app calls https://sepolia-rpc.giwa.io directly. Start it, then open the app with
// ?rpc=http://127.0.0.1:8545
import http from 'node:http';

const UPSTREAM = 'https://sepolia-rpc.giwa.io';
const PORT = 8545;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end('POST only'); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(90_000),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(text);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `proxy: ${e.message}` } }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`GIWA RPC proxy on http://127.0.0.1:${PORT} -> ${UPSTREAM}`);
});
