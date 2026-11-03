# 联网搜索与网页抓取

ZoomPaper 的深度问答可以调用联网工具（`web_search` / `web_fetch`）。搜索后端在
**设置 → AI 模型与 API → 联网搜索** 中选择，API Key 复用「AI 服务」中已启用的
Provider。

## Provider 选择

| 选项 | 后端 | 使用条件 |
| --- | --- | --- |
| 关闭 | 不注册联网工具 | — |
| 自动（默认） | 优先 DeepSeek，其次 Anthropic | 任一 Provider 启用且 Key 非空 |
| DeepSeek 搜索 API | `POST /v1/tools/search`、`POST /v1/tools/fetch` | 存在启用的 `deepseek` Provider |
| Anthropic 原生搜索 | Messages API 的 `web_search_20250305` 服务端工具 | 存在启用的 `anthropic` Provider |

DeepSeek Provider 的 Base URL 默认是 `https://api.deepseek.com`；程序会自动去掉末尾的
`/v1`、`/anthropic/v1` 再拼接工具接口，因此旧版的 Anthropic 兼容 Base URL 也能直接使用。
`web_search_model` 只对 Anthropic 原生搜索生效，DeepSeek Search API 不需要模型名。

## 搜索

DeepSeek Search API 返回结构化结果：标题、URL、短摘要（`snippet`）、长摘要
（`summary`）、发布时间、站点名称与权威性。长摘要专为模型阅读设计，优先用于回答；
`web_fetch` 再按需抓取原文正文。搜索请求不开启 `need_content`，避免一次返回过多正文。

`query` 支持官方检索语法，模型会在需要时自动使用：

- `site:github.com` / `-site:example.com`：限定或排除站点
- `"精确短语"` / `-"排除短语"`
- `lang:zh,en`：限定语言
- `after:2025-01-01` / `before:2026`：限定发布时间
- `-关键词`：排除关键词

返回条数在设置中配置（1-50，默认 8）。结果按 URL 去重，并受上下文预算保护：内容过长时
保留前面的高相关结果并追加截断提示。

## 网页抓取

选择 DeepSeek 时，`web_fetch` 优先调用 `POST /v1/tools/fetch`（服务端抓取并转 Markdown）。
接口失败（例如 402 余额不足、404 无法提取正文）时自动回退到本地 HTTP 抓取 + HTML →
Markdown 提取，保证抓取能力不依赖单一服务。选择 Anthropic 时使用本地抓取。

## 错误提示

- `401`：API Key 无效或未配置，检查对应 Provider。
- `402`：DeepSeek 账户余额不足。
- `404`（Fetch）：链接不可用、被站点拦截或页面无可提取正文。
- `429`：超过 Search / Fetch QPS 限制，稍后重试。
- `5xx`：服务端暂时不可用。

设置页的「测试搜索」会用当前保存的配置发起一次真实请求，适合在排查 Key、余额与网络问题时
使用。

## 计费

DeepSeek Search 与 Fetch 按成功请求次数计费（官方价格：每 1,000 次成功请求 5 元）；失败、
无结果或超时请求不计费。关闭对话级「联网」开关、或在设置中把 Provider 设为「关闭」后，
不会发起搜索请求。

参考：[DeepSeek 网页搜索与抓取文档](https://api-docs.deepseek.com/zh-cn/guides/search/)
