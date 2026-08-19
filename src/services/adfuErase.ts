import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SerialPort } from 'serialport';

const execFileAsync = promisify(execFile);

export interface AdfuLocation {
  locationId: number;
  slotId: string;
}

export interface TemporaryEraseInventory {
  path: string;
  device: string;
  dispose(): Promise<void>;
}

interface IoregDevice {
  vendorId?: number;
  productId?: number;
  locationId?: number;
  configured: boolean;
}

export function slotIdFromLocationId(locationId: number): string | undefined {
  const hex = locationId.toString(16).padStart(8, '0');
  const trimmed = hex.replace(/0+$/, '');
  if (trimmed.length < 4) return undefined;
  const bus = Number.parseInt(trimmed.slice(0, 2), 16);
  const route = trimmed.slice(2);
  const pathDigits = route.slice(0, -1);
  const port = Number.parseInt(route.slice(-1), 16);
  if (!Number.isInteger(bus) || !pathDigits || !Number.isInteger(port) || port <= 0) return undefined;
  const segments = [...pathDigits].map((digit) => Number.parseInt(digit, 16));
  if (segments.some((segment) => !Number.isInteger(segment))) return undefined;
  return `${bus}-${segments.join('.')}/${port}`;
}

export function parseMacAdfuLocation(output: string, vendorId: number, productId: number): AdfuLocation | undefined {
  const devices: IoregDevice[] = [];
  let current: IoregDevice | undefined;
  const finish = (): void => {
    if (current) devices.push(current);
    current = undefined;
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.includes('<class IOUSBHostDevice')) {
      finish();
      current = { configured: false };
      continue;
    }
    if (!current) continue;
    const trimmed = line.replace(/^[|\s]+/, '').trim();
    const match = trimmed.match(/^"([^"]+)"\s*=\s*(0x[0-9a-f]+|\d+)$/i);
    if (!match) continue;
    const value = Number.parseInt(match[2], match[2].startsWith('0x') ? 16 : 10);
    if (match[1] === 'idVendor') current.vendorId = value;
    if (match[1] === 'idProduct') current.productId = value;
    if (match[1] === 'locationID') current.locationId = value;
    if (match[1] === 'kUSBCurrentConfiguration') current.configured = value !== 0;
  }
  finish();

  for (const device of devices) {
    if (!device.configured || device.vendorId !== vendorId || device.productId !== productId || device.locationId === undefined) continue;
    const slotId = slotIdFromLocationId(device.locationId);
    if (slotId) return { locationId: device.locationId, slotId };
  }
  return undefined;
}

export async function waitForMacAdfuLocation(
  vendorId: number,
  productId: number,
  timeoutSeconds: number,
  signal?: AbortSignal
): Promise<AdfuLocation> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  do {
    throwIfAborted(signal);
    const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-p', 'IOUSB', '-r', '-c', 'IOUSBHostDevice', '-l', '-w0']);
    const location = parseMacAdfuLocation(stdout, vendorId, productId);
    if (location) return location;
    await abortableDelay(500, signal);
  } while (Date.now() < deadline);
  throw new Error(`在 ${timeoutSeconds} 秒内未检测到 USB ADFU ${hex4(vendorId)}:${hex4(productId)}`);
}

/** 直接通过运行态 Shell 串口进入 ADFU，避免 Baton 在旧槽位上无限等待。 */
export async function sendShellAdfuCommand(
  portPath: string,
  baudRate: number,
  command: string,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  const serial = new SerialPort({ path: portPath, baudRate, autoOpen: false, lock: true });
  const chunks: Buffer[] = [];
  const onData = (data: Buffer): void => {
    chunks.push(data);
  };
  serial.on('data', onData);
  try {
    await openSerial(serial);
    await writeSerial(serial, '\r\n');
    await abortableDelay(250, signal);
    await writeSerial(serial, `${command.trim()}\r\n`);
    await abortableDelay(1000, signal);
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    serial.off('data', onData);
    if (serial.isOpen) await closeSerial(serial);
  }
}

/** 擦除负载异常断开 USB 后，通过同一串口控制线复位回 BROM/ADFU。 */
export async function pulseSerialResetLines(portPath: string, signal?: AbortSignal): Promise<void> {
  const serial = new SerialPort({ path: portPath, baudRate: 3000000, autoOpen: false, lock: true });
  try {
    await openSerial(serial);
    for (const [dtr, rts, delay] of [
      [false, false, 300], [true, false, 300], [false, true, 300], [true, true, 300], [false, false, 500]
    ] as Array<[boolean, boolean, number]>) {
      throwIfAborted(signal);
      await setSerialSignals(serial, dtr, rts);
      await abortableDelay(delay, signal);
    }
  } finally {
    if (serial.isOpen) await closeSerial(serial);
  }
}

export async function createTemporaryEraseInventory(slotId: string, shellPort?: string): Promise<TemporaryEraseInventory> {
  const sourcePath = path.join(os.homedir(), '.config', 'baton', 'inventory.json');
  let inventory: { version?: number; slots?: Array<Record<string, unknown>> };
  try {
    inventory = JSON.parse(await fs.readFile(sourcePath, 'utf8')) as typeof inventory;
  } catch (error) {
    throw new Error(`无法读取 Baton 设备清单 ${sourcePath}：${error instanceof Error ? error.message : String(error)}`);
  }
  const slots = Array.isArray(inventory.slots) ? inventory.slots : [];
  const matching = shellPort
    ? slots.find((slot) => slot.uart === shellPort || slot.shell_uart === shellPort)
    : undefined;
  const source = matching ?? slots.find((slot) => slot.state === 'online') ?? slots[0];
  if (!source) throw new Error('Baton 设备清单为空，无法为 ADFU 擦除建立临时物理槽位');

  const now = new Date().toISOString();
  const slot: Record<string, unknown> = {
    ...source,
    slot_id: slotId,
    alias: 1,
    state: 'online',
    last_seen: now
  };
  if (shellPort) {
    slot.uart = shellPort;
    slot.shell_uart = shellPort;
    slot.uart_source = 'manual';
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats362x-adfu-erase-'));
  const inventoryPath = path.join(directory, 'inventory.json');
  await fs.writeFile(inventoryPath, `${JSON.stringify({ version: inventory.version ?? 1, slots: [slot] }, null, 2)}\n`, 'utf8');
  return {
    path: inventoryPath,
    device: '1',
    dispose: () => fs.rm(directory, { recursive: true, force: true })
  };
}

function openSerial(serial: SerialPort): Promise<void> {
  return new Promise((resolve, reject) => serial.open((error) => error ? reject(error) : resolve()));
}

function closeSerial(serial: SerialPort): Promise<void> {
  return new Promise((resolve) => serial.close(() => resolve()));
}

function writeSerial(serial: SerialPort, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    serial.write(text, (writeError) => {
      if (writeError) return reject(writeError);
      serial.drain((drainError) => drainError ? reject(drainError) : resolve());
    });
  });
}

function setSerialSignals(serial: SerialPort, dtr: boolean, rts: boolean): Promise<void> {
  return new Promise((resolve, reject) => serial.set({ dtr, rts }, (error) => error ? reject(error) : resolve()));
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('全擦除已取消'));
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('全擦除已取消');
}

function hex4(value: number): string {
  return value.toString(16).padStart(4, '0');
}
