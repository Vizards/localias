# Changelog

## 0.1.0

- Initial release
- Domain → port HTTPS reverse proxy powered by mkcert
- HTTP/2 with automatic HTTP/1.1 fallback
- WebSocket transparent proxying (HMR works out of the box)
- Wildcard domain support (`*.example.com`)
- Sidebar UI with Routes and Unrouted Ports panels
- Drag-and-drop route reordering
- Auto-detect listening ports and offer quick route creation
- Routes auto-disable when target port goes offline, re-enable when it comes back
- Automatic `/etc/hosts` management (sudo-prompt or chmod mode)
- Per-domain SNI certificates, auto-renew before expiry
- Status bar integration with one-click start/stop
- HTTP → HTTPS redirect (port 80 best-effort listener)
- `NODE_EXTRA_CA_CERTS` auto-injection into integrated terminals
- Developer-friendly error pages (502, loop detection, disabled route)
- Hot-reload routes without restarting the proxy
- Configurable TLD candidates for domain suggestions
- `loopbackDomains` setting for domains with existing DNS (e.g. `localtest.me`)
- Proxy tool compatibility (Surge/ClashX Fake IP bypass via hardcoded loopback)
- Process blacklist for Unrouted Ports panel
