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
  buildOptions: BuildOptionInfo[];
  busy?: string;
}

export interface BuildOptionInfo {
  app: string;
  boards: string[];
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export type IdentityTarget = 'algorithm' | 'sn' | 'system';
export type IdentityStatus = 'authorized' | 'unauthorized' | 'unknown' | 'running' | 'error';
export type IdentityAction =
  | 'checkAlgorithm'
  | 'authorizeAlgorithm'
  | 'clearAlgorithm'
  | 'checkSn'
  | 'authorizeSn'
  | 'clearSn'
  | 'runCustom';

export interface IdentityCommands {
  algorithmStatus: string;
  algorithmInfo: string;
  algorithmWrite: string;
  algorithmClear: string;
  snStatus: string;
  snInfo: string;
  snWrite: string;
  snClear: string;
  reboot: string;
}

export interface IdentityRequest {
  action: IdentityAction;
  port: string;
  baudRate: number;
  username: string;
  password: string;
  rebootAfterWrite: boolean;
  keepPortReserved: boolean;
  commands: IdentityCommands;
  customCommand?: string;
}

export interface IdentityEvent {
  id: number;
  target: IdentityTarget;
  level: 'pending' | 'success' | 'warning' | 'error' | 'output';
  title: string;
  detail?: string;
  raw?: string;
  timestamp: string;
}

export interface IdentityResult {
  target: IdentityTarget;
  status: IdentityStatus;
  summary: string;
  fields?: Record<string, string>;
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
  | { type: 'usbDfuFirmwareSelected'; path: string }
  | { type: 'serialReservations'; paths: string[] }
  | { type: 'serialReservationResult'; requestedPort: string; resolvedPort: string; reserved: boolean }
  | { type: 'progress'; action: string; percent: number; detail: string }
  | { type: 'identityBusy'; busy: boolean; action?: IdentityAction }
  | { type: 'identityEvent'; event: IdentityEvent }
  | { type: 'identityResult'; result: IdentityResult }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string };

export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'openPanel' }
  | { type: 'selectProject' }
  | { type: 'selectRecentProject'; path: string }
  | { type: 'clearProjects' }
  | { type: 'removeRecentProject'; path: string }
  | { type: 'selectFirmware' }
  | { type: 'selectHidFirmware' }
  | { type: 'selectUsbDfuFirmware' }
  | { type: 'selectFirmwareDirectory' }
  | { type: 'scanFirmware' }
  | { type: 'clearFirmwareOverride' }
  | { type: 'refresh' }
  | { type: 'scanBuildOptions' }
  | { type: 'listSerial' }
  | { type: 'checkSerialPort'; port: string }
  | { type: 'setSerialPortReservation'; port: string; reserved: boolean }
  | { type: 'run'; request: RunRequest }
  | { type: 'listHid' }
  | { type: 'listUsbDfu' }
  | { type: 'usbDfu'; device: UsbDfuDeviceInfo; firmware: string; reset: boolean }
  | { type: 'usbDfuAbort' }
  | { type: 'hidDfu'; path: string; firmware: string; expectedBcd: number }
  | { type: 'hidAbort'; path: string }
  | { type: 'identityAction'; request: IdentityRequest }
  | { type: 'identityCancel' };
