import * as vscode from 'vscode';
import { ProjectStore } from './services/projectStore';
import { Ats362xSidebarProvider } from './sidebarProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const projects = new ProjectStore(context);
  await projects.initialize();
  const provider = new Ats362xSidebarProvider(context, projects);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ats362xBuild.sidebar', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('ats362xBuild.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.ats362xBuild');
    }),
    vscode.commands.registerCommand('ats362xBuild.selectProject', async () => {
      await provider.selectProject();
    })
  );
}

export function deactivate(): void {
  // VS Code 会释放终端、Webview 与扩展上下文资源。
}
