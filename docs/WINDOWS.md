# Windows 构建与验证

本次针对 v0.6.0 源码进行 Windows x64 验证。原项目的 Release 工作流仍只发布 macOS 包；新增 Windows 检查工作流只执行测试和编译，不发布安装包。

## 环境

- Node.js：建议 24 LTS；本次 24.15.0。Vite 7 要求至少 20.19 或 22.12。
- Rust stable MSVC 工具链；本次 1.99.1。
- Visual Studio 2022 的“使用 C++ 的桌面开发”工作负载和 Windows SDK。
- Microsoft Edge WebView2 Runtime。
- Python 3：仅浏览器扩展打包脚本需要，Windows 使用 `python`。

环境要求参见 [Tauri 官方说明](https://v2.tauri.app/start/prerequisites/#windows)。

## 标准命令

在仓库根目录的 PowerShell 中执行：

```powershell
npm ci
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- dev
```

构建可执行文件但不生成安装器：

```powershell
npm run tauri -- build --debug --no-bundle
```

生产安装包需另行执行 `npm run tauri -- build`，并验证安装、卸载、升级、协议注册与签名。本次未验证 MSI/NSIS 安装器。

## ONNX 下载缓慢时

`fastembed` 的 `ort-sys` 会下载 ONNX Runtime。下载等待不代表应用源码编译错误。可使用该依赖支持的 `ORT_LIB_LOCATION` 和 `ORT_PREFER_DYNAMIC_LINK=1` 指定匹配的官方 Windows 运行库。必须将匹配的 DLL 放到可执行文件旁边；仅修改 PATH 可能仍加载到 Windows 自带的旧版本。

本次 Windows 验证在默认下载受阻时，从微软发布的 `onnxruntime==1.28.0` Python wheel 提取 DLL，用 Visual Studio 工具生成导入库后指定上述环境变量完成动态链接。这是手动替代途径，不会由仓库脚本自动配置，也不代表已完成正式安装包的运行库分发。

## 测试数据隔离

Debug 构建支持编译时环境变量 `ZOOMPAPER_TEST_DATA_DIR`。本地验收前可将它设为专用测试目录的绝对路径，再执行构建，避免使用个人论文库。它会编译进程序；改变测试目录或移动工作目录后需要重新构建。普通构建无需设置此变量，Release 构建不使用该测试目录覆盖。

真实 AI 验收需要在设置中配置 MinerU 和至少一个 LLM Provider。不要把密钥写进测试报告或提交仓库。
