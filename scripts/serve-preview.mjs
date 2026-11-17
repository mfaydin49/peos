#!/usr/bin/env node
// Serves one HTML file at / on a loopback port: the design preview the design evaluator
// looks at (design-gate.md). The page may load nothing: no script, no network. The server
// ends on its own when the file is gone or nobody asked for half an hour.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';

const [file, port] = process.argv.slice(2);
const idleMs = 30 * 60 * 1000;
let last = Date.now();
const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" };
const server = createServer(async (request, response) => {
  last = Date.now();
  let body = null;
  if (request.method === 'GET' && new URL(request.url, 'http://localhost').pathname === '/') body = await readFile(file).catch(() => null);
  if (body === null) response.writeHead(404).end();
  else response.writeHead(200, headers).end(body);
});
server.on('error', () => process.exit(1));
if (!file || !/^\d+$/.test(port ?? '')) process.exit(2);
server.listen(Number(port), '127.0.0.1');
setInterval(async () => {
  if (Date.now() - last > idleMs || !(await stat(file).catch(() => null))?.isFile()) process.exit(0);
}, 5000);
