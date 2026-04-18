import * as vscode from 'vscode';
import { ProxyServer } from '../proxy';
import { getEnabledRoutes, getRoutes, updateRoute, enableRouteResolvingConflicts } from '../config';
import { findConflictRouteIds } from './validate';
import { errMsg } from '../constants';
import type { Deps } from './deps';

let restartTimer: ReturnType<typeof setTimeout> | undefined;

export async function cmdStart(deps: Deps) {
  // Check if proxy is already running (by us or another window)
  const state = deps.serverState.getState();
  if (state.running) {
    if (state.ownedByThisWindow && deps.proxy.current?.isRunning) {
      vscode.window.showInformationMessage('Localias is already running.');
    } else if (!state.ownedByThisWindow) {
      vscode.window.showInformationMessage('Localias is already running in another VS Code window.');
    }
    return;
  }

  let enabledRoutes = getEnabledRoutes();

  // Auto-disable duplicate-domain routes (keep first, disable rest)
  const conflictIds = findConflictRouteIds(enabledRoutes);
  if (conflictIds.length > 0) {
    for (const id of conflictIds) {
      await updateRoute(id, { enabled: false });
    }
    enabledRoutes = getEnabledRoutes();
    vscode.window.showWarningMessage(`Auto-disabled ${conflictIds.length} conflicting route(s) with duplicate domains.`);
  }

  // Claim ownership BEFORE binding port to prevent races
  const listenPort = vscode.workspace.getConfiguration('localias').get<number>('listenPort') ?? 443;
  if (!deps.serverState.claimOwnership(listenPort)) {
    vscode.window.showInformationMessage('Localias is already running in another VS Code window.');
    return;
  }

  try {
    const certDomains = enabledRoutes.length > 0
      ? enabledRoutes.map(r => r.domain)
      : ['localhost'];
    await deps.certManager.ensurePreflight();
    const certs = await deps.certManager.ensureCerts(certDomains);

    deps.proxy.current = new ProxyServer(
      certs, enabledRoutes, getRoutes(), listenPort,
      deps.certManager.createSNICallback(),
      (routeId) => { enableRouteResolvingConflicts(routeId); },
    );
    await deps.proxy.current.start();

    deps.statusBar.setRunning(enabledRoutes.length);
    deps.routesTree.setRunning(true);
    vscode.commands.executeCommand('setContext', 'localias:isRunning', true);
  } catch (err: unknown) {
    deps.serverState.releaseOwnership();

    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Re-check shared state — another Localias window may have started
      // between our ownership claim and port bind
      const currentState = deps.serverState.getState();
      if (currentState.running) {
        vscode.window.showInformationMessage('Localias is already running in another VS Code window.');
        return;
      }

      const choice = await vscode.window.showErrorMessage(
        `Port ${listenPort} is already in use.`,
        'Kill & Retry',
      );
      if (choice === 'Kill & Retry') {
        const killed = await deps.portWatcher.killByPort(listenPort);
        if (killed.length > 0) {
          await cmdStart(deps);
        } else {
          vscode.window.showErrorMessage(`Could not kill process on port ${listenPort}.`);
        }
      }
      return;
    }
    vscode.window.showErrorMessage(`Failed to start Localias: ${errMsg(err)}`);
  }
}

export async function cmdStop(deps: Deps) {
  const state = deps.serverState.getState();

  if (!state.running) {
    vscode.window.showInformationMessage('Localias is not running.');
    return;
  }

  if (state.ownedByThisWindow) {
    deps.proxy.current?.stop();
    deps.proxy.current = undefined;
    deps.serverState.releaseOwnership();
  } else {
    // Another window owns the proxy — request it to stop
    deps.serverState.requestRemoteStop();
    await new Promise(resolve => setTimeout(resolve, 2000));

    const newState = deps.serverState.getState();
    if (newState.running) {
      vscode.window.showWarningMessage(
        'The proxy is running in another VS Code window that did not respond. Please stop it from that window.',
      );
      return;
    }
  }

  deps.statusBar.setStopped();
  deps.routesTree.setRunning(false);
  vscode.commands.executeCommand('setContext', 'localias:isRunning', false);
}

/** Debounced route hot-update (or full restart if listenPort changed). */
export function autoRestart(deps: Deps) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    restartTimer = undefined;
    try {
      let enabledRoutes = getEnabledRoutes();

      // Auto-disable duplicate-domain routes (keep first, disable rest)
      const conflictIds = findConflictRouteIds(enabledRoutes);
      if (conflictIds.length > 0) {
        for (const id of conflictIds) {
          await updateRoute(id, { enabled: false });
        }
        enabledRoutes = getEnabledRoutes();
        vscode.window.showWarningMessage(`Auto-disabled ${conflictIds.length} conflicting route(s) with duplicate domains.`);
      }

      const listenPort = vscode.workspace.getConfiguration('localias').get<number>('listenPort') ?? 443;
      const proxy = deps.proxy.current;

      // Full restart only if listenPort changed or proxy not running
      if (!proxy?.isRunning || proxy.listenPort !== listenPort) {
        proxy?.stop();
        deps.proxy.current = undefined;

        const certDomains = enabledRoutes.length > 0
          ? enabledRoutes.map(r => r.domain)
          : ['localhost'];
        await deps.certManager.ensurePreflight();
        const certs = await deps.certManager.ensureCerts(certDomains);

        deps.proxy.current = new ProxyServer(
          certs, enabledRoutes, getRoutes(), listenPort,
          deps.certManager.createSNICallback(),
          (routeId) => { enableRouteResolvingConflicts(routeId); },
        );
        await deps.proxy.current.start();

        // Update lock with potentially new port
        deps.serverState.claimOwnership(listenPort);
      } else {
        // Hot-update: just swap the route lists, connections stay alive
        proxy.updateRoutes(enabledRoutes, getRoutes());
      }

      deps.statusBar.setRunning(enabledRoutes.length);
    } catch (err: unknown) {
      deps.statusBar.setStopped();
      deps.routesTree.setRunning(false);
      vscode.commands.executeCommand('setContext', 'localias:isRunning', false);
      deps.serverState.releaseOwnership();
      vscode.window.showErrorMessage(`Failed to restart Localias: ${errMsg(err)}`);
    }
  }, 500);
}
