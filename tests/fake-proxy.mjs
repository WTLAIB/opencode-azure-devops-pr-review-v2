// A forward proxy for exact-host fixtures: HTTPS through CONNECT tunnels and
// plain HTTP in absolute form, optionally requiring Basic credentials. It
// records what a real proxy sees: tunnel targets and Proxy-Authorization, never
// the TLS content inside a tunnel.
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';

const REQUIRED = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\n\r\n';

/** @param {{credentials?: string}} [options] "user:password" the proxy demands */
export async function fakeProxy({ credentials } = {}) {
  const events = [];
  const sockets = new Set();
  const expected = credentials ? 'Basic ' + Buffer.from(credentials, 'utf8').toString('base64') : null;
  const allowed = header => !expected || header === expected;
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const server = http.createServer((request, response) => {
    const header = request.headers['proxy-authorization'] ?? null;
    events.push({ type: 'http', target: request.url, proxyAuthorization: header });
    if (!allowed(header)) { response.writeHead(407, { 'proxy-authenticate': 'Basic realm="fixture"' }); response.end(); return; }
    const target = new URL(request.url);
    const headers = { ...request.headers, host: target.host };
    delete headers['proxy-authorization'];
    const upstream = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: request.method, headers }, answer => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  server.on('connect', (request, socket, head) => {
    track(socket);
    const header = request.headers['proxy-authorization'] ?? null;
    events.push({ type: 'connect', target: request.url, proxyAuthorization: header, authorization: request.headers.authorization ?? null });
    if (!allowed(header)) { socket.end(REQUIRED); return; }
    const split = request.url.lastIndexOf(':');
    const upstream = track(net.connect(Number(request.url.slice(split + 1)), request.url.slice(0, split).replace(/^\[|\]$/g, ''), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    }));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    events,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
