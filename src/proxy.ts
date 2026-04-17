import * as http2 from 'http2';
import * as http from 'http';
import * as fs from 'fs';
import * as net from 'net';
import * as tls from 'tls';
import { IS_WINDOWS } from './constants';
import type { CertPair } from './cert';
import type { Route } from './config';
import { renderLoopDetected, renderRouteDisabled, renderRouteNotConfigured, renderBadGateway, renderProxyError } from './pages';

/** HTTP/1.1 hop-by-hop headers that are invalid in HTTP/2 responses. */
const HOP_BY_HOP_HEADERS = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'];

/**
 * Custom DNS lookup that always resolves to loopback addresses (127.0.0.1 + ::1).
 * Bypasses the system resolver to avoid proxy tools (Surge, ClashX in Fake IP mode)
 * hijacking `localhost` to a fake IP like 198.18.x.x.
 *
 * Used with `autoSelectFamily: true` so Node tries IPv4 first, then IPv6
 * (Happy Eyeballs / RFC 8305) — works whether the upstream listens on either or both.
 */
const loopbackLookup: net.LookupFunction = (_hostname, options, callback) => {
  if (options.all) {
    callback(null, [
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
  } else if (options.family === 6) {
    callback(null, '::1', 6);
  } else {
    callback(null, '127.0.0.1', 4);
  }
};

/** Create a TCP connection to a local port, bypassing DNS. */
function createLoopbackConnection(port: number): net.Socket {
  const sock = net.createConnection({
    host: 'localhost',
    port,
    lookup: loopbackLookup,
    autoSelectFamily: true,
  });
  return sock;
}

export class ProxyServer {
  private static readonly LOOP_HEADER = 'x-localias-loop';
  private h2Server: http2.Http2SecureServer | undefined;
  private plainServer: http.Server | undefined;
  private wrapper: net.Server | undefined;
  private httpRedirectServer: http.Server | undefined;
  private _isRunning = false;
  private sockets = new Set<net.Socket>();

  constructor(
    private certs: CertPair,
    private routes: Route[],
    private allRoutes: Route[],
    readonly listenPort: number,
    private sniCallback?: (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void,
    private onEnableRoute?: (routeId: string) => void,
  ) {}

  get isRunning(): boolean {
    return this._isRunning;
  }

  async start(): Promise<void> {
    // Include CA cert in chain so curl / Node fetch / Electron can verify
    const serverCert = fs.readFileSync(this.certs.cert);
    const serverKey = fs.readFileSync(this.certs.key);
    const caCert = this.certs.ca ? fs.readFileSync(this.certs.ca) : undefined;

    // ── HTTP/2 + HTTPS server (also handles HTTP/1.1 via allowHTTP1) ──
    this.h2Server = http2.createSecureServer(
      {
        cert: caCert ? Buffer.concat([serverCert, caCert]) : serverCert,
        key: serverKey,
        allowHTTP1: true,
        // Per-domain certs via SNI callback (memory cache → disk → mkcert)
        ...(this.sniCallback ? { SNICallback: this.sniCallback } : {}),
        // Browsers send bursts of RST_STREAM during HMR hot-updates and
        // page navigations. Node's default threshold is very low and will
        // GOAWAY the entire session after ~200 cumulative resets.
        // Raise limit to survive typical Vite/webpack dev workflows.
        // Available in Node 22.11+; silently ignored on older versions.
        ...({ streamResetBurst: 10000, streamResetRate: 100 } as Record<string, unknown>),
      },
      (req, res) => {
        req.stream?.on('error', () => {}); // absorb RST_STREAM per-stream errors
        this.handleRequest(req, res);
      },
    );

    // Absorb HTTP/2 session-level errors (e.g. premature client disconnect)
    this.h2Server.on('sessionError', () => {});

    // WebSocket upgrades (HTTP/1.1 only, transparent with allowHTTP1)
    this.h2Server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      this.handleUpgrade(req, socket, head);
    });

    // ── Plain HTTP server (redirect to HTTPS) ──
    const httpsPort = this.listenPort;
    this.plainServer = http.createServer((req, res) => {
      const host = (req.headers.host ?? '').split(':')[0];
      const portSuffix = httpsPort === 443 ? '' : `:${httpsPort}`;
      const location = `https://${host}${portSuffix}${req.url ?? '/'}`;
      res.writeHead(302, { Location: location });
      res.end();
    });

    // Drop plain-HTTP WebSocket upgrades with a warning
    this.plainServer.on('upgrade', (_req: http.IncomingMessage, socket: net.Socket) => {
      socket.destroy();
    });

    // ── Single-port TLS/plain demux wrapper ──
    // Peek at the first byte: 0x16 = TLS ClientHello → h2Server, else → plainServer (302 redirect).
    // This eliminates the need for a separate port 80 listener.
    this.wrapper = net.createServer((socket) => {
      // Track all sockets so we can forcibly destroy them on stop().
      // h2Server/plainServer receive connections via emit('connection'),
      // so their closeAllConnections() is a no-op.
      this.sockets.add(socket);
      socket.on('close', () => { this.sockets.delete(socket); });

      // Absorb early connection errors (ECONNRESET, EPIPE from abrupt disconnects)
      socket.on('error', () => { socket.destroy(); });

      socket.once('readable', () => {
        const buf: Buffer | null = socket.read(1);
        if (!buf) { socket.destroy(); return; }
        socket.unshift(buf);

        if (buf[0] === 0x16) {
          // TLS ClientHello → route to HTTP/2 secure server
          this.h2Server!.emit('connection', socket);
        } else {
          // Plain HTTP → route to redirect server
          this.plainServer!.emit('connection', socket);
        }
      });
    });

    // ── Separate port 80 redirect server (best-effort) ──
    // When the proxy listens on a non-80 port (e.g. 443), start a plain HTTP
    // server on port 80 so that http://domain/ (default port 80) gets a 302
    // redirect to https://domain/. If port 80 is unavailable, skip silently.
    if (this.listenPort !== 80) {
      this.httpRedirectServer = http.createServer((req, res) => {
        const host = (req.headers.host ?? '').split(':')[0];
        const portSuffix = httpsPort === 443 ? '' : `:${httpsPort}`;
        const location = `https://${host}${portSuffix}${req.url ?? '/'}`;
        res.writeHead(302, { Location: location });
        res.end();
      });
      this.httpRedirectServer.on('error', () => {
        // Port 80 unavailable — silently skip; main proxy still works.
        this.httpRedirectServer?.close();
        this.httpRedirectServer = undefined;
      });
      this.httpRedirectServer.listen(80);
    }

    return new Promise<void>((resolve, reject) => {
      this.wrapper!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EACCES') {
          const hint = IS_WINDOWS
            ? `On Windows, run "netsh http add urlacl url=https://+:${this.listenPort}/ user=Everyone" in an admin terminal, or use a port > 1024 via localias.listenPort setting.`
            : `On macOS (Mojave+), binding to privileged ports works on 0.0.0.0 but not 127.0.0.1. The proxy listens on all interfaces by default, so this should not happen. If it does, try a port > 1024 via localias.listenPort setting.`;
          reject(new Error(
            `Permission denied for port ${this.listenPort}. ${hint}`,
          ));
        } else if (err.code === 'EADDRINUSE') {
          const wrapped: NodeJS.ErrnoException = new Error(`Port ${this.listenPort} is already in use.`);
          wrapped.code = 'EADDRINUSE';
          reject(wrapped);
        } else {
          reject(err);
        }
      });

      // Listen on all interfaces (0.0.0.0) — macOS Mojave+ allows non-root
      // binding to privileged ports on all interfaces, just not on specific ones like 127.0.0.1.
      this.wrapper!.listen(this.listenPort, () => {
        this._isRunning = true;
        resolve();
      });
    });
  }

  stop(): void {
    // Forcibly destroy all tracked sockets. Since h2Server/plainServer never
    // call listen() (they receive sockets via emit('connection')), their
    // closeAllConnections() is a no-op. We must destroy sockets ourselves.
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.h2Server?.close();
    this.h2Server = undefined;
    this.plainServer?.close();
    this.plainServer = undefined;
    this.wrapper?.close();
    this.wrapper = undefined;
    this.httpRedirectServer?.close();
    this.httpRedirectServer = undefined;
    this._isRunning = false;
  }

  /** Hot-update routes without restarting the server (preserves all connections). */
  updateRoutes(enabledRoutes: Route[], allRoutes: Route[]): void {
    this.routes = enabledRoutes;
    this.allRoutes = allRoutes;
  }

  private findRoute(hostname: string): Route | undefined {
    // Exact match first
    const exact = this.routes.find(r => r.domain === hostname);
    if (exact) return exact;

    // Wildcard match: *.example.com matches sub.example.com
    for (const route of this.routes) {
      if (route.domain.startsWith('*.')) {
        const suffix = route.domain.slice(1); // .example.com
        if (hostname.endsWith(suffix) && hostname.indexOf('.') === hostname.length - suffix.length) {
          return route;
        }
      }
    }

    return undefined;
  }

  private handleRequest(req: http2.Http2ServerRequest, res: http2.Http2ServerResponse): void {
    // Loop detection: if we see our own marker header, the request looped back
    if (req.headers[ProxyServer.LOOP_HEADER]) {
      res.writeHead(508, { 'Content-Type': 'text/html' });
      res.end(renderLoopDetected());
      return;
    }

    const hostHeader = (req.headers.host ?? req.headers[':authority'] ?? '') as string;
    const host = hostHeader.split(':')[0];

    // Internal API: handle before route matching (works on any domain)
    if (req.url?.startsWith('/__localias__/api/')) {
      this.handleInternalApi(req, res, host);
      return;
    }

    const route = this.findRoute(host);

    if (!route) {
      // Check if there are disabled routes for this domain (exact + wildcard)
      const disabledRoutes = this.allRoutes.filter(r => {
        if (r.enabled) return false;
        if (r.domain.toLowerCase() === host.toLowerCase()) return true;
        if (r.domain.startsWith('*.')) {
          const suffix = r.domain.slice(1); // .example.com
          if (host.endsWith(suffix) && host.indexOf('.') === host.length - suffix.length) return true;
        }
        return false;
      });
      res.writeHead(404, { 'Content-Type': 'text/html' });
      if (disabledRoutes.length > 0) {
        res.end(renderRouteDisabled(host, disabledRoutes, this.listenPort));
      } else {
        res.end(renderRouteNotConfigured(host, this.routes, this.listenPort));
      }
      return;
    }

    // Forward headers: strip HTTP/2 pseudo-headers, inject loop marker + X-Forwarded-*
    const forwardHeaders: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!key.startsWith(':')) {
        forwardHeaders[key] = value;
      }
    }
    forwardHeaders.host = hostHeader || host;
    forwardHeaders[ProxyServer.LOOP_HEADER] = '1';
    forwardHeaders['x-forwarded-proto'] = 'https';
    forwardHeaders['x-forwarded-host'] = hostHeader || host;
    forwardHeaders['x-forwarded-for'] = req.socket.remoteAddress ?? '127.0.0.1';

    // Rewrite Origin / Referer so backends see the local upstream address
    // and don't reject the request with a CORS origin mismatch.
    const backendOrigin = `http://localhost:${route.target}`;
    if (forwardHeaders.origin) forwardHeaders.origin = backendOrigin;
    if (forwardHeaders.referer) {
      try {
        const parsed = new URL(forwardHeaders.referer as string);
        parsed.protocol = 'http:';
        parsed.hostname = 'localhost';
        parsed.port = String(route.target);
        forwardHeaders.referer = parsed.href;
      } catch { /* malformed Referer — leave as-is */ }
    }

    const proxyReq = http.request(
      {
        hostname: 'localhost',
        port: route.target,
        path: req.url,
        method: req.method,
        headers: forwardHeaders,
        createConnection: () => createLoopbackConnection(route.target),
      },
      (proxyRes) => {
        const headers = { ...proxyRes.headers };
        // Strip hop-by-hop headers for HTTP/2 clients
        if (req.httpVersion === '2.0') {
          for (const h of HOP_BY_HOP_HEADERS) {
            delete headers[h];
          }
        }
        // TODO: rename header if the project is renamed
        headers['x-localias'] = '1';
        res.writeHead(proxyRes.statusCode ?? 502, headers);
        proxyRes.on('error', () => {
          // Mid-stream error: headers already sent, destroy to send RST_STREAM
          // instead of res.end() which causes content-length mismatch
          res.destroy();
        });
        proxyRes.pipe(res, { end: true });
      },
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        const code = (err as NodeJS.ErrnoException).code;
        const isConnRefused = code === 'ECONNREFUSED';
        res.writeHead(502, { 'Content-Type': 'text/html' });
        if (isConnRefused) {
          // Find other disabled routes for the same domain that the user could switch to
          const alternatives = this.allRoutes.filter(
            r => !r.enabled && r.domain.toLowerCase() === host.toLowerCase() && r.target !== route.target,
          );
          res.end(renderBadGateway(route.target, true, alternatives, this.listenPort));
        } else {
          res.end(renderProxyError(err.message));
        }
      } else {
        res.destroy();
      }
    });

    // Abort backend request if client disconnects (tab close, navigation, HMR)
    res.on('close', () => { if (!proxyReq.destroyed) proxyReq.destroy(); });

    req.pipe(proxyReq, { end: true });
  }

  private handleUpgrade(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    clientSocket.on('error', () => clientSocket.destroy());

    const host = (req.headers.host ?? '').split(':')[0];
    const route = this.findRoute(host);

    if (!route) {
      clientSocket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }

    // Loop detection (same as handleRequest)
    if (req.headers[ProxyServer.LOOP_HEADER]) {
      clientSocket.end('HTTP/1.1 508 Loop Detected\r\n\r\n');
      return;
    }

    // Strip HTTP/2 pseudo-headers before forwarding
    const proxyReqHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    for (const key of Object.keys(proxyReqHeaders)) {
      if (key.startsWith(':')) delete proxyReqHeaders[key];
    }
    proxyReqHeaders[ProxyServer.LOOP_HEADER] = '1';

    const proxyReq = http.request({
      hostname: 'localhost',
      port: route.target,
      path: req.url,
      method: req.method,
      headers: proxyReqHeaders,
      createConnection: () => createLoopbackConnection(route.target),
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      // Forward the backend's actual 101 response with original header casing
      let response = `HTTP/1.1 101 Switching Protocols\r\n`;
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        response += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
      }
      response += '\r\n';
      clientSocket.write(response);

      if (proxyHead.length > 0) {
        clientSocket.write(proxyHead);
      }

      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);

      // Comprehensive cleanup: close/end/error on either side tears down both
      const cleanup = () => {
        proxySocket.destroy();
        clientSocket.destroy();
      };
      proxySocket.on('error', cleanup);
      proxySocket.on('close', cleanup);
      proxySocket.on('end', cleanup);
      clientSocket.on('close', cleanup);
      clientSocket.on('end', cleanup);
    });

    // Backend responded with normal HTTP instead of upgrading (e.g. 401/403)
    proxyReq.on('response', (res) => {
      if (!clientSocket.destroyed) {
        let response = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          response += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
        }
        response += '\r\n';
        clientSocket.write(response);
        res.on('error', () => clientSocket.destroy());
        res.pipe(clientSocket);
      }
    });

    proxyReq.on('error', () => {
      clientSocket.destroy();
    });

    if (head.length > 0) {
      proxyReq.write(head);
    }
    proxyReq.end();
  }

  private handleInternalApi(req: http2.Http2ServerRequest, res: http2.Http2ServerResponse, host: string): void {
    const url = new URL(req.url!, `https://${host}`);

    if (url.pathname === '/__localias__/api/enable' && req.method === 'POST') {
      const routeId = url.searchParams.get('id');
      if (!routeId) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing route id');
        return;
      }

      const route = this.allRoutes.find(r => r.id === routeId);
      if (!route || route.enabled) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Route not found or already enabled');
        return;
      }

      // Optimistically update in-memory routes so the redirect sees the route active.
      // Auto-disable conflicting routes with the same domain.
      // The callback persists to config asynchronously (triggers updateRoutes later).
      const enabledRoute = { ...route, enabled: true };
      const domainKey = route.domain.toLowerCase();
      this.allRoutes = this.allRoutes.map(r => {
        if (r.id === routeId) return enabledRoute;
        if (r.enabled && r.domain.toLowerCase() === domainKey) return { ...r, enabled: false };
        return r;
      });
      this.routes = [
        ...this.routes.filter(r => r.domain.toLowerCase() !== domainKey),
        enabledRoute,
      ];

      this.onEnableRoute?.(routeId);
      const portSuffix = this.listenPort === 443 ? '' : `:${this.listenPort}`;
      res.writeHead(303, { Location: `https://${host}${portSuffix}/` });
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}
