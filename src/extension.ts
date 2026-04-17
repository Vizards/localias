import * as vscode from 'vscode';
import { CertManager } from './cert';
import { StatusBarManager } from './status-bar';
import { RoutesTreeProvider, ForwardedPortsTreeProvider, RouteDecorationProvider } from './views';
import { PortForwardingWatcher } from './port';
import { getRoutes, getEnabledRoutes, updateRoute, enableRouteResolvingConflicts } from './config';
import { HostsManager } from './hosts';
import { registerAll, autoRestart, injectNodeExtraCACerts, type Deps } from './commands';
import { errMsg } from './constants';
import { cmdStart } from './commands/proxy';

let deps: Deps | undefined;

export function activate(context: vscode.ExtensionContext) {
  const certManager = new CertManager(context);
  const statusBar = new StatusBarManager();
  const routesTree = new RoutesTreeProvider();
  const routeDecorations = new RouteDecorationProvider();
  const portsTree = new ForwardedPortsTreeProvider();
  const portWatcher = new PortForwardingWatcher();
  const hostsManager = new HostsManager(context);

  deps = {
    proxy: { current: undefined },
    statusBar,
    certManager,
    routesTree,
    portsTree,
    portWatcher,
    hostsManager,
  };

  // Register tree views
  const routesView = vscode.window.createTreeView('localias.routes', {
    treeDataProvider: routesTree,
    dragAndDropController: routesTree.dragAndDropController,
  });
  routesTree.registerView(routesView);
  routesTree.registerDecorationProvider(routeDecorations);
  vscode.window.registerFileDecorationProvider(routeDecorations);
  const portsView = vscode.window.createTreeView('localias.ports', {
    treeDataProvider: portsTree,
    canSelectMany: true,
  });

  // Track routes auto-disabled due to port going offline (vs user manually disabling)
  const autoDisabledRoutes = new Set<string>();

  // Port watcher → update ports tree + auto-disable/re-enable routes
  portWatcher.onDidChangePorts((ports) => {
    portsTree.setPorts(ports);

    const listeningPorts = new Set(ports.map(p => p.localPort));

    // Auto-disable enabled routes whose target port stopped listening
    const toDisable: string[] = [];
    for (const route of getEnabledRoutes()) {
      if (!listeningPorts.has(route.target)) {
        autoDisabledRoutes.add(route.id);
        toDisable.push(route.id);
      }
    }

    // Re-enable routes that were auto-disabled and whose port is back
    const toEnable: string[] = [];
    for (const routeId of autoDisabledRoutes) {
      const route = getRoutes().find(r => r.id === routeId);
      if (!route) {
        autoDisabledRoutes.delete(routeId);
        continue;
      }
      if (listeningPorts.has(route.target)) {
        autoDisabledRoutes.delete(routeId);
        toEnable.push(route.id);
      }
    }

    // Batch updates sequentially to avoid concurrent config writes
    (async () => {
      for (const id of toDisable) await updateRoute(id, { enabled: false });
      for (const id of toEnable) {
        const disabled = await enableRouteResolvingConflicts(id);
        if (disabled.length > 0) {
          const route = getRoutes().find(r => r.id === id);
          vscode.window.showInformationMessage(
            `Re-enabled "${route?.domain}". Auto-disabled conflicting route(s): ${disabled.join(', ')}`,
          );
        }
      }
    })();
  });
  portWatcher.startWatching();

  // Watch config changes to refresh views & auto-restart proxy
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('localias.routes')) {
      routesTree.refresh();
      portsTree.refresh();

      // Auto-restart proxy so new routes + certs take effect immediately
      if (deps?.proxy.current?.isRunning) {
        autoRestart(deps);
      }
    }

    if (e.affectsConfiguration('localias.portBlacklist')) {
      deps?.portWatcher.refreshPorts();
    }

    // When switching hostsWriteMode, eagerly apply the permission change
    if (e.affectsConfiguration('localias.hostsWriteMode')) {
      const mode = vscode.workspace.getConfiguration('localias')
        .get<string>('hostsWriteMode') ?? 'sudo-prompt';
      if (mode === 'sudo-prompt') {
        hostsManager.restorePermissions().catch((err: unknown) => {
          vscode.window.showWarningMessage(`Failed to restore hosts file permissions: ${errMsg(err)}`);
          // Revert setting back to chmod since restore failed
          vscode.workspace.getConfiguration('localias')
            .update('hostsWriteMode', 'chmod', vscode.ConfigurationTarget.Global);
        });
      } else if (mode === 'chmod') {
        hostsManager.acquireChmodAccess().catch((err: unknown) => {
          vscode.window.showWarningMessage(`Failed to acquire hosts file access: ${errMsg(err)}`);
          // Revert setting back to sudo-prompt since chmod failed
          vscode.workspace.getConfiguration('localias')
            .update('hostsWriteMode', 'sudo-prompt', vscode.ConfigurationTarget.Global);
        });
      }
    }
  });

  registerAll(context, deps);

  context.subscriptions.push(
    routesView,
    portsView,
    statusBar,
    portWatcher,
  );

  // Sync hosts on activate — consistency check (reads first, skips if already in sync)
  hostsManager.syncQuietly(getRoutes().map(r => r.domain));

  // Inject NODE_EXTRA_CA_CERTS into VS Code integrated terminals so that
  // Node.js / curl / etc. trust the mkcert CA automatically.
  injectNodeExtraCACerts(context, certManager);

  vscode.commands.executeCommand('setContext', 'localias:isRunning', false);

  const config = vscode.workspace.getConfiguration('localias');
  if (config.get<boolean>('autoStart')) {
    cmdStart(deps);
  }
}

export function deactivate() {
  deps?.proxy.current?.stop();
  deps?.hostsManager?.cleanupQuietly();
}


