import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import { IdlePacketAssembler, validatePacketTimeout } from './communicationCodec';

export type CommunicationDirection = 'rx' | 'tx';

export interface CommunicationConnectionStatus {
  connected: boolean;
  target?: string;
  detail: string;
}

export interface UartCommunicationOptions {
  path: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
  flowControl?: 'none' | 'rtscts' | 'xonxoff';
  packetTimeoutMs: number;
}

interface SerialHandle extends EventEmitter {
  isOpen: boolean;
  open(callback: (error?: Error | null) => void): void;
  write(data: Uint8Array, callback: (error?: Error | null) => void): void;
  drain(callback: (error?: Error | null) => void): void;
  close(callback: (error?: Error | null) => void): void;
  set?(options: { dtr: boolean; rts: boolean }, callback: (error?: Error | null) => void): void;
}

type SerialFactory = (options: {
  path: string;
  baudRate: number;
  autoOpen: false;
  lock: true;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  rtscts: boolean;
  xon: boolean;
  xoff: boolean;
  xany: boolean;
}) => SerialHandle;

/** 稳定的单会话串口通讯服务：生命周期和写操作分别严格串行化。 */
export class UartCommunicationService {
  private serial?: SerialHandle;
  private assembler?: IdlePacketAssembler;
  private lifecycle: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private generation = 0;

  public constructor(
    private readonly onPacket: (direction: CommunicationDirection, packet: Buffer) => void,
    private readonly onStatus: (status: CommunicationConnectionStatus) => void,
    private readonly serialFactory: SerialFactory = (options) => new SerialPort(options) as SerialHandle
  ) {}

  public get isConnected(): boolean {
    return this.serial?.isOpen === true;
  }

  public connect(options: UartCommunicationOptions): Promise<void> {
    return this.enqueueLifecycle(async () => {
      const portPath = options.path.trim();
      if (!portPath) throw new Error('请选择串口');
      if (!Number.isInteger(options.baudRate) || options.baudRate < 9600 || options.baudRate > 3_000_000) {
        throw new Error('UART 波特率必须在 9600 到 3000000 之间');
      }
      const packetTimeoutMs = validatePacketTimeout(options.packetTimeoutMs);
      const dataBits = options.dataBits ?? 8;
      const stopBits = options.stopBits ?? 1;
      const parity = options.parity ?? 'none';
      const flowControl = options.flowControl ?? 'none';
      if (![5, 6, 7, 8].includes(dataBits)) throw new Error('UART 数据位必须是 5、6、7 或 8');
      if (![1, 2].includes(stopBits)) throw new Error('UART 停止位必须是 1 或 2');
      if (!['none', 'even', 'odd', 'mark', 'space'].includes(parity)) throw new Error('UART 校验位设置无效');
      if (!['none', 'rtscts', 'xonxoff'].includes(flowControl)) throw new Error('UART 流控设置无效');
      await this.disconnectCurrent(false);

      const serial = this.serialFactory({
        path: portPath,
        baudRate: options.baudRate,
        autoOpen: false,
        lock: true,
        dataBits,
        stopBits,
        parity,
        rtscts: flowControl === 'rtscts',
        xon: flowControl === 'xonxoff',
        xoff: flowControl === 'xonxoff',
        xany: false
      });
      const generation = ++this.generation;
      const assembler = new IdlePacketAssembler(packetTimeoutMs, (packet) => {
        if (this.generation === generation && this.serial === serial) this.onPacket('rx', packet);
      });
      const onData = (data: Uint8Array): void => assembler.push(data);
      const onError = (error: Error): void => {
        if (this.generation !== generation || this.serial !== serial) return;
        this.onStatus({ connected: false, target: portPath, detail: `串口错误：${error.message}` });
        void this.enqueueLifecycle(() => this.disconnectCurrent(false));
      };
      const onClose = (): void => {
        if (this.generation !== generation || this.serial !== serial) return;
        assembler.dispose();
        this.serial = undefined;
        this.assembler = undefined;
        this.onStatus({ connected: false, target: portPath, detail: '串口已断开' });
      };
      serial.on('data', onData);
      serial.on('error', onError);
      serial.on('close', onClose);

      try {
        await callbackPromise((done) => serial.open(done));
      } catch (error) {
        serial.removeListener('data', onData);
        serial.removeListener('error', onError);
        serial.removeListener('close', onClose);
        assembler.dispose();
        if (serial.isOpen) await callbackPromise((done) => serial.close(done)).catch(() => undefined);
        throw new Error(`无法打开串口 ${portPath}：${errorMessage(error)}`);
      }
      this.serial = serial;
      this.assembler = assembler;
      this.onStatus({ connected: true, target: portPath, detail: `${portPath} @ ${options.baudRate}` });
    });
  }

  public send(payload: Uint8Array): Promise<void> {
    const bytes = Buffer.from(payload);
    if (bytes.length === 0) throw new Error('发送数据不能为空');
    const operation = this.writes.then(async () => {
      const serial = this.serial;
      if (!serial?.isOpen) throw new Error('UART 尚未连接');
      await callbackPromise((done) => serial.write(bytes, done));
      await callbackPromise((done) => serial.drain(done));
      if (this.serial !== serial || !serial.isOpen) throw new Error('UART 在发送过程中断开');
      this.onPacket('tx', bytes);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  public disconnect(): Promise<void> {
    return this.enqueueLifecycle(() => this.disconnectCurrent(true));
  }

  public setPacketTimeout(timeoutMs: number): void {
    this.assembler?.setTimeoutMs(timeoutMs);
  }

  public setSignals(dtr: boolean, rts: boolean): Promise<void> {
    const serial = this.serial;
    if (!serial?.isOpen) throw new Error('UART 尚未连接');
    if (!serial.set) throw new Error('当前串口后端不支持 DTR/RTS 控制');
    return callbackPromise((done) => serial.set?.({ dtr, rts }, done));
  }

  public dispose(): void {
    void this.disconnect();
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.catch(() => undefined);
    return result;
  }

  private async disconnectCurrent(announce: boolean): Promise<void> {
    const serial = this.serial;
    const assembler = this.assembler;
    const target = serial ? undefined : undefined;
    ++this.generation;
    this.serial = undefined;
    this.assembler = undefined;
    assembler?.dispose();
    if (serial) {
      serial.removeAllListeners('data');
      serial.removeAllListeners('error');
      serial.removeAllListeners('close');
      if (serial.isOpen) await callbackPromise((done) => serial.close(done)).catch(() => undefined);
    }
    if (announce) this.onStatus({ connected: false, target, detail: '串口已断开' });
  }
}

function callbackPromise(register: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => register((error) => error ? reject(error) : resolve()));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
