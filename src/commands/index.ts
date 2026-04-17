import * as vscode from 'vscode';
import { cmdStart, cmdStop } from './proxy';
import { cmdAddRoute, cmdEditRoute, cmdRemoveRoute, cmdClearAllRoutes, cmdToggleRoute, cmdShowRoutes, cmdAddRouteForPort } from './routes';
import { cmdGenerateCert, cmdRefreshPorts, cmdSyncHosts, cmdKillPort, cmdHideProcess, cmdOpenRoute } from './misc';
import type { Deps } from './deps';

export type { Deps } from './deps';
export { autoRestart } from './proxy';
export { injectNodeExtraCACerts } from './misc';

export function registerAll(context: vscode.ExtensionContext, deps: Deps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('localias.start', () => cmdStart(deps)),
    vscode.commands.registerCommand('localias.stop', () => cmdStop(deps)),
    vscode.commands.registerCommand('localias.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vizards.localias'),
    ),
    vscode.commands.registerCommand('localias.statusBarMenu', () => deps.statusBar.showMenu()),
    vscode.commands.registerCommand('localias.addRoute', () => cmdAddRoute(deps)),
    vscode.commands.registerCommand('localias.removeRoute', (item) => cmdRemoveRoute(deps, item)),
    vscode.commands.registerCommand('localias.clearAllRoutes', () => cmdClearAllRoutes(deps)),
    vscode.commands.registerCommand('localias.editRoute', (idOrItem) => cmdEditRoute(deps, idOrItem)),
    vscode.commands.registerCommand('localias.toggleRoute', (item) => cmdToggleRoute(deps, item)),
    vscode.commands.registerCommand('localias.enableRoute', (item) => cmdToggleRoute(deps, item)),
    vscode.commands.registerCommand('localias.disableRoute', (item) => cmdToggleRoute(deps, item)),
    vscode.commands.registerCommand('localias.showRoutes', () => cmdShowRoutes()),
    vscode.commands.registerCommand('localias.generateCert', () => cmdGenerateCert(deps)),
    vscode.commands.registerCommand('localias.addRouteForPort', (portOrItem) => cmdAddRouteForPort(deps, portOrItem)),
    vscode.commands.registerCommand('localias.refreshPorts', () => cmdRefreshPorts(deps)),
    vscode.commands.registerCommand('localias.syncHosts', () => cmdSyncHosts(deps)),
    vscode.commands.registerCommand('localias.killPort', (item, selected) => cmdKillPort(deps, item, selected)),
    vscode.commands.registerCommand('localias.hideProcess', (item, selected) => cmdHideProcess(deps, item, selected)),
    vscode.commands.registerCommand('localias.openRoute', (item) => cmdOpenRoute(deps, item)),
  );
}
