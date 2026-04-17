import type { ProxyServer } from '../proxy';
import type { CertManager } from '../cert';
import type { StatusBarManager } from '../status-bar';
import type { RoutesTreeProvider, ForwardedPortsTreeProvider } from '../views';
import type { PortForwardingWatcher } from '../port';
import type { HostsManager } from '../hosts';

export interface Deps {
  proxy: { current: ProxyServer | undefined };
  statusBar: StatusBarManager;
  certManager: CertManager;
  routesTree: RoutesTreeProvider;
  portsTree: ForwardedPortsTreeProvider;
  portWatcher: PortForwardingWatcher;
  hostsManager: HostsManager;
}
