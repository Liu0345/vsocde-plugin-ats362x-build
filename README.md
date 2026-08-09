# ATS362X 构建与烧录 VS Code 插件

面向 ARIA workspace / workspace track 的 ATS362X 固件操作面板。插件在 VS Code 集成终端中调用用户本机安装的 `baton`、`actions-flash` 和 `dfu-util`；HID 运行时 DFU 传输层由插件直接实现。

## 功能

- 选择、记忆最多 10 个项目目录；最近项目悬停显示完整路径，可逐项关闭记忆或一键清除全部记忆。
- 自动发现项目最新的 `_firmware` 输出目录；可临时覆盖为其他固件文件或目录，并可恢复默认。
- 编译下载项默认使用 `ota-fw`；烧录与 HID DFU 均可扫描已发现固件或通过“选择固件”使用外部文件，选择后仍可切换到列表中的其他固件。
- 选择项目后自动扫描 App 与其 Board；两个选项使用统一原生下拉，通过“自行输入…”支持自定义值，并可独立重新扫描。
- Baton 编译、编译/烧录/校验、环境诊断、设备发现和状态查看。
- 自动扫描串口，并支持 460800、921600、1000000、2000000、3000000 五档烧录波特率。
- 每个串口选择都会检查端口是否被占用；默认仅在任务执行期间占用，任务结束、失败或取消后释放。
- 每个串口选择下方提供默认关闭的“持续占用串口”勾选框，可按端口独立保留占用。
- 串口烧录页面仅提供 UART OTA、UART ADFU 和烧录后校验。
- `USB/HID DFU` 合并页面按上下顺序展示 USB DFU 与 HID DFU，两套传输流程仍然独立。
- USB DFU 扫描同时拥有 UAC 与标准 DFU Runtime 接口的设备，选择后按 VID:PID 和 USB 物理路径锁定目标；固件支持项目扫描列表和“选择固件”指定 `.bin/.dfu`。
- USB DFU 不依赖已选择的项目；单独选择的固件仅属于 USB DFU 页面，不会修改编译、串口烧录或 HID DFU 的固件来源。
- Actions Flash 的 ADFU 设备枚举与 `.fw` 解包。
- 带二次确认的全 Flash 擦除，以及安全的 dry-run 预演。
- DSPTuner v2 HID DFU：只显示同时拥有 Audio Class 接口的 UAC 厂商 HID，支持固件 CRC32、帧 CRC16、ACK 超时重试、进度与取消。
- 双身份认证：算法身份与 SN 身份分别支持状态检查、授权、清除和最终复核，互不依赖。
- 身份认证串口支持自动扫描、完整路径和 `891` 这类串口尾号；账号、密码、波特率和全部设备命令均可在界面调整。
- 身份认证流程用中文逐步展示串口连接、设备信息读取、服务请求、写入、重启与复核结果，并保留经过脱敏的设备原始输出。
- 提供自定义单条 Shell 命令入口，可读取设备信息、版本、授权状态及其他诊断信息。
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

身份认证默认使用 `qiushui` / `qiushui106`，密码仅保存在当前界面内存中，不写入 Webview 持久化状态。授权命令提供可编辑默认值；`{key}` 表示授权服务返回的数据，`{zeroKey}` 表示清除授权使用的全零载荷。SN 身份解析按完整行读取 `factory`、`modelVersion` 和 `product`，因此 `product=PRO Audio` 不会再被旧工具 2.1.1 的正则表达式截断为 `PRO`。

身份认证服务地址和超时可通过以下 VS Code 设置调整：

- `ats362xBuild.identityTokenUrl`
- `ats362xBuild.identitySnUrl`
- `ats362xBuild.identityCommandTimeoutMs`
- `ats362xBuild.identityHttpTimeoutMs`

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
- 身份认证密码、访问令牌和长授权数据不会写入流程日志；清除任一身份前必须通过 VS Code 模态确认。
- 授权或清除不能只依据写命令成功判定；默认重启设备、等待串口恢复并重新查询最终状态。
- 串口可用性检查采用短暂独占打开并立即关闭；持续占用按串口路径分别管理，插件停用时统一释放。
- 外部烧录或 Shell 工具不能使用已被插件持续占用的串口，执行前会给出明确提示，避免工具互相锁死。
