# ATS362X 构建与烧录 VS Code 插件

面向 ARIA workspace / workspace track 的 ATS362X 固件操作面板。插件在 VS Code 集成终端中调用用户本机安装的 `baton`、`actions-flash` 和 `dfu-util`；HID 运行时 DFU 传输层由插件直接实现。

## 功能

- 选择、记忆最多 10 个项目目录，并可一键清除历史。
- 自动发现项目最新的 `_firmware` 输出目录；可临时覆盖为其他固件文件或目录，并可恢复默认。
- 编译下载项默认使用 `ota-fw`；烧录与 HID DFU 均可从已发现固件下拉选择或自行选择外部文件，自选后仍可切换到列表中的其他固件。
- Baton 编译、编译/烧录/校验、环境诊断、设备发现和状态查看。
- 自动扫描串口，并支持 460800、921600、1000000、2000000、3000000 五档烧录波特率。
- 串口烧录页面仅提供 UART OTA、UART ADFU 和烧录后校验。
- 独立 USB DFU 页面：扫描同时拥有 UAC 与标准 DFU Runtime 接口的设备，选择后按 VID:PID 和 USB 物理路径锁定目标；固件支持项目下拉和自选 `.bin/.dfu`。
- Actions Flash 的 ADFU 设备枚举与 `.fw` 解包。
- 带二次确认的全 Flash 擦除，以及安全的 dry-run 预演。
- DSPTuner v2 HID DFU：只显示同时拥有 Audio Class 接口的 UAC 厂商 HID，支持固件 CRC32、帧 CRC16、ACK 超时重试、进度与取消。
- 完整控制台可在 VS Code 编辑区以独立标签页打开，侧边栏保留快速入口。

## 使用前准备

普通功能需要命令行中可执行：

```bash
baton --version
actions-flash --version
dfu-util --version
```

也可以在 VS Code 设置中配置 `ats362xBuild.batonPath`、`ats362xBuild.actionsFlashPath` 和 `ats362xBuild.dfuUtilPath` 为绝对路径。

HID DFU 需要设备固件启用兼容的 HID 更新模块，并枚举 DSPTuner 普通 HID 接口。VSIX 包含 `node-hid` 的 macOS、Linux 与 Windows 常用架构预编译模块。

ATS362X 全擦除使用较新 Baton 提供的 `baton erase-flash`。如果工具状态或终端提示当前版本不支持该命令，请先更新 Baton；插件不会用普通烧录伪装成全擦除。

## 开发与打包

```bash
npm install
npm run typecheck
npm test
npm run package:vsix
```

生成的 `.vsix` 可通过 VS Code 的“从 VSIX 安装…”进行测试。

## 安全边界

- 所有外部命令都在名为 `ATS362X` 的集成终端运行，用户可查看完整命令和实时输出。
- 全擦除在非 dry-run 模式下必须通过 VS Code 模态确认。
- 固件参数以独立 argv 建模并进行 shell 引号保护。
- HID DFU 采用流式 CRC32 和流式传输，内存占用不随 `.bin` 镜像大小增长；设备容量限制由设备端协议响应决定。
