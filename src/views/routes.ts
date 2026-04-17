import * as vscode from 'vscode';
import { getRoutes, getEnabledRoutes, reorderRoutes } from '../config';
import { isWildcard } from '../commands/validate';
import type { RouteDecorationProvider } from './decorations';

const ROUTE_URI_SCHEME = 'localias-route';

export class RoutesTreeProvider implements vscode.TreeDataProvider<RouteItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RouteItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _isRunning = false;
  private _view: vscode.TreeView<RouteItem> | undefined;
  private _decorationProvider?: RouteDecorationProvider;

  readonly dragAndDropController = new RouteDragAndDropController(this);

  registerView(view: vscode.TreeView<RouteItem>): void {
    this._view = view;
  }

  registerDecorationProvider(provider: RouteDecorationProvider): void {
    this._decorationProvider = provider;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
    this.updateBadge();
    this._decorationProvider?.fireChange();
  }

  setRunning(running: boolean): void {
    this._isRunning = running;
    this.refresh();
  }

  private updateBadge(): void {
    if (!this._view) return;
    const enabledCount = getEnabledRoutes().length;
    this._view.badge = enabledCount > 0
      ? { value: enabledCount, tooltip: `${enabledCount} enabled route(s)` }
      : undefined;
  }

  getTreeItem(element: RouteItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RouteItem): RouteItem[] {
    if (element) return [];

    const routes = getRoutes();
    if (routes.length === 0) {
      return [new RouteItem('No routes configured', '', 'info', undefined, {
        command: 'localias.addRoute',
        title: 'Add Route',
      })];
    }

    return routes.map(r => {
      const wild = isWildcard(r.domain);
      let context: RouteItemContext;
      if (!r.enabled) {
        context = 'disabled';
      } else if (this._isRunning) {
        context = wild ? 'active-wildcard' : 'active';
      } else {
        context = 'inactive';
      }
      return new RouteItem(
        r.domain,
        `→ :${r.target}`,
        context,
        r.id,
        {
          command: 'localias.toggleRoute',
          title: 'Toggle Route',
          arguments: [{ routeId: r.id }],
        },
      );
    });
  }
}

const ROUTE_MIME = 'application/vnd.code.tree.localias.route';

class RouteDragAndDropController implements vscode.TreeDragAndDropController<RouteItem> {
  readonly dropMimeTypes = [ROUTE_MIME];
  readonly dragMimeTypes = [ROUTE_MIME];

  constructor(private treeProvider: RoutesTreeProvider) {}

  handleDrag(source: readonly RouteItem[], dataTransfer: vscode.DataTransfer): void {
    const ids = source.map(s => s.routeId).filter((id): id is string => id !== undefined);
    dataTransfer.set(ROUTE_MIME, new vscode.DataTransferItem(ids));
  }

  async handleDrop(target: RouteItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(ROUTE_MIME);
    if (!item) return;
    const draggedIds: string[] = item.value;
    if (!draggedIds.length) return;

    const routes = getRoutes();
    const targetId = target?.routeId;
    const targetIndex = targetId ? routes.findIndex(r => r.id === targetId) : routes.length - 1;
    if (targetIndex < 0) return;

    // Build new order: remove dragged, insert before target
    const remaining = routes.filter(r => !draggedIds.includes(r.id));
    const dragged = routes.filter(r => draggedIds.includes(r.id));
    const insertAt = remaining.findIndex(r => r.id === targetId);
    const finalIndex = insertAt >= 0 ? insertAt : remaining.length;

    remaining.splice(finalIndex, 0, ...dragged);
    await reorderRoutes(remaining.map(r => r.id));
  }
}

type RouteItemContext = 'info' | 'active' | 'active-wildcard' | 'inactive' | 'disabled';

export class RouteItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly routeContext: RouteItemContext,
    public readonly routeId?: string,
    command?: vscode.Command,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.command = command;
    // Include state in id so VS Code drops selection after toggle
    this.id = routeId ? `${routeId}-${routeContext}` : undefined;

    if (routeContext === 'info') {
      this.contextValue = 'empty';
      this.iconPath = new vscode.ThemeIcon('info');
    } else if (routeContext === 'disabled') {
      this.contextValue = 'route-disabled';
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('disabledForeground'));
      this.resourceUri = vscode.Uri.from({ scheme: ROUTE_URI_SCHEME, path: `/disabled/${routeId}` });
    } else if (routeContext === 'active' || routeContext === 'active-wildcard') {
      this.contextValue = routeContext === 'active-wildcard' ? 'route-enabled-wildcard' : 'route-enabled';
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
      this.resourceUri = vscode.Uri.from({ scheme: ROUTE_URI_SCHEME, path: `/${routeId}` });
    } else {
      this.contextValue = 'route-enabled';
      this.iconPath = new vscode.ThemeIcon('circle-filled');
      this.resourceUri = vscode.Uri.from({ scheme: ROUTE_URI_SCHEME, path: `/${routeId}` });
    }
  }
}
