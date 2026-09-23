# 浏览器扩展兼容性

ZoomPaper Connector 采用三层识别方式：标准学术元数据、稳定站点规则、页面 PDF 下载入口。网页改版后，前两层中的另一层通常仍能继续工作。

## 计算机领域覆盖

| 类别 | 网站 | 当前方式 |
| --- | --- | --- |
| 预印本与开放评审 | arXiv、OpenReview | 内置稳定规则 + 页面元数据 |
| NLP | ACL Anthology | 内置稳定规则 + `citation_pdf_url` |
| 计算机视觉 | CVF Open Access（CVPR / ICCV / WACV） | 内置稳定规则 |
| 机器学习 | NeurIPS Proceedings、PMLR、JMLR | 内置规则或页面 PDF 入口 |
| 系统与安全 | USENIX、NDSS 等公开论文页 | 页面学术元数据与 PDF 入口 |
| 出版商 | ACM Digital Library、IEEE Xplore、SpringerLink、ScienceDirect、Wiley、Taylor & Francis、SAGE | 标准元数据与 PDF 下载入口 |
| 会议与开放仓库 | AAAI、IJCAI、CEUR-WS、Dagstuhl / LIPIcs、HAL、Zenodo | 标准元数据与 PDF 入口 |
| 检索入口 | DBLP、Semantic Scholar、Google Scholar、Papers with Code | 在结果中的 PDF 链接上右键；进入论文详情页后也可识别 |
| 任意直接 PDF | HTTPS PDF 页面或链接 | 文件地址识别 |

## 无法保证自动下载的情况

- 需要学校代理、机构订阅、验证码或单点登录的 PDF。当前由 ZoomPaper 桌面端下载，不会复制浏览器的登录 Cookie。
- 只有摘要、没有公开 PDF 的论文页。
- 页面用临时签名或脚本生成下载地址，且点击前没有把地址写入网页。
- 搜索结果页包含多篇论文时，扩展不会猜测用户要哪一篇；应在目标 PDF 链接上右键，或先进入论文详情页。

这类页面仍可先在浏览器下载 PDF，再通过 ZoomPaper 的本地导入功能加入。后续若增加登录态下载，将采用类似 Zotero Connector 的本机通信通道，并明确说明所需的网站读取权限。

## 维护原则

- 优先使用网站公开的 `citation_pdf_url`、JSON-LD 或 `application/pdf` 标记。
- 只为稳定、公开的 URL 结构添加站点规则。
- 每个站点规则配回归测试，避免修复一个网站时破坏其他网站。
- 页面没有正文 PDF 时明确失败，不把 supplement、checklist、slides 或 poster 当作论文正文。
