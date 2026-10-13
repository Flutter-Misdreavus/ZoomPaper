# ZoomPaper Connector

在学术论文页面或 PDF 链接上右键，选择 **“加入 ZoomPaper”**；也可以直接点击浏览器工具栏中的扩展图标。扩展先通过浏览器下载 PDF，再唤起桌面应用导入并自动解析。下载失败时可选择其他全文链接、粘贴地址或打开原网页。

## 本地安装（Chrome / Edge）

1. 安装并至少启动一次 ZoomPaper 最新版本。
2. 打开 Chrome 的 `chrome://extensions`，或 Edge 的 `edge://extensions`。
3. 开启“开发者模式”，选择“加载已解压的扩展程序”。
4. 选择本仓库的 `browser-extension` 文件夹；本地打包交付时，选择 `ZoomPaper-Connector` 文件夹（其中直接包含 `manifest.json`）。
5. 首次使用时，浏览器会询问是否打开 ZoomPaper，请允许。

## 更新

扩展 ID 固定。更新目录后在扩展管理页点击“重新加载”，即可覆盖升级，无需删除旧扩展。

`v0.3.0` 新增会话存储与定时任务权限，用于下载恢复和超时处理；升级时请确认权限。解压时覆盖原来加载的目录，再在扩展管理页点击重新加载。

## 本地打包

运行 `npm run package:extension`，生成固定路径的 `ZoomPaper-Connector` 文件夹，可直接加载。后续打包会更新同一文件夹，在扩展管理页点击“重新加载”即可；不要删除或移动已加载的文件夹。需要上传 GitHub Release 时，运行 `npm run package:extension -- --zip`，额外生成 ZIP；用户下载后仍须先解压。

`v0.3.1` 同时传递页面 DOI，供 App 核对并补全出版信息；无需新增权限。

## 支持范围

- 支持 `citation_*`、Dublin Core、Highwire、JSON-LD 和 `application/pdf` 等通用学术元数据。
- 内置 ACL Anthology、arXiv、OpenReview、CVF Open Access、ICLR / NeurIPS Proceedings 的稳定 URL 识别。
- Researchr 等会议日程页只有 arXiv / OpenReview 预印本入口时，会自动解析到实际 PDF，同时保留会议页面作为论文来源。
- 支持直接打开的 PDF，以及在 PDF 下载链接上右键导入。
- ACM DL、IEEE Xplore、SpringerLink、ScienceDirect、USENIX、PMLR/JMLR 等网站会通过页面元数据和下载入口识别，并排除 checklist、supplement、slides 等附件。

完整覆盖说明见[计算机领域网站兼容性](../docs/BROWSER-SUPPORT.md)。

扩展不保存 API Key，不向额外服务器发送论文内容。所有站点均通过浏览器下载；成功导入后由 App 清理专用目录中的文件。诊断记录仅保留在当前浏览器会话中。


`v0.4.0` 新增本机保存回执：App 保存 PDF 后扩展确认“已加入论文库”，未确认时可重新发送。升级需要允许访问 `http://127.0.0.1:37541/*`；此接口仅查询导入状态，不读取论文或 API Key。请搭配支持后台任务队列的 ZoomPaper 使用。解析在 App 后台排队，可继续导入其他论文。
