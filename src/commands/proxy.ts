import * as vscode from 'vscode';
import { ProxyServer } from '../proxy';
import { getEnabledRoutes, getRoutes, updateRoute, enableRouteResolvingConflicts } from '../config';
import { findConflictRouteIds } from './validate';
import { errMsg } from '../constants';
import type { Deps } from './deps';

let restartTimer: ReturnType<typeof setTimeout> | undefined;

export async function cmdStart(deps: Deps) {
  if (deps.proxy.current?.isRunning) {
    vscode.window.showInformationMessage('Localias is already running.');
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

  try {
    const certDomains = enabledRoutes.length > 0
      ? enabledRoutes.map(r => r.domain)
      : ['localhost'];
    await deps.certManager.ensurePreflight();
    const certs = await deps.certManager.ensureCerts(certDomains);
    const listenPort = vscode.workspace.getConfiguration('localias').get<number>('listenPort') ?? 443;

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
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const listenPort = vscode.workspace.getConfiguration('localias').get<number>('listenPort') ?? 443;
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
  if (!deps.proxy.current?.isRunning) {
    vscode.window.showInformationMessage('Localias is not running.');
    return;
  }

  deps.proxy.current.stop();
  deps.proxy.current = undefined;
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
      } else {
        // Hot-update: just swap the route lists, connections stay alive
        proxy.updateRoutes(enabledRoutes, getRoutes());
      }

      deps.statusBar.setRunning(enabledRoutes.length);
    } catch (err: unknown) {
      deps.statusBar.setStopped();
      deps.routesTree.setRunning(false);
      vscode.commands.executeCommand('setContext', 'localias:isRunning', false);
      vscode.window.showErrorMessage(`Failed to restart Localias: ${errMsg(err)}`);
    }
  }, 500);
}
