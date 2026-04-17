import type { Route } from './config';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPage(status: number, title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${status} ${escapeHtml(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:#1a1a1a;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
.container{max-width:520px;width:100%}
.status{font-size:4rem;font-weight:700;color:#666;line-height:1}
h1{font-size:1.5rem;margin:.5rem 0 1rem;color:#fff}
.desc{color:#999;line-height:1.6;margin-bottom:1.5rem}
.routes{list-style:none;margin:0;padding:0}
.routes li{margin:0}
.routes a{display:flex;justify-content:space-between;align-items:center;
  padding:.75rem 1rem;border-radius:8px;color:#60a5fa;text-decoration:none;
  transition:background .15s}
.routes a:hover{background:#262626}
.routes .port{color:#666;font-size:.85rem;font-family:monospace}
.hint{margin-top:1.5rem;padding:1rem;border-radius:8px;background:#262626;font-size:.85rem;color:#999}
.hint code{color:#f59e0b;font-size:.85rem}
pre.code{margin-top:1rem;padding:1rem;border-radius:8px;background:#0d0d0d;
  color:#a3e635;font-size:.8rem;line-height:1.6;overflow-x:auto;white-space:pre}
.badge{display:inline-block;padding:.15rem .5rem;border-radius:4px;font-size:.75rem;font-weight:600;
  background:#7c3aed;color:#fff;margin-left:.5rem;vertical-align:middle}
</style>
</head>
<body>
<div class="container">
<div class="status">${status}</div>
<h1>${escapeHtml(title)}</h1>
${body}
</div>
</body>
</html>`;
}

export function renderLoopDetected(): string {
  return renderPage(508, 'Loop Detected', `
<p class="desc">This request looped back to Localias. This usually means your dev server
(Vite, webpack, etc.) is proxying requests back through the proxy without rewriting the Host header.</p>
<div class="hint">Fix: add <code>changeOrigin: true</code> to your proxy config
<pre class="code">proxy: {
  "/api": {
    target: "https://&lt;backend&gt;",
    changeOrigin: true,
  },
}</pre>
</div>`);
}

export function renderRouteDisabled(host: string, routes: Route[], listenPort: number): string {
  const safeHost = escapeHtml(host);
  const portSuffix = listenPort === 443 ? '' : `:${listenPort}`;
  const routeItems = routes.map(r => `
<div style="display:flex;align-items:center;gap:.75rem;padding:1rem;border-radius:8px;background:#262626;margin-bottom:.75rem">
  <span style="color:#fff;flex:1">${escapeHtml(r.domain)}</span>
  <span style="color:#666">→</span>
  <span class="port" style="flex:0 0 auto">127.0.0.1:${r.target}</span>
  <form method="POST" action="/__localias__/api/enable?id=${encodeURIComponent(r.id)}" style="margin:0">
    <button type="submit" style="padding:.4rem 1rem;border-radius:6px;border:none;background:#7c3aed;color:#fff;
      font-size:.8rem;font-weight:600;cursor:pointer;transition:background .15s;white-space:nowrap"
      onmouseover="this.style.background='#6d28d9'" onmouseout="this.style.background='#7c3aed'">Enable</button>
  </form>
</div>`).join('');

  return renderPage(404, 'Route Disabled', `
<p class="desc">The route${routes.length > 1 ? 's' : ''} for <strong style="color:#fff">${safeHost}</strong> ${routes.length > 1 ? 'exist' : 'exists'} but ${routes.length > 1 ? 'are' : 'is'} currently
<span class="badge" style="background:#ef4444">disabled</span></p>
${routeItems}
<div class="hint">Or enable from VS Code: open the Localias sidebar and click the toggle icon.</div>`);
}

export function renderRouteNotConfigured(host: string, enabledRoutes: Route[], listenPort: number): string {
  const safeHost = escapeHtml(host);
  let routesList = '';

  if (enabledRoutes.length > 0) {
    const items = enabledRoutes.map(r => {
      const portSuffix = listenPort === 443 ? '' : `:${listenPort}`;
      const href = `https://${escapeHtml(r.domain)}${portSuffix}`;
      return `<li><a href="${href}"><span>${escapeHtml(r.domain)}</span><span class="port">127.0.0.1:${r.target}</span></a></li>`;
    }).join('');
    routesList = `<p class="desc" style="margin-bottom:.75rem">Active routes:</p><ul class="routes">${items}</ul>`;
  } else {
    routesList = '<p class="desc">No active routes configured.</p>';
  }

  return renderPage(404, 'Not Found', `
<p class="desc">No route configured for <strong style="color:#fff">${safeHost}</strong></p>
${routesList}
<div class="hint">Add a route in VS Code: Command Palette → <code>Localias: Add Route</code></div>`);
}

export function renderBadGateway(port: number, isConnRefused: boolean, alternatives?: Route[], listenPort?: number): string {
  const desc = isConnRefused
    ? `Target app on port <strong style="color:#fff">${port}</strong> is not responding. It may have crashed or not started yet.`
    : `Failed to connect to target app on port <strong style="color:#fff">${port}</strong>.`;

  let altSection = '';
  if (alternatives && alternatives.length > 0 && listenPort !== undefined) {
    const items = alternatives.map(r => `
<div style="display:flex;align-items:center;gap:.75rem;padding:.75rem 1rem;border-radius:8px;background:#262626;margin-bottom:.5rem">
  <span style="color:#fff;flex:1">${escapeHtml(r.domain)}</span>
  <span style="color:#666">\u2192</span>
  <span class="port" style="flex:0 0 auto">127.0.0.1:${r.target}</span>
  <form method="POST" action="/__localias__/api/enable?id=${encodeURIComponent(r.id)}" style="margin:0">
    <button type="submit" style="padding:.4rem 1rem;border-radius:6px;border:none;background:#7c3aed;color:#fff;
      font-size:.8rem;font-weight:600;cursor:pointer;transition:background .15s;white-space:nowrap"
      onmouseover="this.style.background='#6d28d9'" onmouseout="this.style.background='#7c3aed'">Switch</button>
  </form>
</div>`).join('');
    altSection = `\n<p class="desc" style="margin-top:1.5rem;margin-bottom:.75rem">Switch to another port:</p>\n${items}`;
  }

  return renderPage(502, 'Bad Gateway', `
<p class="desc">${desc}</p>
<div class="hint">Make sure your dev server is running on port <code>${port}</code></div>${altSection}`);
}

export function renderProxyError(message: string): string {
  return renderPage(502, 'Bad Gateway', `
<p class="desc">${escapeHtml(message)}</p>`);
}
