import * as vscode from 'vscode';
import { getRoutes, getEnabledRoutes, addRoute, updateRoute, removeRoute, clearAllRoutes, enableRouteResolvingConflicts, type Route } from '../config';
import { validateDomain } from './validate';
import { pickDomain } from './pick-domain';
import { errMsg } from '../constants';

import type { Deps } from './deps';

export async function cmdAddRoute(deps: Deps) {
  const domain = await pickDomain('Domain name');
  if (!domain) return;

  // Build port picker items from listening ports
  const listeningPorts = deps.portWatcher.ports;
  const routedPorts = new Set(getRoutes().map(r => r.target));
  const unroutedPorts = listeningPorts
    .filter(p => !routedPorts.has(p.localPort))
    .map(p => p.localPort);

  const portItems: vscode.QuickPickItem[] = unroutedPorts.map(p => ({
    label: String(p),
    description: 'listening',
  }));

  const port = await new Promise<number | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.title = 'Target port';
    qp.placeholder = 'Type a port or select from listening ports';
    qp.items = portItems;
    qp.keepScrollPosition = true;

    qp.onDidChangeValue((value) => {
      const trimmed = value.trim();
      if (!trimmed) { qp.items = portItems; return; }
      if (portItems.some(i => i.label === trimmed)) {
        qp.items = portItems;
      } else {
        qp.items = [{ label: trimmed }, ...portItems];
      }
    });

    qp.onDidAccept(() => {
      const raw = (qp.selectedItems[0] ?? qp.activeItems[0])?.label ?? qp.value.trim();
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) {
        resolve(n);
        qp.hide();
      }
    });

    qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
    qp.show();
  });
  if (!port) return;

  // Sync hosts BEFORE saving the route — abort if hosts update fails
  if (!await deps.hostsManager.syncForNewRoute(domain)) return;

  await addRoute(domain, port);
}

export async function cmdEditRoute(deps: Deps, idOrItem?: string | { routeId?: string }) {
  let id: string | undefined;

  if (typeof idOrItem === 'string') {
    id = idOrItem;
  } else if (idOrItem?.routeId) {
    id = idOrItem.routeId;
  } else {
    // Called from command palette — show picker
    const routes = getRoutes();
    if (routes.length === 0) {
      vscode.window.showInformationMessage('No routes configured.');
      return;
    }
    const selected = await vscode.window.showQuickPick(
      routes.map(r => ({ label: r.domain, description: `→ :${r.target}`, id: r.id })),
      { placeHolder: 'Select route to edit' },
    );
    if (!selected) return;
    id = selected.id;
  }

  const route = getRoutes().find(r => r.id === id);
  if (!route) return;

  const input = await vscode.window.showInputBox({
    prompt: 'Edit route (domain > port)',
    value: `${route.domain} > ${route.target}`,
    validateInput: (v) => {
      const match = v.match(/^\s*(.+?)\s*>\s*(\d+)\s*$/);
      if (!match) return 'Format: domain > port  (e.g. dev.example.com > 3000)';
      const domainErr = validateDomain(match[1]);
      if (domainErr) return domainErr;
      const port = Number(match[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be 1-65535';
      return undefined;
    },
  });
  if (!input) return;

  const match = input.match(/^\s*(.+?)\s*>\s*(\d+)\s*$/)!;
  const domain = match[1];
  const target = Number(match[2]);

  const updates: Partial<Route> = {};
  if (domain !== route.domain) updates.domain = domain;
  if (target !== route.target) updates.target = target;
  if (Object.keys(updates).length === 0) return;

  // Sync hosts BEFORE saving — include new domain, exclude old if changed
  if (updates.domain) {
    const afterDomains = getRoutes().map(r => r.id === route.id ? domain : r.domain);
    try {
      await deps.hostsManager.sync(afterDomains);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(`Failed to update route: system hosts update failed. ${errMsg(err)}`);
      return;
    }
  }

  await updateRoute(route.id, updates);
}

export async function cmdToggleRoute(_deps: Deps, item?: { routeId?: string }) {
  if (!item?.routeId) return;
  const route = getRoutes().find(r => r.id === item.routeId);
  if (!route) return;

  if (!route.enabled) {
    // Enable: auto-disable conflicting routes with the same domain
    const disabled = await enableRouteResolvingConflicts(route.id);
    if (disabled.length > 0) {
      vscode.window.showInformationMessage(`Enabled "${route.domain}". Auto-disabled conflicting route(s): ${disabled.join(', ')}`);
    }
  } else {
    await updateRoute(route.id, { enabled: false });
  }
}

export async function cmdRemoveRoute(deps: Deps, item?: { routeId?: string }) {
  let route: Route | undefined;

  if (item?.routeId) {
    route = getRoutes().find(r => r.id === item.routeId);
  } else {
    // Called from command palette — show picker first
    const routes = getRoutes();
    if (routes.length === 0) {
      vscode.window.showInformationMessage('No routes configured.');
      return;
    }

    const items = routes.map(r => ({
      label: r.domain,
      description: `→ :${r.target}`,
      id: r.id,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select route to remove',
    });
    if (!selected) return;
    route = getRoutes().find(r => r.id === selected.id);
  }

  if (!route) return;

  const confirm = await vscode.window.showWarningMessage(
    `Remove route "${route.domain} → :${route.target}"?`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') return;

  // Sync hosts BEFORE removing route — abort if hosts update fails
  const remainingDomains = getRoutes().filter(r => r.id !== route.id).map(r => r.domain);
  try {
    await deps.hostsManager.sync(remainingDomains);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Failed to remove route: system hosts update failed. ${errMsg(err)}`);
    return;
  }

  await removeRoute(route.id);
}

export async function cmdClearAllRoutes(deps: Deps) {
  const routes = getRoutes();
  if (routes.length === 0) {
    vscode.window.showInformationMessage('No routes configured.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove all ${routes.length} route(s)?`,
    { modal: true },
    'Remove All',
  );
  if (confirm !== 'Remove All') return;

  // Sync hosts BEFORE clearing routes — abort if hosts update fails
  try {
    await deps.hostsManager.sync([]);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Failed to clear routes: system hosts update failed. ${errMsg(err)}`);
    return;
  }

  await clearAllRoutes();
}

export async function cmdShowRoutes() {
  const routes = getRoutes();
  if (routes.length === 0) {
    vscode.window.showInformationMessage('No routes configured.');
    return;
  }

  const items = routes.map(r => ({
    label: r.domain,
    description: `→ :${r.target}`,
  }));

  await vscode.window.showQuickPick(items, {
    placeHolder: 'Current routes (press Escape to close)',
  });
}

export async function cmdAddRouteForPort(deps: Deps, portOrItem?: number | { port?: number }) {
  let port: number | undefined;
  if (typeof portOrItem === 'number') {
    port = portOrItem;
  } else if (portOrItem?.port) {
    port = portOrItem.port;
  }

  if (port === undefined) {
    const portStr = await vscode.window.showInputBox({
      prompt: 'Port number',
      placeHolder: '5173',
    });
    if (!portStr) return;
    port = Number(portStr);
  }

  const domain = await pickDomain(`Domain name for port ${port}`);
  if (!domain) return;

  // Sync hosts BEFORE saving the route — abort if hosts update fails
  if (!await deps.hostsManager.syncForNewRoute(domain)) return;

  await addRoute(domain, port);
}
