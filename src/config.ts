import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface Route {
  id: string;
  domain: string;
  target: number;
  enabled: boolean;
}

export function getRoutes(): Route[] {
  const config = vscode.workspace.getConfiguration('localias');
  return config.get<Route[]>('routes') ?? [];
}

export function getEnabledRoutes(): Route[] {
  return getRoutes().filter(r => r.enabled);
}

export async function addRoute(domain: string, target: number, enabled = true): Promise<void> {
  const config = vscode.workspace.getConfiguration('localias');
  const routes = [...getRoutes()];
  routes.push({ id: crypto.randomUUID(), domain, target, enabled });
  await config.update('routes', routes, vscode.ConfigurationTarget.Global);
}

export async function updateRoute(id: string, updates: Partial<Pick<Route, 'domain' | 'target' | 'enabled'>>): Promise<void> {
  const config = vscode.workspace.getConfiguration('localias');
  const routes = getRoutes().map(r => r.id === id ? { ...r, ...updates } : r);
  await config.update('routes', routes, vscode.ConfigurationTarget.Global);
}

/**
 * Enable a route, auto-disabling any other enabled routes that share the same domain.
 * Returns the domains of disabled conflicting routes (empty if none).
 */
export async function enableRouteResolvingConflicts(routeId: string): Promise<string[]> {
  const route = getRoutes().find(r => r.id === routeId);
  if (!route) return [];

  const domain = route.domain.toLowerCase();
  const conflicting = getEnabledRoutes().filter(
    r => r.id !== routeId && r.domain.toLowerCase() === domain,
  );

  for (const r of conflicting) {
    await updateRoute(r.id, { enabled: false });
  }
  await updateRoute(routeId, { enabled: true });

  return conflicting.map(r => `${r.domain} → :${r.target}`);
}

export async function removeRoute(id: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('localias');
  const routes = getRoutes().filter(r => r.id !== id);
  await config.update('routes', routes, vscode.ConfigurationTarget.Global);
}

export async function clearAllRoutes(): Promise<void> {
  const config = vscode.workspace.getConfiguration('localias');
  await config.update('routes', [], vscode.ConfigurationTarget.Global);
}

export async function reorderRoutes(orderedIds: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('localias');
  const routeMap = new Map(getRoutes().map(r => [r.id, r]));
  const routes = orderedIds.map(id => routeMap.get(id)).filter((r): r is Route => r !== undefined);
  await config.update('routes', routes, vscode.ConfigurationTarget.Global);
}
