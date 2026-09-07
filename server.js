// Lane Sprint — static file + /api time + /ws WebSocket server (Node 18+).
'use strict';

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, sep } from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.opus': 'audio/ogg',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8',
};

function mime(p) { return MIME[extname(p).toLowerCase()] || 'application/octet-stream'; }

function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(payload),
		'Cache-Control': 'no-store',
	});
	res.end(payload);
}

/** Resolve a request path inside ROOT, rejecting traversal attempts. */
function resolvePath(pathname) {
	let p;
	try { p = decodeURIComponent(pathname); } catch (_) { return null; }
	if (p.split(/[\\/]/).some(part => part.startsWith('.') && part !== '.' && part !== '..')) return null;
	if (p === '/') p = '/index.html';
	const full = normalize(join(ROOT, p));
	if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
	return full;
}

const server = createServer(async (req, res) => {
	let url;
	try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
	catch (_) { res.writeHead(400); res.end('bad request'); return; }

	if (req.method !== 'GET' && req.method !== 'HEAD') {
		res.writeHead(405, { 'Allow': 'GET, HEAD' });
		res.end('method not allowed');
		return;
	}

	if (url.pathname === '/api/v1/time') {
		sendJson(res, 200, { now: Date.now(), iso: new Date().toISOString() });
		return;
	}
	if (url.pathname.startsWith('/api/')) {
		sendJson(res, 404, { error: 'unknown endpoint' });
		return;
	}

	const full = resolvePath(url.pathname);
	if (!full) { res.writeHead(403); res.end('forbidden'); return; }

	try {
		const info = await stat(full);
		if (!info.isFile()) { res.writeHead(404); res.end('not found'); return; }
		const body = await readFile(full);
		res.writeHead(200, { 'Content-Type': mime(full), 'Content-Length': body.length });
		if (req.method === 'HEAD') res.end(); else res.end(body);
	} catch (err) {
		if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) { res.writeHead(404); res.end('not found'); return; }
		res.writeHead(500); res.end('server error');
	}
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
	ws.send(JSON.stringify({ type: 'hello', now: Date.now() }));
	ws.on('message', (raw) => {
		// All client input is untrusted: bound the payload and validate the shape.
		let msg = null;
		try { msg = JSON.parse(String(raw).slice(0, 4096)); } catch (_) { msg = null; }
		if (!msg || typeof msg.type !== 'string') { ws.send(JSON.stringify({ error: 'bad message' })); return; }
		if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', now: Date.now() }));
		else ws.send(JSON.stringify({ error: 'unsupported type' }));
	});
	ws.on('error', () => {});
});

export const httpServer = server;
export const webSocketServer = wss;
export function start(port = PORT) {
	return new Promise((resolve, reject) => {
		if (server.listening) { resolve(server.address().port); return; }
		server.once('error', reject);
		server.listen(port, () => resolve(server.address().port));
	});
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (invokedDirectly) start().catch((err) => { console.error(err); process.exitCode = 1; });
