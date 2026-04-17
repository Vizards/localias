import * as vscode from 'vscode';
import { validateDomain } from './validate';

const WILDCARD_HINT = '$(warning) Wildcard routes skip /etc/hosts — DNS is your responsibility';

/**
 * TLD-aware domain picker.
 * When the user types a bare name (no dot), shows candidates appended
 * with each configured TLD (e.g. `myapp` → `myapp.localhost`, `myapp.test`).
 * Wildcard prefix `*` is supported — `*myapp` suggests `*.myapp.localhost` etc.
 * When the input already contains a dot, it's treated as a full domain.
 */
export function pickDomain(title: string): Promise<string | undefined> {
  const tlds: string[] = vscode.workspace.getConfiguration('localias')
    .get<string[]>('tlds') ?? ['localhost'];

  return new Promise<string | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.title = title;
    qp.placeholder = tlds.length > 0
      ? `Type a name (e.g. myapp), full domain, or wildcard (*.example.com)`
      : 'dev.example.com or *.example.com';
    qp.keepScrollPosition = true;

    const buildItems = (value: string): vscode.QuickPickItem[] => {
      const trimmed = value.trim();
      if (!trimmed) return [];

      // Detect wildcard prefix: *myapp or *.myapp
      const isWild = trimmed.startsWith('*');
      // Strip leading *. or * to get the bare name
      const bare = isWild ? trimmed.replace(/^\*\.?/, '') : trimmed;

      // If the bare part already has a dot, treat as full domain
      if (bare.includes('.')) {
        const label = isWild ? `*.${bare}` : bare;
        return [{ label, detail: isWild ? WILDCARD_HINT : undefined }];
      }

      // Bare name (with or without * prefix) — suggest TLD-appended candidates
      if (bare && tlds.length > 0) {
        return tlds.map(tld => ({
          label: isWild ? `*.${bare}.${tld}` : `${bare}.${tld}`,
          description: tld,
          detail: isWild ? WILDCARD_HINT : undefined,
        }));
      }

      if (bare) {
        const label = isWild ? `*.${bare}` : bare;
        return [{ label, detail: isWild ? WILDCARD_HINT : undefined }];
      }

      return [];
    };

    qp.onDidChangeValue((value) => {
      qp.items = buildItems(value);
    });

    qp.onDidAccept(() => {
      const selected = (qp.selectedItems[0] ?? qp.activeItems[0])?.label ?? qp.value.trim();
      if (!selected) return;

      const err = validateDomain(selected);
      if (err) {
        vscode.window.showWarningMessage(err);
        return;
      }

      resolve(selected);
      qp.hide();
    });

    qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
    qp.show();
  });
}
