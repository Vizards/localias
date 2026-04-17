import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec, execSync } from 'child_process';
import * as vscode from 'vscode';
import * as sudoPrompt from '@vscode/sudo-prompt';
import { HOSTS_PATH, IS_WINDOWS } from '../constants';

export type HostsWriteMode = 'chmod' | 'sudo-prompt';

/**
 * Low-level reader/writer for the system hosts file.
 *
 * Supports two write modes (configurable via `localias.hostsWriteMode`):
 *
 * - **`chmod`** (macOS/Linux only): One-time `chmod 666 /etc/hosts` via native
 *   auth dialog. Afterwards all writes are direct `fs` operations — no more
 *   password prompts.  Slightly less secure (any process can write to hosts).
 *
 * - **`sudo-prompt`** (all platforms): Each write triggers a native OS auth
 *   dialog (Touch ID / UAC / PolicyKit).  More secure but prompts every time.
 *
 * On Windows, `chmod` mode is unavailable — `sudo-prompt` is always used.
 */
export class HostsFileWriter {
  private static readonly HINT_SHOWN_KEY = 'hostsWriteMode.hintShown';

  constructor(private globalState?: vscode.Memento) {}

  /** Read the hosts file (unprivileged — always works). */
  read(): string {
    try {
      return fs.readFileSync(HOSTS_PATH, 'utf-8');
    } catch {
      return '';
    }
  }

  /** Write new content to the hosts file using the configured mode. */
  async write(content: string): Promise<void> {
    const mode = this.effectiveMode();
    if (mode === 'chmod') {
      await this.writeChmod(content);
    } else {
      await this.writeSudoPrompt(content);
    }
  }

  /** Check if the hosts file is currently writable by this process. */
  isWritable(): boolean {
    try {
      fs.accessSync(HOSTS_PATH, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  get hostsPath(): string {
    return HOSTS_PATH;
  }

  // ── Internals ──

  /** Resolve the effective write mode (Windows always uses sudo-prompt). */
  private effectiveMode(): HostsWriteMode {
    if (IS_WINDOWS) return 'sudo-prompt';
    const configured = vscode.workspace.getConfiguration('localias')
      .get<HostsWriteMode>('hostsWriteMode') ?? 'sudo-prompt';
    return configured;
  }

  // ── chmod mode (macOS/Linux) ──

  private async writeChmod(content: string): Promise<void> {
    if (!this.isWritable()) {
      await this.acquireChmodAccess();
    }

    const tmpFile = this.writeTempFile(content);
    try {
      execSync(`cat ${shellEscape(tmpFile)} > ${shellEscape(HOSTS_PATH)}`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  /**
   * Eagerly acquire chmod 666 access on the hosts file.
   * Called when the user switches to chmod mode in settings.
   * No-op if the file is already writable.
   */
  async acquireChmodAccess(): Promise<void> {
    if (IS_WINDOWS) return;
    if (this.isWritable()) return;

    const action = await vscode.window.showInformationMessage(
      'Localias needs write access to the hosts file. You will be prompted for your password once.',
      { modal: true },
      'Continue',
    );
    if (action !== 'Continue') {
      throw new Error('User cancelled the hosts file update.');
    }

    if (process.platform === 'darwin') {
      await this.osascriptChmod();
    } else {
      // Linux — try pkexec
      await this.pkexecChmod();
    }
  }

  private osascriptChmod(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      exec(
        `osascript -e 'do shell script "chmod 666 ${HOSTS_PATH}" with administrator privileges'`,
        (error) => {
          if (error) reject(new Error('Password authorization was cancelled.'));
          else resolve();
        },
      );
    });
  }

  private pkexecChmod(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      exec(`pkexec chmod 666 ${HOSTS_PATH}`, (error) => {
        if (error) reject(new Error('Authorization was cancelled or pkexec is unavailable.'));
        else resolve();
      });
    });
  }

  // ── sudo-prompt mode (all platforms) ──

  private async writeSudoPrompt(content: string): Promise<void> {
    // If already writable (e.g. user previously used chmod mode), write directly
    if (this.isWritable()) {
      const tmpFile = this.writeTempFile(content);
      try {
        if (IS_WINDOWS) {
          execSync(`copy /Y ${shellEscapeWin(tmpFile)} ${shellEscapeWin(HOSTS_PATH)}`, { shell: 'cmd.exe' });
        } else {
          execSync(`cat ${shellEscape(tmpFile)} > ${shellEscape(HOSTS_PATH)}`);
        }
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
      return;
    }

    // Need elevation
    const tmpFile = this.writeTempFile(content);
    try {
      const cmd = IS_WINDOWS
        ? `copy /Y "${tmpFile}" "${HOSTS_PATH}"`
        : `cp ${shellEscape(tmpFile)} ${shellEscape(HOSTS_PATH)} && chmod 644 ${shellEscape(HOSTS_PATH)}`;

      await new Promise<void>((resolve, reject) => {
        sudoPrompt.exec(cmd, { name: 'Localias' }, (error) => {
          if (error) reject(new Error('Authorization was cancelled. Hosts file was not updated.'));
          else resolve();
        });
      });

      // One-time hint: suggest chmod mode on macOS/Linux
      this.suggestChmodMode();
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  // ── Helpers ──

  private writeTempFile(content: string): string {
    const tmpFile = path.join(os.tmpdir(), `localias-hosts-${Date.now()}`);
    fs.writeFileSync(tmpFile, content, { mode: 0o644 });
    return tmpFile;
  }

  /**
   * After the first successful sudo-prompt elevated write on macOS/Linux,
   * show a non-modal notification suggesting the user can switch to chmod mode.
   */
  private suggestChmodMode(): void {
    if (IS_WINDOWS) return;
    if (!this.globalState) return;
    if (this.globalState.get<boolean>(HostsFileWriter.HINT_SHOWN_KEY)) return;

    this.globalState.update(HostsFileWriter.HINT_SHOWN_KEY, true);

    vscode.window.showInformationMessage(
      'Tip: To avoid repeated password prompts when updating hosts, you can switch to "chmod" mode in settings.',
      'Open Settings',
      'Dismiss',
    ).then(choice => {
      if (choice === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'localias.hostsWriteMode');
      }
    });
  }

  /**
   * Restore hosts file to 644 (standard permissions).
   * Used when switching from chmod → sudo-prompt mode.
   * Requires elevation since the file is owned by root.
   */
  async restorePermissions(): Promise<void> {
    if (IS_WINDOWS) return;
    if (!this.isWritable()) return; // already restricted — nothing to do

    await new Promise<void>((resolve, reject) => {
      sudoPrompt.exec(
        `chmod 644 ${shellEscape(HOSTS_PATH)}`,
        { name: 'Localias' },
        (error) => {
          if (error) reject(new Error('Authorization was cancelled. Hosts file permissions were not changed.'));
          else resolve();
        },
      );
    });
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function shellEscapeWin(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
