# 发布与 macOS 签名

## 发布流程

推送 `v*` 标签会构建并上传草稿 Release；手动触发 `Release` workflow 时可通过 `draft` 输入选择是否创建草稿。
当前工作流构建 Apple Silicon macOS 的 `.dmg` 安装包。

默认使用 ad-hoc 签名，未公证版本首次打开可能需要用户在系统设置中放行。
如需 Developer ID 签名与公证，在仓库 Secrets 中配置 Apple Developer 的证书与公证凭据：

| Secret | 说明 |
| ------ | ---- |
| `APPLE_CERTIFICATE` | `Developer ID Application` 证书导出的 `.p12`，转成 base64（`openssl base64 -A -in cert.p12`） |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_SIGNING_IDENTITY` | 如 `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple 账号邮箱 |
| `APPLE_PASSWORD` | Apple 账号的 App 专用密码 |
| `APPLE_TEAM_ID` | Apple Team ID |

也可改用 App Store Connect API Key（`APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH`）。
未配置这些 secrets 时，workflow 自动回退为 ad-hoc 签名；无论哪种模式，构建后都会执行
`codesign --verify` 校验，签名无效时 job 失败。当前校验步骤位于上传步骤之后，发布草稿前仍应确认所有检查通过。


发布脚本见 [Release workflow](../.github/workflows/release.yml)，返回 [README](../README.md)。
