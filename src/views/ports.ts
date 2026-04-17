import * as vscode from 'vscode';
import { getRoutes } from '../config';

export class ForwardedPortsTreeProvider implements vscode.TreeDataProvider<PortItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PortItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _ports: ForwardedPort[] = [];

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  setPorts(ports: ForwardedPort[]): void {
    this._ports = ports;
    this.refresh();
  }

  getTreeItem(element: PortItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PortItem): PortItem[] {
    if (element) return [];

    const allRoutes = getRoutes();
    const routedPorts = new Set(allRoutes.map(r => r.target));
    const unrouted = this._ports.filter(p => !routedPorts.has(p.localPort));

    if (unrouted.length === 0) {
      const msg = this._ports.length === 0
        ? 'No listening ports detected'
        : 'All ports are routed';
      return [new PortItem(msg, '', 'empty')];
    }

    return unrouted.map(p => new PortItem(
      `:${p.localPort}`,
      p.processName ?? '',
      'unmapped',
      p.localPort,
      p.processName,
    ));
  }
}

export interface ForwardedPort {
  localPort: number;
  remotePort: number;
  processName?: string;
}

type PortItemContext = 'empty' | 'unmapped';

class PortItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly portContext: PortItemContext,
    public readonly port?: number,
    public readonly processName?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = portContext;

    if (portContext === 'unmapped') {
      this.iconPath = new vscode.ThemeIcon('plug');
      this.command = {
        command: 'localias.addRouteForPort',
        title: 'Add Route',
        arguments: [this.port],
      };
    } else {
      this.iconPath = new vscode.ThemeIcon('info');
    }
  }
}
