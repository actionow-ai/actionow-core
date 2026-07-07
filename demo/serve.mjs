// Local runner for the Actionow playground: serves the demo HTML AND proxies
// `/v1*` to the deployed gateway with permissive CORS — so the browser demo
// works TODAY, before the CORS-enabled build (v0.0.5) finishes rolling out on
// Zeabur (and works same-origin, so there is no CORS at all in the browser).
//
//   node demo/serve.mjs           # → http://localhost:8899
//   UPSTREAM=core.actionow.ai PORT=8899 node demo/serve.mjs
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8899);
const UPSTREAM = process.env.UPSTREAM || 'core.actionow.ai';
const HTML = fileURLToPath(new URL('./actionow-playground.html', import.meta.url));

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, idempotency-key, x-actionow-route-tag');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
};

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  // Serve the demo at /
  if (req.url === '/' || req.url === '/index.html' || req.url === '/actionow-playground.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(HTML));
    return;
  }
  // Proxy the API surface to the deployed gateway.
  if (/^\/(v1|v1beta)\b/.test(req.url)) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, host: UPSTREAM };
      delete headers['content-length'];
      const up = https.request(
        { hostname: UPSTREAM, port: 443, path: req.url, method: req.method, headers },
        (upRes) => {
          const h = { ...upRes.headers };
          delete h['access-control-allow-origin'];
          res.writeHead(upRes.statusCode || 502, { ...h, 'access-control-allow-origin': '*' });
          upRes.pipe(res); // streams SSE + binary just fine
        },
      );
      up.on('error', (e) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'proxy error: ' + e.message } }));
      });
      if (body.length) up.write(body);
      up.end();
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`Actionow playground → http://localhost:${PORT}  (proxying /v1 → https://${UPSTREAM})`);
});
