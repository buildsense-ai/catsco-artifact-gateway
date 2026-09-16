// OpenSSH ProxyCommand: stdio is strictly binary SSH traffic, never logs.
import WebSocket, { createWebSocketStream } from 'ws';
const url = process.argv[2];
if (!url?.startsWith('wss://')) throw new Error('TLS transport required');
const ws = new WebSocket(url, { handshakeTimeout: 10000, perMessageDeflate: false, maxPayload: 262144, followRedirects: false });
const stream = createWebSocketStream(ws, { highWaterMark: 32768 });
let closing = false;
function finish() { if (closing) return; closing = true; process.stdin.unpipe(stream); process.stdin.destroy(); ws.terminate(); }
stream.on('error', () => { process.exitCode = 1; finish(); });
ws.on('error', () => { process.exitCode = 1; finish(); });
ws.on('close', finish);
process.stdout.on('error', finish);
process.stdin.pipe(stream).pipe(process.stdout);
process.on('SIGTERM', finish);
