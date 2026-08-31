// Lane Sprint — static file + /api time + /ws WebSocket server (Node 18+).
'use strict';

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

function mime(p) {
	const e = extname(p).toLowerCase();
	if (e === '.html') return 'text/html; charset=utf-8';
	if (e === '.js' || e === '.mjs') return 'application/javascript; charset=utf-8';
	if (e === '.css') return 'text/css; charset=utf-8';
	if (e === '.json') return 'application/json; charset=utf-8';
	if (e === '.opus') return 'audio/ogg';
	return 'application/octet-stream';
}

const server = createServer((req, res) => {
	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
	let p = url.pathname;
	if (p === '/') p = '/index.html';
	const full = join(ROOT, p.slice(1));
	try {
		res.writeHead(existsSync(full) ? 200 : 404);
		res.setHeader('Content-Type', mime(full || 'index.html'));
		if (existsSync(full)) res.end(readFileSync(full)); else res.end(p === '/index.html' ? '' : 'not found');
	} catch (_) { try { res.writeHead(500); res.end('server error'); } catch {} }
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'hello' })));

export const httpServer = server;
export const webSocketServer = wss;
export function start(port = PORT) { return new Promise((resolve) => { if (!server.listening) server.listen(port, () => resolve(PORT)); else resolve(server.address().port); }); }

start();
