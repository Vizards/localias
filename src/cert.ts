import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as tls from 'tls';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { IS_WINDOWS, CERT_EXPIRY_BUFFER_MS, errMsg } from './constants';

const execFileAsync = promisify(execFile);

export interface CertPair {
  cert: string;
  key: string;
  ca?: string;
  domains: string[];
}

export class CertManager {
  private certDir: string;
  private caCertBuf: Buffer | undefined;

  constructor(private context: vscode.ExtensionContext) {
    const configDir = vscode.workspace.getConfiguration('localias').get<string>('certDir');
    if (configDir) {
      this.certDir = configDir;
    } else {
      this.certDir = path.join(os.homedir(), '.localias', 'certs');
    }
  }

  private getMkcertPath(): string {
    return vscode.workspace.getConfiguration('localias').get<string>('mkcertPath') ?? 'mkcert';
  }

  // ── Public API ──

  /**
   * Run mkcert + CA preflight checks (may show UI prompts).
   * Must be called once before createSNICallback() is used.
   */
  async ensurePreflight(): Promise<void> {
    await this.ensureMkcert();
    await this.ensureCA();
    await fs.promises.mkdir(this.certDir, { recursive: true });
    // Cache CA cert buffer for SNI callback
    const caPath = await this.getCARootPem();
    if (caPath) {
      this.caCertBuf = fs.readFileSync(caPath);
    }
  }

  /**
   * Create an SNI callback that generates per-domain certs on the fly.
   * Memory cache → disk cache → mkcert generation.
   * ensurePreflight() must be called before using this callback.
   */
  createSNICallback(): (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void {
    const cache = new Map<string, tls.SecureContext>();
    const pending = new Map<string, Promise<tls.SecureContext>>();

    return (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
      // Memory cache hit
      const cached = cache.get(servername);
      if (cached) { cb(null, cached); return; }

      // Deduplicate concurrent requests for the same domain
      const inflight = pending.get(servername);
      if (inflight) {
        inflight.then(ctx => cb(null, ctx)).catch(err => cb(err as Error));
        return;
      }

      const promise = this.ensureSingleDomainCert(servername).then(({ certBuf, keyBuf }) => {
        const ctx = tls.createSecureContext({
          cert: this.caCertBuf ? Buffer.concat([certBuf, this.caCertBuf]) : certBuf,
          key: keyBuf,
        });
        cache.set(servername, ctx);
        pending.delete(servername);
        return ctx;
      });

      pending.set(servername, promise);
      promise.then(ctx => cb(null, ctx)).catch(err => {
        pending.delete(servername);
        cb(err instanceof Error ? err : new Error(String(err)));
      });
    };
  }

  /**
   * Full preflight: check mkcert binary, check CA, ensure certs exist.
   * Guides the user through installation if anything is missing.
   *
   * Automatically promotes subdomains to wildcard certs when multiple
   * subdomains share the same parent domain (e.g. dev1.example.com +
   * dev2.example.com → *.example.com + dev1.example.com + dev2.example.com).
   * This avoids cert mismatch when new subdomains are added later.
   */
  async ensureCerts(domains: string[]): Promise<CertPair> {
    await this.ensureMkcert();
    await this.ensureCA();

    await fs.promises.mkdir(this.certDir, { recursive: true });

    const certDomains = this.expandWithWildcards(domains);
    const safeName = certDomains
      .map(d => d.replace(/\*/g, '_wildcard_').replace(/[^a-zA-Z0-9._-]/g, '_'))
      .join('+');

    const certPath = path.join(this.certDir, `${safeName}.pem`);
    const keyPath = path.join(this.certDir, `${safeName}-key.pem`);

    if (fs.existsSync(certPath) && fs.existsSync(keyPath) && this.isCertValid(certPath)) {
      return { cert: certPath, key: keyPath, ca: await this.getCARootPem(), domains: certDomains };
    }

    await this.generateCertFiles(certDomains, certPath, keyPath);
    return { cert: certPath, key: keyPath, ca: await this.getCARootPem(), domains: certDomains };
  }

  async generateCert(domains: string[]): Promise<CertPair> {
    await this.ensureMkcert();
    await this.ensureCA();

    await fs.promises.mkdir(this.certDir, { recursive: true });

    const certDomains = this.expandWithWildcards(domains);
    const safeName = certDomains
      .map(d => d.replace(/\*/g, '_wildcard_').replace(/[^a-zA-Z0-9._-]/g, '_'))
      .join('+');

    const certPath = path.join(this.certDir, `${safeName}.pem`);
    const keyPath = path.join(this.certDir, `${safeName}-key.pem`);

    await this.generateCertFiles(certDomains, certPath, keyPath);
    return { cert: certPath, key: keyPath, ca: await this.getCARootPem(), domains: certDomains };
  }

  // ── Domain expansion ──

  /**
   * Given a list of domains, detect parent domains that have multiple subdomains
   * and add a wildcard entry (*.parent) so the cert covers future subdomains too.
   *
   * e.g. ["dev1.example.com", "dev2.example.com"] →
   *      ["*.example.com", "dev1.example.com", "dev2.example.com"]
   *
   * Already-present wildcards are respected and not duplicated.
   */
  private expandWithWildcards(domains: string[]): string[] {
    const unique = [...new Set(domains)];
    const parentCount = new Map<string, number>();
    const existingWildcards = new Set<string>();

    for (const d of unique) {
      if (d.startsWith('*.')) {
        existingWildcards.add(d);
        continue;
      }
      const dotIdx = d.indexOf('.');
      if (dotIdx > 0) {
        const parent = d.slice(dotIdx + 1); // "example.com"
        parentCount.set(parent, (parentCount.get(parent) ?? 0) + 1);
      }
    }

    const result = new Set(unique);
    for (const [parent, count] of parentCount) {
      // If 2+ subdomains share a parent, add wildcard
      if (count >= 2) {
        const wildcard = `*.${parent}`;
        if (!existingWildcards.has(wildcard)) {
          result.add(wildcard);
        }
      }
    }

    return [...result].sort();
  }

  // ── Preflight checks ──

  private async ensureMkcert(): Promise<void> {
    const mkcert = this.getMkcertPath();
    try {
      await execFileAsync(mkcert, ['-version']);
    } catch {
      const installLabel = IS_WINDOWS ? 'Install with Chocolatey' : 'Install with Homebrew';
      const action = await vscode.window.showErrorMessage(
        'mkcert is not installed.',
        installLabel,
        'Open Install Guide',
      );
      if (action === installLabel) {
        const term = vscode.window.createTerminal('mkcert install');
        term.show();
        term.sendText(IS_WINDOWS ? 'choco install mkcert' : 'brew install mkcert');
        throw new Error('Installing mkcert — please re-run after installation completes.');
      } else if (action === 'Open Install Guide') {
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/FiloSottile/mkcert#installation'));
      }
      throw new Error('mkcert is not installed.');
    }
  }

  private async ensureCA(): Promise<void> {
    const mkcert = this.getMkcertPath();

    // Get CAROOT path
    let caRoot: string;
    try {
      const { stdout } = await execFileAsync(mkcert, ['-CAROOT']);
      caRoot = stdout.trim();
    } catch {
      throw new Error('Failed to determine mkcert CAROOT.');
    }

    const rootCAPem = path.join(caRoot, 'rootCA.pem');
    if (fs.existsSync(rootCAPem)) {
      return; // CA already installed
    }

    // CA not installed — offer to run mkcert -install
    const hint = IS_WINDOWS
      ? '(Windows will prompt for administrator access)'
      : '(macOS will prompt for your password)';
    const action = await vscode.window.showWarningMessage(
      `mkcert CA is not installed. Install it now? ${hint}`,
      'Install CA',
      'Cancel',
    );

    if (action !== 'Install CA') {
      throw new Error('mkcert CA not installed. Run `mkcert -install` manually.');
    }

    try {
      await execFileAsync(mkcert, ['-install']);
      vscode.window.showInformationMessage('mkcert CA installed successfully.');
    } catch (err: unknown) {
      throw new Error(`Failed to install mkcert CA: ${errMsg(err)}`);
    }
  }

  // ── Certificate generation ──

  /** Check if cert exists and is not expiring within CERT_EXPIRY_BUFFER_MS. */
  private isCertValid(certPath: string): boolean {
    try {
      const pem = fs.readFileSync(certPath, 'utf-8');
      const cert = new crypto.X509Certificate(pem);
      const expiry = new Date(cert.validTo).getTime();
      return Date.now() + CERT_EXPIRY_BUFFER_MS < expiry;
    } catch {
      return false;
    }
  }

  /**
   * Generate or retrieve a cached cert for a single domain.
   * Disk cache with expiry check → mkcert generation.
   * Does NOT run preflight checks (call ensurePreflight() first).
   */
  private async ensureSingleDomainCert(domain: string): Promise<{ certBuf: Buffer; keyBuf: Buffer }> {
    const safeName = domain.replace(/\*/g, '_wildcard_').replace(/[^a-zA-Z0-9._-]/g, '_');
    const certPath = path.join(this.certDir, `${safeName}.pem`);
    const keyPath = path.join(this.certDir, `${safeName}-key.pem`);

    if (fs.existsSync(certPath) && fs.existsSync(keyPath) && this.isCertValid(certPath)) {
      return { certBuf: fs.readFileSync(certPath), keyBuf: fs.readFileSync(keyPath) };
    }

    await this.generateCertFiles([domain], certPath, keyPath);
    return { certBuf: fs.readFileSync(certPath), keyBuf: fs.readFileSync(keyPath) };
  }

  /** Resolve the mkcert rootCA.pem path (if available). */
  async getCARootPem(): Promise<string | undefined> {
    try {
      const mkcert = this.getMkcertPath();
      const { stdout } = await execFileAsync(mkcert, ['-CAROOT']);
      const rootCAPem = path.join(stdout.trim(), 'rootCA.pem');
      return fs.existsSync(rootCAPem) ? rootCAPem : undefined;
    } catch {
      return undefined;
    }
  }

  private async generateCertFiles(domains: string[], certPath: string, keyPath: string): Promise<void> {
    const mkcert = this.getMkcertPath();
    const args = ['-cert-file', certPath, '-key-file', keyPath, ...domains];

    try {
      await execFileAsync(mkcert, args);
    } catch (err: unknown) {
      throw new Error(`mkcert failed: ${errMsg(err)}`);
    }
  }
}
