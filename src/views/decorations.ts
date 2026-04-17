import * as vscode from 'vscode';
import { getRoutes } from '../config';

const ROUTE_URI_SCHEME = 'localias-route';

export class RouteDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  fireChange(): void {
    this._onDidChangeFileDecorations.fire(
      getRoutes().map(r => vscode.Uri.from({ scheme: ROUTE_URI_SCHEME, path: `/${r.id}` })),
    );
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== ROUTE_URI_SCHEME) return undefined;
    if (uri.path.startsWith('/disabled/')) {
      return { color: new vscode.ThemeColor('disabledForeground') };
    }
    return undefined;
  }
}
