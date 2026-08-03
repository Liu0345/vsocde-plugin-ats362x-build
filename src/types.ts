export type ToolName = 'baton' | 'actions-flash' | 'node-hid';

export interface ToolStatus {
  name: ToolName;
  label: string;
  available: boolean;
  detail: string;
}

export interface ProjectState {
  projectPath?: string;
  recentProjects: string[];
  firmwareOverride?: string;
  defaultFirmwareDirectory?: string;
  discoveredFirmware: string[];
  tools: ToolStatus[];
  busy?: string;
}

export interface RunRequest {
  action: string;
  options: Record<string, string | number | boolean | undefined>;
}

export interface HidDeviceInfo {
  path: string;
  vendorId: number;
  productId: number;
  product?: string;
  manufacturer?: string;
  serialNumber?: string;
  usagePage?: number;
  usage?: number;
}

export type ExtensionToWebview =
  | { type: 'state'; state: ProjectState }
  | { type: 'hidDevices'; devices: HidDeviceInfo[] }
  | { type: 'progress'; action: string; percent: number; detail: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string };

export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'selectProject' }
  | { type: 'selectRecentProject'; path: string }
  | { type: 'clearProjects' }
  | { type: 'selectFirmware' }
  | { type: 'selectFirmwareDirectory' }
  | { type: 'clearFirmwareOverride' }
  | { type: 'refresh' }
  | { type: 'run'; request: RunRequest }
  | { type: 'listHid' }
  | { type: 'hidDfu'; path: string; firmware: string; expectedBcd: number }
  | { type: 'hidAbort'; path: string };
