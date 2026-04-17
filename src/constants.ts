import * as os from 'os';
import * as path from 'path';

/** Running on Windows? */
export const IS_WINDOWS = os.platform() === 'win32';

/** System hosts file path. */
export const HOSTS_PATH = IS_WINDOWS
  ? path.join(process.env.windir ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts';

/** Regenerate certificates 7 days before expiry. */
export const CERT_EXPIRY_BUFFER_MS = 7 * 24 * 60 * 60 * 1000;

/** Extract a human-readable message from an unknown catch value. */
export function errMsg(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = String((err as Record<string, unknown>).stderr).trim();
    if (stderr) return stderr;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
