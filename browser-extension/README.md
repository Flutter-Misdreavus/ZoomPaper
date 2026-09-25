# ZoomPaper Connector

在学术论文页面或 PDF 链接上右键，选择 **“加入 ZoomPaper”**；也可以直接点击浏览器工具栏中的扩展图标。扩展会唤起桌面应用，下载 PDF 并自动开始解析。

## 本地安装（Chrome / Edge）

1. 安装并至少启动一次包含浏览器导入功能的 ZoomPaper。
2. 打开 Chrome 的 `chrome://extensions`，或 Edge 的 `edge://extensions`。
3. 开启“开发者模式”，选择“加载已解压的扩展程序”。
4. 选择本仓库的 `browser-extension` 文件夹。
5. 首次使用时，浏览器会询问是否打开 ZoomPaper，请允许。

## 支持范围

- 支持 `citation_*`、Dublin Core、Highwire、JSON-LD 和 `application/pdf` 等通用学术元数据。
- 内置 ACL Anthology、arXiv、OpenReview、CVF Open Access、NeurIPS 的稳定 URL 识别。
- Researchr 等会议日程页只有 arXiv / OpenReview 预印本入口时，会自动解析到实际 PDF，同时保留会议页面作为论文来源。
- 支持直接打开的 PDF，以及在 PDF 下载链接上右键导入。
- ACM DL、IEEE Xplore、SpringerLink、ScienceDirect、USENIX、PMLR/JMLR 等网站会通过页面元数据和下载入口识别，并排除 checklist、supplement、slides 等附件。

完整覆盖说明见[计算机领域网站兼容性](../docs/BROWSER-SUPPORT.md)。

扩展不保存 API Key，也不会向额外服务器发送内容。它只把论文标题、来源页和 PDF 地址交给本机的 ZoomPaper。
