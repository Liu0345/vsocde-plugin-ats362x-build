export type CommunicationDataMode = 'text' | 'hex';
export type CommunicationLineEnding = 'none' | 'cr' | 'lf' | 'crlf';

export function encodeCommunicationData(value: string, mode: CommunicationDataMode): Buffer {
  if (mode === 'text') return Buffer.from(value, 'utf8');
  const normalized = value
    .replace(/0x/gi, '')
    .replace(/[\s,;:_-]+/g, '');
  if (!normalized) return Buffer.alloc(0);
  if (!/^[0-9a-f]+$/i.test(normalized)) throw new Error('十六进制数据只能包含 0-9、A-F 和常用分隔符');
  if (normalized.length % 2 !== 0) throw new Error('十六进制数据长度必须是偶数');
  return Buffer.from(normalized, 'hex');
}

export function formatCommunicationData(data: Uint8Array, mode: CommunicationDataMode): string {
  const buffer = Buffer.from(data);
  if (mode === 'text') return buffer.toString('utf8');
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function appendLineEnding(value: string, lineEnding: CommunicationLineEnding): string {
  const endings: Record<CommunicationLineEnding, string> = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' };
  return value + endings[lineEnding];
}

export function validatePacketTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 5000) throw new Error('分包超时必须是 1 到 5000 毫秒的整数');
  return value;
}

export function prepareHidReport(payload: Uint8Array, reportId: number, reportLength: number, padToLength: boolean): Buffer {
  if (!Number.isInteger(reportId) || reportId < 0 || reportId > 255) throw new Error('HID Report ID 必须是 0 到 255');
  if (!Number.isInteger(reportLength) || reportLength < 1 || reportLength > 4096) throw new Error('HID 报告长度必须是 1 到 4096 字节');
  const data = Buffer.from(payload);
  const maximumPayload = reportLength - 1;
  if (data.length > maximumPayload) throw new Error(`HID 数据 ${data.length} 字节超过报告有效载荷 ${maximumPayload} 字节`);
  if (!padToLength) return Buffer.concat([Buffer.from([reportId]), data]);
  const report = Buffer.alloc(reportLength);
  report[0] = reportId;
  data.copy(report, 1);
  return report;
}

/** 将连续到达的数据按空闲间隔合并成稳定的数据包。 */
export class IdlePacketAssembler {
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private timer?: NodeJS.Timeout;
  private timeoutMs: number;

  public constructor(
    timeoutMs: number,
    private readonly onPacket: (packet: Buffer) => void,
    private readonly maximumPacketBytes = 64 * 1024
  ) {
    this.timeoutMs = validatePacketTimeout(timeoutMs);
    if (!Number.isInteger(maximumPacketBytes) || maximumPacketBytes < 1) throw new Error('最大分包长度必须是正整数');
  }

  public setTimeoutMs(timeoutMs: number): void {
    this.timeoutMs = validatePacketTimeout(timeoutMs);
    if (this.chunks.length > 0) this.arm();
  }

  public push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    let remaining = Buffer.from(chunk);
    while (remaining.length > 0) {
      const capacity = this.maximumPacketBytes - this.bufferedBytes;
      if (capacity === 0) this.flush();
      const take = Math.min(this.maximumPacketBytes - this.bufferedBytes, remaining.length);
      this.chunks.push(remaining.subarray(0, take));
      this.bufferedBytes += take;
      remaining = remaining.subarray(take);
      if (this.bufferedBytes >= this.maximumPacketBytes) this.flush();
    }
    if (this.bufferedBytes > 0) this.arm();
  }

  public flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.chunks.length === 0) return;
    const packet = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bufferedBytes = 0;
    this.onPacket(packet);
  }

  public dispose(): void {
    this.flush();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.timeoutMs);
  }
}
