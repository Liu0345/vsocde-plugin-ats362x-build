export type ToolName = 'baton' | 'actions-flash' | 'dfu-util' | 'node-hid';

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
  serialPorts: SerialPortInfo[];
  tools: ToolStatus[];
  busy?: string;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
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

export interface UsbDfuDeviceInfo {
  key: string;
  vendorId: number;
  productId: number;
  usbPath: string;
  serialNumber?: string;
  product?: string;
  manufacturer?: string;
  dfuName?: string;
  version?: string;
  alt: number;
}

export type ExtensionToWebview =
  | { type: 'state'; state: ProjectState }
  | { type: 'hidDevices'; devices: HidDeviceInfo[] }
  | { type: 'usbDfuDevices'; devices: UsbDfuDeviceInfo[] }
  | { type: 'progress'; action: string; percent: number; detail: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string };

export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'openPanel' }
  | { type: 'selectProject' }
  | { type: 'selectRecentProject'; path: string }
  | { type: 'clearProjects' }
  | { type: 'selectFirmware' }
  | { type: 'selectHidFirmware' }
  | { type: 'selectUsbDfuFirmware' }
  | { type: 'selectFirmwareDirectory' }
  | { type: 'clearFirmwareOverride' }
  | { type: 'refresh' }
  | { type: 'listSerial' }
  | { type: 'run'; request: RunRequest }
  | { type: 'listHid' }
  | { type: 'listUsbDfu' }
  | { type: 'usbDfu'; device: UsbDfuDeviceInfo; firmware: string; reset: boolean }
  | { type: 'usbDfuAbort' }
  | { type: 'hidDfu'; path: string; firmware: string; expectedBcd: number }
  | { type: 'hidAbort'; path: string };
