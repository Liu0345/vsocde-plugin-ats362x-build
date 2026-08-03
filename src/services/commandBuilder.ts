import { RunRequest } from '../types';
import { buildUsbDfuArgs } from './usbDfu';

export interface BuiltCommand {
  executable: 'baton' | 'actions-flash' | 'dfu-util';
  args: string[];
  destructive?: boolean;
}

export function buildCommand(request: RunRequest, firmware?: string): BuiltCommand {
  const value = request.options;
  switch (request.action) {
    case 'build': {
      const args = ['build'];
      addOption(args, '--build-host', value.buildHost);
      addOption(args, '--download', value.download);
      addOption(args, '--app', value.app);
      addOption(args, '--board', value.board);
      addFlag(args, '--dsp-only', value.dspOnly);
      addFlag(args, '--skip-dsp', value.skipDsp);
      addFlag(args, '--keep', value.keep);
      addFlag(args, '--emit-map-summary', value.mapSummary);
      return { executable: 'baton', args };
    }
    case 'buildFlashVerify': {
      const args = ['build-flash-verify'];
      addOption(args, '--build-host', value.buildHost);
      addOption(args, '--download', value.download);
      addOption(args, '--board', value.board);
      return { executable: 'baton', args };
    }
    case 'flash': {
      const args = ['flash'];
      if (firmware) args.push(firmware);
      addOption(args, '--method', value.method);
      addOption(args, '--entry', value.entry);
      addOption(args, '--verify', value.verify);
      addOption(args, '--board', value.board);
      addOption(args, '--uart', value.uart);
      addOption(args, '--baud', value.baud);
      addOption(args, '--timeout', value.timeout);
      addOption(args, '--adfu-vid-pid', value.vidPid);
      addFlag(args, '--dry-run', value.dryRun);
      return { executable: 'baton', args };
    }
    case 'usbDfu': {
      if (!firmware) throw new Error('需要先选择 USB DFU 固件');
      const usbPath = requiredOption(value.usbPath, 'USB DFU 设备路径');
      const vidPid = requiredOption(value.vidPid, 'USB DFU 设备 VID:PID').split(':');
      if (vidPid.length !== 2 || vidPid.some((part) => !/^[0-9a-f]{4}$/i.test(part))) {
        throw new Error('USB DFU 设备 VID:PID 格式无效');
      }
      const args = buildUsbDfuArgs({
        vendorId: Number.parseInt(vidPid[0], 16),
        productId: Number.parseInt(vidPid[1], 16),
        usbPath,
        alt: Number(value.alt ?? 0)
      }, firmware, value.reset === true);
      return { executable: 'dfu-util', args };
    }
    case 'verify': {
      const args = ['verify'];
      addOption(args, '--board', value.board);
      return { executable: 'baton', args };
    }
    case 'erase': {
      const args = ['erase-flash'];
      addOption(args, '--entry', value.entry);
      addOption(args, '--size', value.size);
      addOption(args, '--timeout', value.timeout);
      addOption(args, '--adfu-vid-pid', value.vidPid);
      addOption(args, '--shell-port', value.shellPort);
      addOption(args, '--shell-baud', value.shellBaud);
      addOption(args, '--shell-cmd', value.shellCmd);
      addFlag(args, '--dry-run', value.dryRun);
      return { executable: 'baton', args, destructive: !value.dryRun };
    }
    case 'doctor':
      return { executable: 'baton', args: ['doctor'] };
    case 'discover':
      return { executable: 'baton', args: ['discover'] };
    case 'status':
      return { executable: 'baton', args: ['status'] };
    case 'listAdfu':
      return { executable: 'actions-flash', args: ['list'] };
    case 'extractFw': {
      if (!firmware) throw new Error('需要先选择 .fw 固件');
      const args = ['extract-fw', '--fw', firmware];
      addOption(args, '--out-dir', value.outDir);
      return { executable: 'actions-flash', args };
    }
    default:
      throw new Error(`不支持的操作：${request.action}`);
  }
}

function addOption(args: string[], name: string, value: unknown): void {
  if (value !== undefined && value !== null && String(value).trim() !== '') {
    args.push(name, String(value));
  }
}

function addFlag(args: string[], name: string, value: unknown): void {
  if (value === true) args.push(name);
}

function requiredOption(value: unknown, label: string): string {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`需要先选择${label}`);
  }
  return String(value);
}
