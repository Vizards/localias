import * as vscode from 'vscode';
import { getRoutes } from '../config';
import { IS_WINDOWS, errMsg } from '../constants';
import type { CertManager } from '../cert';
import type { Deps } from './deps';

export async function cmdGenerateCert(deps: Deps) {
  const domain = await vscode.window.showInputBox({
    prompt: 'Domain(s) for certificate (comma-separated)',
    placeHolder: '*.example.com, example.com',
  });
  if (!domain) return;

  const domains = domain.split(',').map(d => d.trim()).filter(Boolean);
  try {
    await deps.certManager.generateCert(domains);
    vscode.window.showInformationMessage(`Certificate generated for: ${domains.join(', ')}`);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Failed to generate certificate: ${errMsg(err)}`);
  }
}

export async function cmdRefreshPorts(deps: Deps) {
  await deps.portWatcher.refreshPorts();
}

export async function cmdSyncHosts(deps: Deps) {
  const domains = getRoutes().map(r => r.domain);
  try {
    await deps.hostsManager.sync(domains);
    vscode.window.showInformationMessage('Hosts file synced.');
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Failed to sync hosts: ${errMsg(err)}`);
  }
}

export async function cmdKillPort(
  deps: Deps,
  portOrItem?: number | { port?: number },
  selectedItems?: { port?: number }[],
) {
  // Collect ports from multi-select or single item
  const ports = new Set<number>();
  if (selectedItems && selectedItems.length > 0) {
    for (const item of selectedItems) {
      if (item.port) ports.add(item.port);
    }
  } else if (typeof portOrItem === 'number') {
    ports.add(portOrItem);
  } else if (portOrItem?.port) {
    ports.add(portOrItem.port);
  }

  if (ports.size === 0) return;

  const allPids: number[] = [];
  for (const port of ports) {
    allPids.push(...deps.portWatcher.getPidsForPort(port));
  }

  if (allPids.length === 0) {
    vscode.window.showInformationMessage(`No process found on port ${[...ports].join(', ')}.`);
    return;
  }

  const portLabel = ports.size === 1 ? `port ${[...ports][0]}` : `${ports.size} ports`;
  const confirm = await vscode.window.showWarningMessage(
    `Kill processes on ${portLabel}?`,
    { modal: true },
    'Kill',
  );
  if (confirm !== 'Kill') return;

  const killed: number[] = [];
  for (const port of ports) {
    killed.push(...await deps.portWatcher.killByPort(port));
  }

  if (killed.length > 0) {
    vscode.window.showInformationMessage(`Killed ${killed.length} process${killed.length > 1 ? 'es' : ''} on ${portLabel}.`);
  } else {
    vscode.window.showWarningMessage(`Failed to kill processes on ${portLabel}.`);
  }
}

export async function cmdHideProcess(
  deps: Deps,
  itemOrPort?: { processName?: string } | number,
  selectedItems?: { processName?: string }[],
) {
  // Collect unique process names from multi-select or single item
  const names = new Set<string>();
  if (selectedItems && selectedItems.length > 0) {
    for (const item of selectedItems) {
      if (item.processName) names.add(item.processName);
    }
  } else if (itemOrPort && typeof itemOrPort !== 'number' && itemOrPort.processName) {
    names.add(itemOrPort.processName);
  }

  if (names.size === 0) {
    vscode.window.showInformationMessage('No process name to hide.');
    return;
  }

  const nameList = [...names].sort();
  const label = nameList.length === 1 ? `"${nameList[0]}"` : `${nameList.length} processes`;
  const confirm = await vscode.window.showWarningMessage(
    `Hide ${label} from Unrouted Ports?`,
    { modal: true },
    'Hide',
  );
  if (confirm !== 'Hide') return;

  const config = vscode.workspace.getConfiguration('localias');
  const existing = config.get<string[]>('portBlacklist') ?? [];
  const merged = [...new Set([...existing, ...nameList])];
  await config.update('portBlacklist', merged, vscode.ConfigurationTarget.Global);

  // Refresh immediately
  await deps.portWatcher.refreshPorts();
}

export async function cmdOpenRoute(_deps: Deps, item?: { routeId?: string }) {
  if (!item?.routeId) return;
  const route = getRoutes().find(r => r.id === item.routeId);
  if (!route) return;

  const listenPort = vscode.workspace.getConfiguration('localias').get<number>('listenPort') ?? 443;
  const portSuffix = listenPort === 443 ? '' : `:${listenPort}`;
  const url = `https://${route.domain}${portSuffix}/`;

  try {
    // Try VS Code Simple Browser (integrated browser)
    await vscode.commands.executeCommand('simpleBrowser.show', url);
  } catch {
    // Fallback: open in external browser
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

// ── NODE_EXTRA_CA_CERTS injection ──

const CA_ENV_HINT_KEY = 'nodeExtraCACerts.hintShown';

/**
 * Inject NODE_EXTRA_CA_CERTS into all VS Code integrated terminals
 * so that Node.js processes trust the mkcert CA automatically.
 * Also shows a one-time hint notification with a copy option.
 */
export function injectNodeExtraCACerts(context: vscode.ExtensionContext, certManager: CertManager): void {
  certManager.getCARootPem().then((caPath) => {
    if (!caPath) return;

    const envCollection = context.environmentVariableCollection;
    envCollection.replace('NODE_EXTRA_CA_CERTS', caPath);
    envCollection.description = 'Localias: trust mkcert CA in integrated terminals';

    // One-time hint
    if (!context.globalState.get<boolean>(CA_ENV_HINT_KEY)) {
      context.globalState.update(CA_ENV_HINT_KEY, true);

      const exportCmd = IS_WINDOWS
        ? `$env:NODE_EXTRA_CA_CERTS="${caPath}"`
        : `export NODE_EXTRA_CA_CERTS="${caPath}"`;
      vscode.window.showInformationMessage(
        `Localias: NODE_EXTRA_CA_CERTS is now set in integrated terminals. To use it in external terminals, copy the export command.`,
        'Copy Export Command',
      ).then((choice) => {
        if (choice === 'Copy Export Command') {
          vscode.env.clipboard.writeText(exportCmd);
          vscode.window.showInformationMessage('Copied to clipboard.');
        }
      });
    }
  }).catch(() => { /* mkcert not available yet — will inject after preflight */ });
}
