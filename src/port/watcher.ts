import * as vscode from 'vscode';
import type { ForwardedPort } from '../views';
import { scanPorts, killPid } from './scanner';

/** Map of port → set of PIDs owning that port, refreshed alongside port scanning. */
let portPidMap = new Map<number, Set<number>>();

/** Map of port → process command name (first PID's name wins). */
let portProcessMap = new Map<number, string>();

function getBlacklist(): Set<string> {
  const config = vscode.workspace.getConfiguration('localias');
  const inspected = config.inspect<string[]>('portBlacklist');
  const list = new Set(config.get<string[]>('portBlacklist') ?? []);
  // In remote environments (Codespaces, SSH, etc.) forwarded ports appear
  // under "Code Helper (Plugin)". Keep them visible so they show up in the
  // Unrouted Ports panel, but only when the user hasn't explicitly
  // blacklisted it. Once the stable `workspace.tunnels` API lands this
  // workaround can be removed.
  if (vscode.env.remoteName) {
    const explicitBlacklist = new Set<string>([
      ...(inspected?.globalValue ?? []),
      ...(inspected?.workspaceValue ?? []),
      ...(inspected?.workspaceFolderValue ?? []),
    ]);
    if (!explicitBlacklist.has('Code Helper (Plugin)')) {
      list.delete('Code Helper (Plugin)');
    }
  }
  return list;
}

/**
 * Detects listening TCP ports on localhost by parsing
 * `lsof` (macOS/Linux) or `netstat` (Windows) output.
 */
export class PortForwardingWatcher implements vscode.Disposable {
  private _onDidChangePorts = new vscode.EventEmitter<ForwardedPort[]>();
  readonly onDidChangePorts = this._onDidChangePorts.event;

  private timer: ReturnType<typeof setInterval> | undefined;
  private _ports: ForwardedPort[] = [];

  get ports(): ForwardedPort[] {
    return [...this._ports];
  }

  startWatching(intervalMs = 5000): void {
    this.stopWatching();
    this.refreshPorts();
    this.timer = setInterval(() => this.refreshPorts(), intervalMs);
  }

  stopWatching(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async refreshPorts(): Promise<ForwardedPort[]> {
    try {
      const { pidMap, processMap, ports } = await scanPorts();

      portPidMap = pidMap;
      portProcessMap = processMap;

      // Filter out blacklisted processes
      const blacklist = getBlacklist();
      const filtered = [...ports].filter(p => {
        const cmd = processMap.get(p);
        return !cmd || !blacklist.has(cmd);
      });

      const newPorts: ForwardedPort[] = filtered
        .sort((a, b) => a - b)
        .map(p => ({ localPort: p, remotePort: p, processName: processMap.get(p) }));

      const changed = newPorts.length !== this._ports.length
        || newPorts.some((p, i) =>
          p.localPort !== this._ports[i]?.localPort
          || p.processName !== this._ports[i]?.processName);

      if (changed) {
        this._ports = newPorts;
        this._onDidChangePorts.fire(this._ports);
      }
    } catch {
      // Scanner not available — ignore, ports panel will be empty
    }

    return this._ports;
  }

  /** Get PIDs occupying a given port (from last scan). */
  getPidsForPort(port: number): number[] {
    return [...(portPidMap.get(port) ?? [])];
  }

  /** Get process name for a given port (from last scan). */
  getProcessName(port: number): string | undefined {
    return portProcessMap.get(port);
  }

  /** Kill all processes listening on the given port. Returns the killed PIDs. */
  async killByPort(port: number): Promise<number[]> {
    // Re-scan to get fresh PIDs
    await this.refreshPorts();
    const pids = this.getPidsForPort(port);
    const killed: number[] = [];
    for (const pid of pids) {
      try {
        await killPid(pid);
        killed.push(pid);
      } catch {
        // Process may have already exited — ignore
      }
    }
    // Refresh again so the UI updates
    if (killed.length > 0) {
      await new Promise(r => setTimeout(r, 300));
      await this.refreshPorts();
    }
    return killed;
  }

  dispose(): void {
    this.stopWatching();
    this._onDidChangePorts.dispose();
  }
}
