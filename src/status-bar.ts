import * as vscode from 'vscode';

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private running = false;
  private routeCount = 0;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.setStopped();
    this.item.show();
  }

  get isRunning(): boolean {
    return this.running;
  }

  setRunning(routeCount: number, remote = false): void {
    this.running = true;
    this.routeCount = routeCount;
    this.item.text = `$(localias-icon) Localias`;
    this.item.color = new vscode.ThemeColor('terminal.ansiGreen');
    this.item.backgroundColor = undefined;
    this.item.command = 'localias.statusBarMenu';

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(remote
      ? `**Localias** &mdash; Running (another window)\n\n`
      : `**Localias** &mdash; Running\n\n`);
    md.appendMarkdown(routeCount > 0
      ? `$(pass) ${routeCount} route(s) active\n\n`
      : `$(info) No routes configured\n\n`);
    md.appendMarkdown(`$(info) Click for options`);
    this.item.tooltip = md;
  }

  setStopped(): void {
    this.running = false;
    this.routeCount = 0;
    this.item.text = '$(localias-icon) Localias';
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
    this.item.command = 'localias.statusBarMenu';

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**Localias** &mdash; Stopped\n\n`);
    md.appendMarkdown(`$(info) Click for options`);
    this.item.tooltip = md;
  }

  async showMenu(): Promise<void> {
    type MenuItem = vscode.QuickPickItem & { cmd?: string };
    const items: MenuItem[] = [];

    if (this.running) {
      items.push(
        { label: '$(debug-stop) Stop Server', cmd: 'localias.stop' },
        { label: '$(refresh) Restart Server', cmd: 'localias.start' },
      );
      if (this.routeCount > 0) {
        items.push({ label: `$(pass) ${this.routeCount} route(s) active`, kind: vscode.QuickPickItemKind.Separator });
      }
    } else {
      items.push(
        { label: '$(play) Start Server', cmd: 'localias.start' },
      );
    }

    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(add) Add Route', cmd: 'localias.addRoute' },
      { label: '$(list-tree) Show Routes', cmd: 'localias.routes.focus' },
      { label: '$(gear) Settings', cmd: 'localias.openSettings' },
    );

    const pick = await vscode.window.showQuickPick(items, { title: 'Localias', placeHolder: 'Select an action' });
    if (pick?.cmd) {
      vscode.commands.executeCommand(pick.cmd);
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
