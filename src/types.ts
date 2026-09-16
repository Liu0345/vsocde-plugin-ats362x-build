export type ToolName = 'baton' | 'actions-flash' | 'dfu-util' | 'node-hid' | '@julusian/midi';

export interface ToolStatus {
  name: ToolName;
  label: string;
  available: boolean;
  detail: string;
  minimumVersion: string;
  detectedVersion?: string;
}

export interface ProjectState {
  projectPath?: string;
  recentProjects: string[];
  firmwareOverride?: string;
  defaultFirmwareDirectory?: string;
  discoveredFirmware: Array<{ path: string; modified: number }>;
  serialPorts: SerialPortInfo[];
  tools: ToolStatus[];
  buildOptions: BuildOptionInfo[];
  busy?: string;
  flashQueued?: boolean;
  relayDevices: RelayDeviceInfo[];
  relaySelectedPath?: string;
  relayMask?: number;
  relayBusy?: boolean;
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
  interface?: number;
  usagePage?: number;
  usage?: number;
  version?: string;
  dfuName?: string;
}

export interface RelayDeviceInfo {
  path: string;
  vendorId: number;
  productId: number;
  product?: string;
  manufacturer?: string;
  serialNumber?: string;
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

export interface MidiDfuDeviceInfo {
  key: string;
  portName: string;
  deviceId: string;
  bootId?: string;
  model: string;
  vendorId: number;
  productId: number;
  bcdDevice: number;
  maxChunk: number;
  maxImageSize: number;
}

export type PanelPage = 'project' | 'build' | 'dfu' | 'identity' | 'uart' | 'hidCommunication' | 'tools' | 'chip';

export type CommunicationTransport = 'uart' | 'hid';
export type CommunicationDirection = 'rx' | 'tx';
export type CommunicationDataMode = 'text' | 'hex';
export type CommunicationLineEnding = 'none' | 'cr' | 'lf' | 'crlf';

export interface CommunicationEvent {
  id: number;
  transport: CommunicationTransport;
  direction: CommunicationDirection;
  bytes: number[];
  timestamp: string;
}

export interface CommunicationStatus {
  transport: CommunicationTransport;
  connected: boolean;
  target?: string;
  detail: string;
}

export interface CommunicationQuickCommand {
  id: string;
  transport: CommunicationTransport;
  name: string;
  mode: CommunicationDataMode;
  payload: string;
  lineEnding: CommunicationLineEnding;
}

export type ExtensionToWebview =
  | { type: 'state'; state: ProjectState }
  | { type: 'navigate'; page: PanelPage }
  | { type: 'hidDevices'; devices: HidDeviceInfo[] }
  | { type: 'genericHidDevices'; devices: HidDeviceInfo[] }
  | { type: 'usbDfuDevices'; devices: UsbDfuDeviceInfo[] }
  | { type: 'midiDfuDevices'; devices: MidiDfuDeviceInfo[] }
  | { type: 'usbDfuFirmwareSelected'; path: string }
  | { type: 'serialReservations'; paths: string[] }
  | { type: 'serialReservationResult'; requestedPort: string; resolvedPort: string; reserved: boolean }
  | { type: 'progress'; action: 'usbDfu' | 'hidDfu' | 'midiDfu' | 'flash' | 'erase' | ''; percent: number; detail: string; active?: boolean; completed?: boolean }
  | { type: 'identityBusy'; busy: boolean; action?: IdentityAction }
  | { type: 'identityEvent'; event: IdentityEvent }
  | { type: 'identityResult'; result: IdentityResult }
  | { type: 'communicationSnapshot'; statuses: CommunicationStatus[]; events: CommunicationEvent[]; quickCommands: CommunicationQuickCommand[] }
  | { type: 'communicationEvent'; event: CommunicationEvent }
  | { type: 'communicationStatus'; status: CommunicationStatus }
  | { type: 'communicationCleared'; transport: CommunicationTransport }
  | { type: 'communicationQuickCommands'; commands: CommunicationQuickCommand[] }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string };

export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'clientValidationError'; message: string }
  | { type: 'openPanel'; page: PanelPage }
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
  | { type: 'listGenericHid' }
  | { type: 'listUsbDfu' }
  | { type: 'listMidiDfu' }
  | { type: 'usbDfu'; device: UsbDfuDeviceInfo; firmware: string; reset: boolean }
  | { type: 'usbDfuAbort' }
  | { type: 'hidDfu'; path: string; firmware: string; expectedBcd: number }
  | { type: 'hidAbort'; path: string }
  | { type: 'midiDfu'; device: MidiDfuDeviceInfo; firmware: string }
  | { type: 'midiDfuAbort' }
  | { type: 'flashAbort' }
  | { type: 'listRelays' }
  | { type: 'selectRelay'; path: string }
  | { type: 'relayRead'; path: string }
  | { type: 'relayChannel'; path: string; channel: number; enabled: boolean }
  | { type: 'eraseAbort' }
  | { type: 'identityAction'; request: IdentityRequest }
  | { type: 'identityCancel' }
  | { type: 'communicationConnect'; transport: 'uart'; path: string; baudRate: number; dataBits: 5 | 6 | 7 | 8; stopBits: 1 | 2; parity: 'none' | 'even' | 'odd' | 'mark' | 'space'; flowControl: 'none' | 'rtscts' | 'xonxoff'; packetTimeoutMs: number }
  | { type: 'communicationConnect'; transport: 'hid'; path: string; packetTimeoutMs: number }
  | { type: 'communicationDisconnect'; transport: CommunicationTransport }
  | { type: 'communicationSend'; transport: CommunicationTransport; mode: CommunicationDataMode; payload: string; lineEnding: CommunicationLineEnding; reportId?: number; reportLength?: number; fixedHid64?: boolean }
  | { type: 'communicationSetPacketTimeout'; transport: CommunicationTransport; packetTimeoutMs: number }
  | { type: 'communicationSetSignals'; dtr: boolean; rts: boolean }
  | { type: 'communicationClear'; transport: CommunicationTransport }
  | { type: 'communicationExport'; transport: CommunicationTransport; format: 'txt' | 'json' }
  | { type: 'communicationQuickCommandsSave'; commands: CommunicationQuickCommand[] }
  | { type: 'communicationQuickCommandsImport' }
  | { type: 'communicationQuickCommandsExport' };
