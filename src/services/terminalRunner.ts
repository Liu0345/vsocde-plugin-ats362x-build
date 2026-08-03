import * as vscode from 'vscode';
import { BuiltCommand } from './commandBuilder';
import { shellQuote } from './shell';

export class TerminalRunner {
  private terminal?: vscode.Terminal;

  public async run(command: BuiltCommand, cwd: string): Promise<void> {
    if (command.destructive) {
      const answer = await vscode.window.showWarningMessage(
        '全擦除会清除设备 Flash 中的全部内容，确认继续吗？',
        { modal: true },
        '确认全擦除'
      );
      if (answer !== '确认全擦除') {
        return;
      }
    }

    const configuration = vscode.workspace.getConfiguration('ats362xBuild');
    const executable = command.executable === 'baton'
      ? configuration.get<string>('batonPath', 'baton')
      : command.executable === 'actions-flash'
        ? configuration.get<string>('actionsFlashPath', 'actions-flash')
        : configuration.get<string>('dfuUtilPath', 'dfu-util');
    const line = [executable, ...command.args].map(shellQuote).join(' ');

    if (!this.terminal || this.terminal.exitStatus !== undefined) {
      this.terminal = vscode.window.createTerminal({ name: 'ATS362X', cwd });
    }
    this.terminal.show(true);
    this.terminal.sendText(line, true);
  }
}
