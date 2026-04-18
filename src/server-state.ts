import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

interface LockData {
  pid: number;
  port: number;
  sessionId: string;
  heartbeat: number;
}

interface StopSignal {
  requestedBy: string;
  timestamp: number;
}

export interface ServerStateInfo {
  running: boolean;
  ownedByThisWindow: boolean;
  port?: number;
  pid?: number;
}

/**
 * Cross-window server state manager.
 *
 * Uses a lock file (`~/.localias/server.lock`) to coordinate a single proxy
 * instance across multiple VS Code windows. The owning window writes a
 * heartbeat every poll cycle; other windows watch for changes via `fs.watch`
 * + periodic poll to keep their UI in sync.
 *
 * Stop requests from non-owning windows are communicated via a signal file
 * (`~/.localias/server.stop`) that the owner consumes.
 */
export class ServerStateManager implements vscode.Disposable {
  private static readonly STATE_DIR = path.join(os.homedir(), '.localias');
  private static readonly LOCK_FILE = path.join(os.homedir(), '.localias', 'server.lock');
  private static readonly STOP_FILE = path.join(os.homedir(), '.localias', 'server.stop');
  private static readonly HEARTBEAT_STALE_MS = 30_000;

  private readonly _onDidChangeState = new vscode.EventEmitter<ServerStateInfo>();
  readonly onDidChangeState = this._onDidChangeState.event;

  private readonly _onStopRequested = new vscode.EventEmitter<void>();
  readonly onStopRequested = this._onStopRequested.event;

  private watcher: fs.FSWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastState: ServerStateInfo = { running: false, ownedByThisWindow: false };
  private ownsServer = false;

  private readonly sessionId = vscode.env.sessionId;

  constructor() {
    this.ensureStateDir();
    this.startWatching();
  }

  private ensureStateDir(): void {
    try {
      fs.mkdirSync(ServerStateManager.STATE_DIR, { recursive: true });
    } catch { /* already exists or no permission — handled later */ }
  }

  /**
   * Claim ownership of the proxy server.
   * Uses O_CREAT|O_EXCL (`wx`) for atomic exclusive creation.
   * Returns `true` if this window now owns the lock.
   */
  claimOwnership(port: number): boolean {
    this.ensureStateDir();
    const existing = this.readLock();

    if (existing) {
      if (existing.sessionId === this.sessionId) {
        // We already own it — update metadata (port/heartbeat may have changed)
        this.writeLock(port);
        this.ownsServer = true;
        this.emitState();
        return true;
      }
      if (this.isStale(existing)) {
        try { fs.unlinkSync(ServerStateManager.LOCK_FILE); } catch { /* race OK */ }
      } else {
        return false;
      }
    }

    try {
      const data: LockData = {
        pid: process.pid,
        port,
        sessionId: this.sessionId,
        heartbeat: Date.now(),
      };
      fs.writeFileSync(ServerStateManager.LOCK_FILE, JSON.stringify(data), { flag: 'wx' });
      this.ownsServer = true;
      this.emitState();
      return true;
    } catch {
      return false; // another window claimed it between our check and create
    }
  }

  /** Release ownership. Idempotent. */
  releaseOwnership(): void {
    if (!this.ownsServer) return;
    try { fs.unlinkSync(ServerStateManager.LOCK_FILE); } catch { /* already gone */ }
    this.ownsServer = false;
    this.emitState();
  }

  /** Read the current server state from disk, cleaning up stale locks. */
  getState(): ServerStateInfo {
    const lock = this.readLock();
    if (!lock) {
      return { running: false, ownedByThisWindow: false };
    }

    if (this.isStale(lock)) {
      try { fs.unlinkSync(ServerStateManager.LOCK_FILE); } catch { /* race OK */ }
      if (lock.sessionId === this.sessionId) this.ownsServer = false;
      return { running: false, ownedByThisWindow: false };
    }

    return {
      running: true,
      ownedByThisWindow: lock.sessionId === this.sessionId,
      port: lock.port,
      pid: lock.pid,
    };
  }

  /** Write a stop signal for the owning window to consume. */
  requestRemoteStop(): void {
    const signal: StopSignal = {
      requestedBy: this.sessionId,
      timestamp: Date.now(),
    };
    try {
      fs.writeFileSync(ServerStateManager.STOP_FILE, JSON.stringify(signal), 'utf-8');
    } catch { /* best-effort */ }
  }

  // ── Private helpers ──

  private readLock(): LockData | null {
    try {
      return JSON.parse(fs.readFileSync(ServerStateManager.LOCK_FILE, 'utf-8'));
    } catch {
      return null;
    }
  }

  private writeLock(port: number): void {
    const data: LockData = {
      pid: process.pid,
      port,
      sessionId: this.sessionId,
      heartbeat: Date.now(),
    };
    try {
      fs.writeFileSync(ServerStateManager.LOCK_FILE, JSON.stringify(data), 'utf-8');
    } catch { /* best-effort */ }
  }

  private isStale(lock: LockData): boolean {
    if (!this.isPidAlive(lock.pid)) return true;
    return Date.now() - lock.heartbeat > ServerStateManager.HEARTBEAT_STALE_MS;
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private updateHeartbeat(): void {
    if (!this.ownsServer) return;
    const lock = this.readLock();
    if (!lock || lock.sessionId !== this.sessionId) {
      // Lock was stolen or deleted — we no longer own it
      this.ownsServer = false;
      return;
    }
    lock.heartbeat = Date.now();
    try {
      fs.writeFileSync(ServerStateManager.LOCK_FILE, JSON.stringify(lock), 'utf-8');
    } catch { /* best-effort */ }
  }

  // ── Watching ──

  private startWatching(): void {
    try {
      this.watcher = fs.watch(ServerStateManager.STATE_DIR, (_eventType, filename) => {
        if (filename === 'server.lock' || filename === 'server.stop') {
          this.handleFileChange(filename);
        }
      });
      this.watcher.on('error', () => {});
    } catch { /* directory watcher unavailable — poll-only */ }

    this.pollTimer = setInterval(() => {
      this.updateHeartbeat();
      this.emitState();
      this.checkStopSignal();
    }, 5000);
  }

  private handleFileChange(filename: string): void {
    if (filename === 'server.lock') {
      this.emitState();
    } else if (filename === 'server.stop') {
      this.checkStopSignal();
    }
  }

  private checkStopSignal(): void {
    if (!this.ownsServer) return;

    let signal: StopSignal;
    try {
      signal = JSON.parse(fs.readFileSync(ServerStateManager.STOP_FILE, 'utf-8'));
    } catch {
      return; // no signal or unreadable
    }

    // Ignore stale signals (> 30 s old)
    if (Date.now() - signal.timestamp > 30_000) {
      try { fs.unlinkSync(ServerStateManager.STOP_FILE); } catch {}
      return;
    }

    // Ignore our own signal
    if (signal.requestedBy === this.sessionId) return;

    try { fs.unlinkSync(ServerStateManager.STOP_FILE); } catch {}
    this._onStopRequested.fire();
  }

  private emitState(): void {
    const state = this.getState();
    if (
      state.running !== this.lastState.running ||
      state.ownedByThisWindow !== this.lastState.ownedByThisWindow ||
      state.port !== this.lastState.port
    ) {
      this.lastState = state;
      this._onDidChangeState.fire(state);
    }
  }

  dispose(): void {
    this.releaseOwnership();
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this._onDidChangeState.dispose();
    this._onStopRequested.dispose();
  }
}
