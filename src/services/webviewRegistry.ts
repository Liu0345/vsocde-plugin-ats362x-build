export interface WebviewMessageTarget {
  postMessage(message: unknown): Thenable<boolean>;
}

/**
 * Tracks live Webviews and contains postMessage failures at the lifecycle boundary.
 * VS Code may dispose a Webview between a liveness check and the asynchronous
 * postMessage delivery, so every delivery must handle both throws and rejections.
 */
export class WebviewRegistry<T extends WebviewMessageTarget> {
  private readonly targets = new Set<T>();

  public constructor(private readonly reportUnexpectedError: (error: unknown) => void = () => undefined) {}

  public register(target: T): void {
    this.targets.add(target);
  }

  public unregister(target: T): void {
    this.targets.delete(target);
  }

  public post(message: unknown): void {
    for (const target of [...this.targets]) {
      this.postTo(target, message);
    }
  }

  public get size(): number {
    return this.targets.size;
  }

  private postTo(target: T, message: unknown): void {
    try {
      void Promise.resolve(target.postMessage(message)).catch((error: unknown) => {
        this.handleDeliveryFailure(target, error);
      });
    } catch (error) {
      this.handleDeliveryFailure(target, error);
    }
  }

  private handleDeliveryFailure(target: T, error: unknown): void {
    this.unregister(target);
    if (!isWebviewDisposedError(error)) {
      this.reportUnexpectedError(error);
    }
  }
}

export function isWebviewDisposedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:webview|panel).*disposed|disposed.*(?:webview|panel)/i.test(message);
}
