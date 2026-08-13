import { SerialPort } from 'serialport';
import {
  IdentityAction,
  IdentityCommands,
  IdentityEvent,
  IdentityRequest,
  IdentityResult,
  IdentityStatus,
  IdentityTarget
} from '../types';

const DEFAULT_TOKEN_URL = 'https://factory-auth.pawpaw.cn:1984/token';
const DEFAULT_SN_URL = 'https://factory-auth.pawpaw.cn:1984/pawpaw-harman/sn';
const ZERO_KEY = '00'.repeat(256);
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const LONG_HEX_PATTERN = /\b[0-9a-f]{128,}\b/gi;
const AUTHORIZATION_VERIFY_TIMEOUT_MS = 20000;
const AUTHORIZATION_VERIFY_INTERVAL_MS = 1000;

interface DeviceIdentityInfo {
  factory: string;
  chipId: string;
  flashId: string;
  modelVersion: string;
  product: string;
  checkDigit: string;
}

interface SnStatus {
  status: string;
  error: string;
}

interface RunContext {
  request: IdentityRequest;
  serial: IdentitySerialSession;
  signal: AbortSignal;
  emit: (event: Omit<IdentityEvent, 'id' | 'timestamp'>) => void;
}

export interface IdentityServiceOptions {
  tokenUrl?: string;
  snUrl?: string;
  commandTimeoutMs?: number;
  httpTimeoutMs?: number;
}

/**
 * 直接执行两套设备身份授权协议。
 *
 * 每次操作独占一个串口会话；算法身份和 SN 身份的状态、写入与清除互不
 * 依赖。两套身份写入后都必须查询各自的最终校验状态；写入回读成功只作为
 * 中间步骤，不能替代授权有效性。密码、令牌和长密钥不会进入页面日志。
 */
export class IdentityAuthorizationService {
  private readonly tokenUrl: string;
  private readonly snUrl: string;
  private readonly commandTimeoutMs: number;
  private readonly httpTimeoutMs: number;
  private active?: AbortController;
  private eventId = 0;

  public constructor(options: IdentityServiceOptions = {}) {
    this.tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.snUrl = options.snUrl ?? DEFAULT_SN_URL;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 8000;
    this.httpTimeoutMs = options.httpTimeoutMs ?? 15000;
  }

  public get busy(): boolean {
    return this.active !== undefined;
  }

  public cancel(): void {
    this.active?.abort(new Error('用户已取消身份认证操作'));
  }

  public async run(
    request: IdentityRequest,
    onEvent: (event: IdentityEvent) => void
  ): Promise<IdentityResult> {
    if (this.active) {
      throw new Error('已有身份认证操作正在执行，请等待完成或先取消');
    }
    validateRequest(request);

    const controller = new AbortController();
    this.active = controller;
    const emit = (event: Omit<IdentityEvent, 'id' | 'timestamp'>): void => {
      onEvent({
        ...event,
        id: ++this.eventId,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      });
    };
    const serial = new IdentitySerialSession(
      request.port,
      request.baudRate,
      this.commandTimeoutMs,
      controller.signal
    );

    try {
      emit({ target: targetForAction(request.action), level: 'pending', title: '正在打开串口', detail: `${request.port} · ${request.baudRate.toLocaleString()} baud` });
      await serial.open();
      emit({ target: targetForAction(request.action), level: 'success', title: '串口连接成功' });
      const context: RunContext = { request, serial, signal: controller.signal, emit };
      return await this.dispatch(context);
    } catch (error) {
      const message = toErrorMessage(error);
      emit({ target: targetForAction(request.action), level: 'error', title: '操作失败', detail: message });
      return {
        target: targetForAction(request.action),
        status: 'error',
        summary: message
      };
    } finally {
      await serial.close();
      this.active = undefined;
    }
  }

  private async dispatch(context: RunContext): Promise<IdentityResult> {
    switch (context.request.action) {
      case 'checkAlgorithm':
        return this.checkAlgorithm(context);
      case 'authorizeAlgorithm':
        return this.authorizeAlgorithm(context);
      case 'clearAlgorithm':
        return this.clearAlgorithm(context);
      case 'checkSn':
        return this.checkSn(context);
      case 'authorizeSn':
        return this.authorizeSn(context);
      case 'clearSn':
        return this.clearSn(context);
      case 'runCustom':
        return this.runCustom(context);
    }
  }

  private async checkAlgorithm(context: RunContext, emit = true): Promise<IdentityResult> {
    const response = await this.send(context, 'algorithm', '查询算法授权状态', context.request.commands.algorithmStatus, ['auth_flag ok', 'auth_flag fail']);
    const status = parseAlgorithmStatus(response);
    const result: IdentityResult = {
      target: 'algorithm',
      status,
      summary: status === 'authorized' ? '算法身份授权正常' : status === 'unauthorized' ? '算法身份未授权' : '无法判断算法身份状态'
    };
    if (emit) this.emitResult(context, result);
    return result;
  }

  private async authorizeAlgorithm(context: RunContext): Promise<IdentityResult> {
    const current = await this.checkAlgorithm(context);
    if (current.status === 'authorized') {
      return current;
    }

    const infoResponse = await this.send(context, 'algorithm', '读取算法身份信息', context.request.commands.algorithmInfo, ['product']);
    const info = parseAlgorithmIdentityInfo(infoResponse);
    context.emit({ target: 'algorithm', level: 'success', title: '算法身份信息完整', detail: `${info.factory} · ${info.product}` });

    const token = await this.login(context, 'algorithm');
    const key = await this.requestSn(context, 'algorithm', token, info);
    await this.send(
      context,
      'algorithm',
      '写入算法授权密钥',
      renderCommand(context.request.commands.algorithmWrite, { key, zeroKey: ZERO_KEY }),
      ['set_key ok']
    );
    context.emit({
      target: 'algorithm',
      level: 'success',
      title: '算法密钥写入并回读校验成功',
      detail: '继续检查设备端算法授权状态'
    });
    await this.rebootAndReconnectIfEnabled(context, 'algorithm');

    const verified = await this.waitForAuthorized(
      context,
      'algorithm',
      () => this.checkAlgorithm(context, false)
    );
    if (verified.status !== 'authorized') {
      throw new Error('算法密钥已写入并回读一致，但设备端最终算法校验未通过');
    }
    this.emitResult(context, verified);
    return verified;
  }

  private async clearAlgorithm(context: RunContext): Promise<IdentityResult> {
    const peerBefore = await this.checkPeerAuthorization(context, 'algorithm');
    const clearCommand = validateIsolatedClearCommand(
      'algorithm',
      context.request.commands.algorithmClear
    );
    await this.send(
      context,
      'algorithm',
      '清除算法授权',
      renderCommand(clearCommand, { key: ZERO_KEY, zeroKey: ZERO_KEY }),
      ['set_key ok']
    );
    await this.rebootAndReconnectIfEnabled(context, 'algorithm');
    const verified = await this.checkAlgorithm(context);
    if (verified.status !== 'unauthorized') {
      throw new Error(verified.status === 'authorized' ? '算法授权清除后复核仍为已授权' : '算法授权清除后无法确认未授权状态');
    }
    const peerAfter = await this.checkPeerAuthorization(context, 'algorithm');
    this.assertPeerAuthorizationUnchanged(context, 'algorithm', peerBefore, peerAfter);
    return verified;
  }

  private async checkSn(context: RunContext): Promise<IdentityResult> {
    const response = await this.send(context, 'sn', '查询 SN 授权状态', context.request.commands.snStatus, ['sn_status']);
    const parsed = parseSnStatus(response);
    const status = snAuthorizationStatus(parsed);
    const result: IdentityResult = {
      target: 'sn',
      status,
      summary: status === 'authorized' ? 'SN 身份授权正常' : status === 'unauthorized' ? 'SN 身份未授权' : '无法判断 SN 身份状态',
      fields: { sn_status: parsed.status, sn_error: parsed.error }
    };
    this.emitResult(context, result);
    return result;
  }

  private async authorizeSn(context: RunContext): Promise<IdentityResult> {
    const current = await this.checkSn(context);
    if (current.status === 'authorized') {
      return current;
    }

    const infoResponse = await this.send(context, 'sn', '读取 SN 设备身份信息', context.request.commands.snInfo, ['product=']);
    const info = parseDeviceIdentityInfo(infoResponse);
    context.emit({ target: 'sn', level: 'success', title: 'SN 设备信息完整', detail: `${info.factory} · ${info.product}` });

    const token = await this.login(context, 'sn');
    const key = await this.requestSn(context, 'sn', token, info);
    await this.send(
      context,
      'sn',
      '写入 SN 授权数据',
      renderCommand(context.request.commands.snWrite, { key, zeroKey: ZERO_KEY }),
      ['sn write completed']
    );
    await this.rebootAndReconnectIfEnabled(context, 'sn');

    const verified = context.request.rebootAfterWrite
      ? await this.waitForAuthorized(context, 'sn', () => this.checkSn(context))
      : await this.checkSn(context);
    if (verified.status !== 'authorized') {
      throw new Error('SN 写入后复核仍未授权，请检查签名字符串与 OTP 写入状态');
    }
    return verified;
  }

  private async clearSn(context: RunContext): Promise<IdentityResult> {
    const peerBefore = await this.checkPeerAuthorization(context, 'sn');
    const clearCommand = validateIsolatedClearCommand(
      'sn',
      context.request.commands.snClear
    );
    await this.send(
      context,
      'sn',
      '清除 SN 授权',
      renderCommand(clearCommand, { key: ZERO_KEY, zeroKey: ZERO_KEY }),
      ['sn write completed']
    );
    await this.rebootAndReconnectIfEnabled(context, 'sn');
    const verified = await this.checkSn(context);
    if (verified.status !== 'unauthorized') {
      throw new Error(verified.status === 'authorized' ? 'SN 授权清除后复核仍为已授权' : 'SN 授权清除后无法确认未授权状态');
    }
    const peerAfter = await this.checkPeerAuthorization(context, 'sn');
    this.assertPeerAuthorizationUnchanged(context, 'sn', peerBefore, peerAfter);
    return verified;
  }

  /** 清除一项身份前后只读检查另一项，检测设备端存储串扰而不阻塞清除命令。 */
  private async checkPeerAuthorization(
    context: RunContext,
    clearedTarget: Exclude<IdentityTarget, 'system'>
  ): Promise<IdentityResult | undefined> {
    const peerTarget = clearedTarget === 'algorithm' ? 'sn' : 'algorithm';
    try {
      return peerTarget === 'algorithm'
        ? await this.checkAlgorithm(context)
        : await this.checkSn(context);
    } catch (error) {
      context.emit({
        target: clearedTarget,
        level: 'warning',
        title: '无法交叉检查另一项授权',
        detail: `${peerTarget === 'algorithm' ? '算法身份' : 'SN 身份'}：${toErrorMessage(error)}`
      });
      return undefined;
    }
  }

  /** 仅在清除前后均获得明确状态时比较，避免把通信异常误报为授权被清除。 */
  private assertPeerAuthorizationUnchanged(
    context: RunContext,
    clearedTarget: Exclude<IdentityTarget, 'system'>,
    before: IdentityResult | undefined,
    after: IdentityResult | undefined
  ): void {
    const peerName = clearedTarget === 'algorithm' ? 'SN 身份授权' : '算法身份授权';
    const known = (result: IdentityResult | undefined): result is IdentityResult =>
      result?.status === 'authorized' || result?.status === 'unauthorized';
    if (!known(before) || !known(after)) {
      context.emit({ target: clearedTarget, level: 'warning', title: `未能确认${peerName}是否保持不变` });
      return;
    }
    if (before.status !== after.status) {
      throw new Error(`清除当前授权后${peerName}状态发生变化，已停止报告成功，请检查设备端授权存储隔离`);
    }
    context.emit({
      target: clearedTarget,
      level: 'success',
      title: `已确认${peerName}未受影响`,
      detail: before.status === 'authorized' ? '仍为已授权' : '仍为未授权'
    });
  }

  private async runCustom(context: RunContext): Promise<IdentityResult> {
    const command = context.request.customCommand?.trim();
    if (!command) {
      throw new Error('请输入要执行的 Shell 命令');
    }
    const response = await this.send(context, 'system', '执行自定义命令', command);
    const result: IdentityResult = {
      target: 'system',
      status: 'unknown',
      summary: '自定义命令执行完成',
      fields: { response: sanitizeOutput(response) }
    };
    this.emitResult(context, result);
    return result;
  }

  private async login(context: RunContext, target: IdentityTarget): Promise<string> {
    context.emit({ target, level: 'pending', title: '正在登录授权服务', detail: context.request.username });
    const response = await this.postForm<{ access_token?: string }>(
      this.tokenUrl,
      { username: context.request.username, password: context.request.password },
      context.signal
    );
    if (!response.access_token) {
      throw new Error('登录成功响应中没有 access_token');
    }
    context.emit({ target, level: 'success', title: '授权服务登录成功' });
    return response.access_token;
  }

  private async requestSn(
    context: RunContext,
    target: IdentityTarget,
    token: string,
    info: DeviceIdentityInfo
  ): Promise<string> {
    context.emit({ target, level: 'pending', title: '正在申请授权数据', detail: `${info.factory} · ${info.product}` });
    const response = await this.postJson<{ data?: { sn?: unknown } }>(
      this.snUrl,
      info,
      { Authorization: `Bearer ${token}` },
      context.signal
    );
    const key = normalizeAuthorizationKey(response.data?.sn);
    context.emit({ target, level: 'success', title: '授权数据申请成功', detail: `${key.length} 个字符` });
    return key;
  }

  private async send(
    context: RunContext,
    target: IdentityTarget,
    title: string,
    command: string,
    expected: string[] = []
  ): Promise<string> {
    const safeCommand = sanitizeCommand(command);
    context.emit({ target, level: 'pending', title, detail: `$ ${safeCommand}` });
    const response = await context.serial.command(command, expected);
    const safeResponse = sanitizeOutput(response);
    context.emit({ target, level: 'output', title: `${title}：设备返回`, raw: safeResponse || '（无输出）' });
    if (expected.length > 0 && !expected.some((marker) => response.includes(marker))) {
      throw new Error(`${title}未返回预期标记：${expected.join(' / ')}`);
    }
    return response;
  }

  private async rebootAndReconnectIfEnabled(context: RunContext, target: IdentityTarget): Promise<void> {
    if (!context.request.rebootAfterWrite) return;
    context.emit({ target, level: 'pending', title: '正在等待授权数据落盘', detail: '重启前等待 1.0 秒' });
    await delay(1000, context.signal);
    context.emit({ target, level: 'pending', title: '正在重启设备并等待串口恢复', detail: `$ ${context.request.commands.reboot}` });
    await context.serial.reboot(context.request.commands.reboot);
    context.emit({ target, level: 'success', title: '设备重启完成，串口已重新连接' });
  }

  /** 设备重启后的算法或 SN 验证可能异步完成，需要在有界时间内复核。 */
  private async waitForAuthorized(
    context: RunContext,
    target: IdentityTarget,
    check: () => Promise<IdentityResult>
  ): Promise<IdentityResult> {
    const deadline = Date.now() + AUTHORIZATION_VERIFY_TIMEOUT_MS;
    let result = await check();
    while (result.status !== 'authorized' && Date.now() < deadline) {
      context.emit({
        target,
        level: 'pending',
        title: '授权数据已写入，等待设备完成异步校验',
        detail: `${AUTHORIZATION_VERIFY_INTERVAL_MS / 1000} 秒后重试`
      });
      await delay(AUTHORIZATION_VERIFY_INTERVAL_MS, context.signal);
      result = await check();
    }
    return result;
  }

  private emitResult(context: RunContext, result: IdentityResult): void {
    context.emit({
      target: result.target,
      level: result.status === 'authorized' ? 'success' : result.status === 'unauthorized' ? 'warning' : 'warning',
      title: result.summary,
      detail: result.fields ? Object.entries(result.fields).map(([key, value]) => `${key}=${value}`).join(' · ') : undefined
    });
  }

  private async postJson<T>(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    parentSignal: AbortSignal
  ): Promise<T> {
    return this.postBody<T>(url, JSON.stringify(body), { 'Content-Type': 'application/json', ...headers }, parentSignal);
  }

  /** OAuth2 登录接口要求表单字段，不接受 JSON 请求体。 */
  private async postForm<T>(
    url: string,
    fields: Record<string, string>,
    parentSignal: AbortSignal
  ): Promise<T> {
    return this.postBody<T>(
      url,
      encodeAuthorizationLoginBody(fields.username ?? '', fields.password ?? ''),
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      parentSignal
    );
  }

  private async postBody<T>(
    url: string,
    body: string,
    headers: Record<string, string>,
    parentSignal: AbortSignal
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const abort = (): void => controller.abort(parentSignal.reason);
      parentSignal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error('授权服务请求超时')), this.httpTimeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal
        });
        const text = await response.text();
        let parsed: T;
        try {
          parsed = text ? JSON.parse(text) as T : {} as T;
        } catch {
          if (!response.ok) {
            throw new Error(formatHttpError(response.status, undefined, text));
          }
          throw new Error('授权服务返回了无法解析的响应，请检查服务地址和网络代理');
        }
        if (!response.ok) {
          throw new Error(formatHttpError(response.status, parsed, text));
        }
        return parsed;
      } catch (error) {
        if (parentSignal.aborted) throw parentSignal.reason;
        lastError = error;
        if (attempt < 3 && isRetryableError(error)) {
          await delay(attempt * 500, parentSignal);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        parentSignal.removeEventListener('abort', abort);
      }
    }
    throw lastError;
  }
}

export function encodeAuthorizationLoginBody(username: string, password: string): string {
  return new URLSearchParams({ username, password }).toString();
}

/** 服务端授权字段是设备命令参数，不限定为纯十六进制，但不得包含命令分隔字符。 */
export function normalizeAuthorizationKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('授权服务响应中没有 SN/密钥');
  }
  const key = value.trim();
  if (/\s|[\x00-\x1f\x7f]/.test(key)) {
    throw new Error('授权服务返回的 SN/密钥包含空白或控制字符');
  }
  return key;
}

class IdentitySerialSession {
  private readonly serial: SerialPort;
  private opened = false;

  public constructor(
    portPath: string,
    baudRate: number,
    private readonly timeoutMs: number,
    private readonly signal: AbortSignal
  ) {
    this.serial = new SerialPort({ path: portPath, baudRate, autoOpen: false });
  }

  public async open(): Promise<void> {
    this.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      this.serial.open((error) => error ? reject(error) : resolve());
    });
    this.opened = true;
    await delay(120, this.signal);
  }

  public async command(command: string, expected: string[] = []): Promise<string> {
    this.throwIfAborted();
    const normalized = normalizeCommand(command);
    await this.flushInput();

    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      let quietTimer: NodeJS.Timeout | undefined;
      let sawData = false;

      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        if (quietTimer) clearTimeout(quietTimer);
        this.serial.off('data', onData);
        this.serial.off('error', onError);
        this.signal.removeEventListener('abort', onAbort);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(Buffer.concat(chunks).toString('utf8'));
      };
      const armQuietTimer = (): void => {
        if (expected.length > 0) return;
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(), 550);
      };
      const onData = (chunk: Buffer): void => {
        chunks.push(Buffer.from(chunk));
        sawData = true;
        const current = Buffer.concat(chunks).toString('utf8');
        if (expected.some((marker) => current.includes(marker))) {
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish(), 120);
        } else {
          armQuietTimer();
        }
      };
      const onError = (error: Error): void => finish(error);
      const onAbort = (): void => finish(new Error('用户已取消身份认证操作'));
      const timeoutTimer = setTimeout(() => {
        if (sawData) finish();
        else finish(new Error(`串口命令等待超时：${sanitizeCommand(normalized)}`));
      }, this.timeoutMs);

      this.serial.on('data', onData);
      this.serial.once('error', onError);
      this.signal.addEventListener('abort', onAbort, { once: true });
      this.serial.write(`${normalized}\r\n`, 'utf8', (writeError) => {
        if (writeError) {
          finish(writeError);
          return;
        }
        this.serial.drain((drainError) => {
          if (drainError) finish(drainError);
        });
      });
    });
  }

  public async close(): Promise<void> {
    if (!this.opened || !this.serial.isOpen) return;
    await new Promise<void>((resolve) => {
      this.serial.close(() => resolve());
    });
    this.opened = false;
  }

  public async reboot(command: string): Promise<void> {
    const normalized = normalizeCommand(command);
    await this.flushInput();
    await new Promise<void>((resolve, reject) => {
      this.serial.write(`${normalized}\r\n`, 'utf8', (writeError) => {
        if (writeError) {
          reject(writeError);
          return;
        }
        this.serial.drain((drainError) => drainError ? reject(drainError) : resolve());
      });
    });
    await delay(350, this.signal);
    await this.close();
    await delay(1400, this.signal);

    const deadline = Date.now() + 30000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.open();
        return;
      } catch (error) {
        lastError = error;
        await delay(500, this.signal);
      }
    }
    throw new Error(`设备重启后串口未恢复：${toErrorMessage(lastError)}`);
  }

  private async flushInput(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.serial.flush(() => resolve());
    });
    await delay(30, this.signal);
  }

  private throwIfAborted(): void {
    if (this.signal.aborted) {
      throw new Error('用户已取消身份认证操作');
    }
  }
}

export function parseAlgorithmStatus(output: string): IdentityStatus {
  const clean = cleanOutput(output);
  const match = clean.match(/\bauth_flag\s+(ok|fail)(?=\s|[a-z0-9_.-]+:~[$#]|$)/i);
  if (match?.[1]?.toLowerCase() === 'ok') return 'authorized';
  if (match?.[1]?.toLowerCase() === 'fail') return 'unauthorized';
  return 'unknown';
}

export function parseSnStatus(output: string): SnStatus {
  const clean = cleanOutput(output);
  const status = clean.match(/\bsn_status\s+([^\s(]+)(?:\s+\([^)]+\))?/i)?.[1] ?? 'unknown';
  const error = clean.match(/\bsn_error\s+([^\s(]+)(?:\s+\([^)]+\))?/i)?.[1] ?? 'unknown';
  return { status, error };
}

export function parseAlgorithmIdentityInfo(output: string): DeviceIdentityInfo {
  const clean = cleanOutput(output);
  return validateIdentityInfo({
    flashId: readLengthPrefixedField(clean, 'flashId'),
    chipId: readLengthPrefixedField(clean, 'chipId'),
    checkDigit: readLengthPrefixedField(clean, 'checkDigit'),
    modelVersion: readLengthPrefixedField(clean, 'modelVersion'),
    factory: readLengthPrefixedField(clean, 'factory'),
    product: readLengthPrefixedField(clean, 'product')
  });
}

/** 按完整行读取字段值，不能使用 `[^\\s]+`，否则 `PRO Audio` 会变成 `PRO`。 */
export function parseDeviceIdentityInfo(output: string): DeviceIdentityInfo {
  const clean = cleanOutput(output);
  return validateIdentityInfo({
    chipId: readEqualsField(clean, /^(?:c)?hipId=/i).replace(/^0x/i, ''),
    flashId: readEqualsField(clean, /^flashId=/i),
    factory: readEqualsField(clean, /^factory=/i),
    modelVersion: readEqualsField(clean, /^modelVersion=/i),
    product: readEqualsField(clean, /^product=/i),
    checkDigit: readEqualsField(clean, /^checkDigit=/i)
  });
}

export function renderCommand(template: string, values: { key: string; zeroKey: string }): string {
  const rendered = template.replaceAll('{key}', values.key).replaceAll('{zeroKey}', values.zeroKey);
  if (/\{[^}]+\}/.test(rendered)) {
    throw new Error(`命令模板包含未知占位符：${rendered.match(/\{[^}]+\}/)?.[0]}`);
  }
  return normalizeCommand(rendered);
}

/**
 * 清除命令必须限制在对应身份协议内，避免可编辑命令误清除另一套身份。
 * 允许在协议命令内调整参数，但禁止复合 Shell 命令和使用普通授权密钥占位符。
 */
export function validateIsolatedClearCommand(target: 'algorithm' | 'sn', command: string): string {
  const normalized = normalizeCommand(command);
  if (/(?:&&|\|\||[;|&<>`]|\$\()/.test(normalized)) {
    throw new Error('清除授权只允许执行一条隔离的设备命令，不能包含 Shell 连接符、重定向或命令替换');
  }
  if (!normalized.includes('{zeroKey}') || normalized.includes('{key}')) {
    throw new Error('清除授权命令必须且只能使用 {zeroKey} 清除载荷');
  }

  const expected = target === 'algorithm' ? /^auth_mode(?:\s|$)/i : /^device_id\s+sn(?:\s|$)/i;
  const peer = target === 'algorithm' ? /\bdevice_id\b/i : /\bauth_mode\b/i;
  if (!expected.test(normalized) || peer.test(normalized)) {
    throw new Error(
      target === 'algorithm'
        ? '算法清除命令必须独立使用 auth_mode 协议，不能调用 SN 身份命令'
        : 'SN 清除命令必须独立使用 device_id sn 协议，不能调用算法身份命令'
    );
  }
  return normalized;
}

function readLengthPrefixedField(output: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return output.match(new RegExp(`^${escaped}\\s+\\d+\\s+([^\\r\\n]*)$`, 'im'))?.[1]?.trim() ?? '';
}

function readEqualsField(output: string, prefix: RegExp): string {
  const line = output.split(/\r?\n/).find((candidate) => prefix.test(candidate.trim()));
  if (!line) return '';
  return line.slice(line.indexOf('=') + 1).trim();
}

function validateIdentityInfo(info: DeviceIdentityInfo): DeviceIdentityInfo {
  const missing = Object.entries(info).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`设备身份信息不完整：缺少 ${missing.join('、')}`);
  }
  return info;
}

function snAuthorizationStatus(status: SnStatus): IdentityStatus {
  if (status.status.toLowerCase() === 'valid' && status.error.toLowerCase() === 'none') return 'authorized';
  if (['invalid', 'absent', 'not-provisioned', 'present'].includes(status.status.toLowerCase()) ||
      ['not-provisioned', 'signature-invalid'].includes(status.error.toLowerCase())) return 'unauthorized';
  return 'unknown';
}

function cleanOutput(output: string): string {
  return output.replace(ANSI_PATTERN, '').replaceAll('\0', '').replace(/\r/g, '');
}

function sanitizeOutput(output: string): string {
  const clean = cleanOutput(output).replace(LONG_HEX_PATTERN, '<已隐藏授权数据>').trim();
  if (clean.length <= 8000) return clean;
  return `${clean.slice(0, 4000)}\n\n… 已省略 ${clean.length - 8000} 个字符 …\n\n${clean.slice(-4000)}`;
}

function sanitizeCommand(command: string): string {
  return command.replace(LONG_HEX_PATTERN, '<已隐藏授权数据>').trim();
}

function normalizeCommand(command: string): string {
  const normalized = command.trim();
  if (!normalized) throw new Error('命令不能为空');
  if (/[\r\n]/.test(normalized)) throw new Error('单次操作只允许一条 Shell 命令');
  return normalized;
}

function validateRequest(request: IdentityRequest): void {
  if (!request.port.trim()) throw new Error('请选择或输入串口');
  if (!Number.isInteger(request.baudRate) || request.baudRate < 1200) throw new Error('串口波特率无效');
  if (request.action.startsWith('authorize') && (!request.username.trim() || !request.password)) {
    throw new Error('授权操作需要账号和密码');
  }
  for (const [name, command] of Object.entries(request.commands) as [keyof IdentityCommands, string][]) {
    if (!command.trim()) throw new Error(`命令配置不能为空：${name}`);
    normalizeCommand(command);
  }
}

function targetForAction(action: IdentityAction): IdentityTarget {
  if (action.toLowerCase().includes('algorithm')) return 'algorithm';
  if (action.toLowerCase().includes('sn')) return 'sn';
  return 'system';
}

function formatHttpError(status: number, parsed: unknown, raw: string): string {
  const data = parsed as { error?: string; message?: string } | undefined;
  const detail = data?.error || data?.message || raw.trim().slice(0, 240) || '无响应内容';
  if (status === 401) return '授权服务拒绝登录或令牌已失效（HTTP 401）';
  if (status === 403) return `账号没有该产品的授权权限（HTTP 403）：${detail}`;
  if (status === 404) return `授权服务接口不存在（HTTP 404）：${detail}`;
  return `授权服务请求失败（HTTP ${status}）：${detail}`;
}

function isRetryableError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('timeout') || message.includes('超时') || message.includes('fetch failed') || message.includes('network');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('用户已取消身份认证操作');
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('用户已取消身份认证操作'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
