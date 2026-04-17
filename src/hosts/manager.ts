import * as vscode from 'vscode';
import { getRoutes } from '../config';
import { errMsg } from '../constants';
import { HostsFileWriter } from './writer';

const MARKER = '# Localias (managed by VS Code extension — do not edit this line)';

/**
 * Manages the /etc/hosts file for route domains.
 *
 * Format in /etc/hosts:
 * ```
 * # Localias (managed by VS Code extension — do not edit this line)
 * 127.0.0.1 dev1.zhuiguang.xyz dev2.zhuiguang.xyz
 * ```
 *
 * Delegates actual file I/O to {@link HostsFileWriter}, which supports
 * two write modes (chmod vs sudo-prompt) controlled by a user setting.
 */
export class HostsManager {
  private writer: HostsFileWriter;

  constructor(context?: vscode.ExtensionContext) {
    this.writer = new HostsFileWriter(context?.globalState);
  }

  /**
   * Sync /etc/hosts with the given route domains.
   * Wildcard domains (*.example.com) are skipped — they can't go in hosts.
   * If domains is empty, the managed block is removed.
   */
  async sync(domains: string[]): Promise<void> {
    const loopbackSuffixes = vscode.workspace
      .getConfiguration('localias')
      .get<string[]>('loopbackDomains', []);

    const concreteDomains = domains
      .filter(d => !d.includes('*'))
      .filter(d => !d.endsWith('.localhost') && d !== 'localhost')
      .filter(d => !loopbackSuffixes.some(s => d === s || d.endsWith(`.${s}`)))
      .sort();

    const currentDomains = this.readManagedDomains();

    // Already in sync — skip the sudo prompt
    const same = concreteDomains.length === currentDomains.length
      && concreteDomains.every((d, i) => d === currentDomains[i]);
    if (same) return;

    const content = this.writer.read();
    const newContent = this.buildNewContent(content, concreteDomains);

    await this.writer.write(newContent);
  }

  /**
   * Remove the managed block from /etc/hosts entirely.
   */
  async cleanup(): Promise<void> {
    const currentDomains = this.readManagedDomains();
    if (currentDomains.length === 0) return; // nothing to clean

    const content = this.writer.read();
    const newContent = this.buildNewContent(content, []);
    await this.writer.write(newContent);
  }

  /**
   * Read the domains currently managed by this extension from /etc/hosts.
   */
  readManagedDomains(): string[] {
    const content = this.writer.read();
    if (!content) return [];

    const lines = content.split('\n');
    const markerIdx = lines.findIndex(l => l.trim() === MARKER);
    if (markerIdx < 0 || markerIdx + 1 >= lines.length) return [];

    const hostsLine = lines[markerIdx + 1];
    // Parse: "127.0.0.1 domain1 domain2 ..."
    const parts = hostsLine.trim().split(/\s+/);
    if (parts.length < 2 || parts[0] !== '127.0.0.1') return [];

    return parts.slice(1).sort();
  }

  // ── Internal ──

  private buildNewContent(content: string, domains: string[]): string {
    const lines = content.split('\n');
    const markerIdx = lines.findIndex(l => l.trim() === MARKER);

    if (markerIdx >= 0) {
      // Remove existing managed block (marker + hosts line)
      const removeCount = (markerIdx + 1 < lines.length && lines[markerIdx + 1].startsWith('127.0.0.1')) ? 2 : 1;
      lines.splice(markerIdx, removeCount);
    }

    if (domains.length > 0) {
      // Remove trailing empty lines before appending
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }

      lines.push('');
      lines.push(MARKER);
      lines.push(`127.0.0.1 ${domains.join(' ')}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private get manageHosts(): boolean {
    return vscode.workspace.getConfiguration('localias').get<boolean>('manageHosts') !== false;
  }

  /**
   * Try to sync hosts with a new domain included.
   * Returns false if sync failed and the caller should abort.
   */
  async syncForNewRoute(domain: string): Promise<boolean> {
    if (!this.manageHosts) return true;

    const allDomains = [...getRoutes().map(r => r.domain), domain];
    try {
      await this.sync(allDomains);
      return true;
    } catch (err: unknown) {
      vscode.window.showErrorMessage(`Failed to add route: system hosts update failed. ${errMsg(err)}`);
      return false;
    }
  }

  /** Sync hosts in background \u2014 log errors but don't block the caller. */
  syncQuietly(domains: string[]): void {
    if (!this.manageHosts) return;

    this.sync(domains).catch((err: unknown) => {
      console.warn('[Localias] hosts sync failed:', errMsg(err));
      vscode.window.showWarningMessage(`System hosts sync failed: ${errMsg(err)}`);
    });
  }
  /**
   * Remove managed hosts entries on stop/exit — but only when the hosts
   * file is already writable (chmod mode).  In sudo-prompt mode this is
   * a no-op so the user is never prompted on exit.
   */
  cleanupQuietly(): void {
    if (!this.manageHosts) return;
    if (!this.writer.isWritable()) return;

    this.cleanup().catch((err) => {
      console.warn('[Localias] hosts cleanup on exit failed:', err.message);
    });
  }

  /**
   * Restore hosts file to standard 644 permissions.
   * Called when user switches from chmod → sudo-prompt mode.
   */
  async restorePermissions(): Promise<void> {
    await this.writer.restorePermissions();
  }

  /**
   * Eagerly acquire chmod 666 on the hosts file.
   * Called when user switches to chmod mode in settings.
   */
  async acquireChmodAccess(): Promise<void> {
    await this.writer.acquireChmodAccess();
  }
}
