//! 流式 HTML → markdown 文本提取（web_fetch 用，根治大页面抓取失败）。
//!
//! 用 html5ever 0.38 的 **Tokenizer**（token 级，而非完整 TreeSink）边接收字节边解析：
//! - 丢弃 `script/style/nav/header/footer` 等无用子树（栈式 ignore，不构建 DOM，内存有界）；
//! - 保留标题 / 段落 / 链接 / 列表 / 图片等正文结构，输出 markdown 形状；
//! - 达到**提取文本预算**即置 `stopped`，调用方据此断流（停止下载），
//!   彻底摆脱「原始 HTML 字节大小」限制——GitHub 仓库页等大页面只需下载到正文为止。
//!
//! `feed_bytes` 维护字节缓冲，只把**完整 UTF-8 前缀**（`str::from_utf8` 的 `valid_up_to`）
//! 喂给 tokenizer，跨网络 chunk 被拆开的中文字符不会被截断损坏（同 SSE 修复思路）。

use html5ever::buffer_queue::BufferQueue;
use html5ever::tendril::StrTendril;
use html5ever::tokenizer::{
    CharacterTokens, Tag, TagKind, TagToken, Token, TokenSink, TokenSinkResult, Tokenizer,
    TokenizerOpts,
};
use std::sync::{Arc, Mutex};

/// 无用子树标签：进入即忽略其内部文本。
const IGNORED: &[&str] = &[
    "script", "style", "nav", "header", "footer", "iframe", "form", "svg", "noscript", "button",
    "input", "select", "textarea", "option",
];

/// 块级标签：前后换行分隔。
const BLOCK: &[&str] = &[
    "p", "div", "section", "article", "blockquote", "pre", "table", "tr", "td", "th", "ul", "ol",
    "dl", "hr", "main", "aside",
];

fn heading_level(name: &str) -> Option<usize> {
    name.strip_prefix('h')
        .and_then(|rest| rest.parse::<usize>().ok())
        .filter(|&l| (1..=6).contains(&l))
}

fn is_ignored(name: &str) -> bool {
    IGNORED.contains(&name)
}

fn is_block(name: &str) -> bool {
    BLOCK.contains(&name)
}

/// 链接累积（在 `<a>...</a>` 之间缓冲文本，闭合时输出 `[text](href)`）。
#[derive(Default)]
struct LinkAcc {
    href: String,
    text: String,
}

/// 流式 markdown 提取器：token 级处理 + 文本预算。
pub struct MarkdownExtractor {
    out: String,
    /// 已输出的字符数（预算判定用，避免每次 O(n) 统计）
    out_chars: usize,
    ignore_depth: usize,
    link: Option<LinkAcc>,
    budget: usize,
    /// 达到文本预算（调用方应停止喂入并断流）
    pub stopped: bool,
}

impl MarkdownExtractor {
    pub fn new(budget: usize) -> Self {
        Self {
            out: String::new(),
            out_chars: 0,
            ignore_depth: 0,
            link: None,
            budget,
            stopped: false,
        }
    }

    /// 追加一段文本（维护预算与计数；单个超长 token 按剩余预算截断）。
    fn push(&mut self, s: &str) {
        if self.stopped || s.is_empty() {
            return;
        }
        let remaining = self.budget.saturating_sub(self.out_chars);
        let take: String = s.chars().take(remaining).collect();
        self.out.push_str(&take);
        self.out_chars += take.chars().count();
        if take.chars().count() < s.chars().count() || self.out_chars >= self.budget {
            self.stopped = true;
        }
    }

    /// 确保以单个换行结尾（out 为空时不产生行首换行；空白清理由 finish 统一压缩）。
    fn newline(&mut self) {
        if self.stopped || self.out.is_empty() {
            return;
        }
        if !self.out.ends_with('\n') {
            self.push("\n");
        }
    }

    fn process_tag(&mut self, tag: &Tag) {
        let name: &str = &*tag.name;
        match tag.kind {
            TagKind::StartTag => {
                if is_ignored(name) {
                    self.ignore_depth += 1;
                    return;
                }
                if let Some(level) = heading_level(name) {
                    self.newline();
                    self.push(&"#".repeat(level));
                    self.push(" ");
                } else if name == "a" {
                    let href = tag
                        .attrs
                        .iter()
                        .find(|a| &*a.name.local == "href")
                        .map(|a| a.value.to_string())
                        .unwrap_or_default();
                    self.link = Some(LinkAcc {
                        href,
                        text: String::new(),
                    });
                } else if name == "li" {
                    self.newline();
                    self.push("- ");
                } else if name == "img" {
                    let src = tag
                        .attrs
                        .iter()
                        .find(|a| &*a.name.local == "src")
                        .map(|a| a.value.to_string())
                        .unwrap_or_default();
                    if !src.is_empty() {
                        let alt = tag
                            .attrs
                            .iter()
                            .find(|a| &*a.name.local == "alt")
                            .map(|a| a.value.to_string())
                            .unwrap_or_default();
                        self.push(&format!("![{alt}]({src})\n"));
                    }
                } else if is_block(name) {
                    self.newline();
                }
            }
            TagKind::EndTag => {
                if is_ignored(name) {
                    if self.ignore_depth > 0 {
                        self.ignore_depth -= 1;
                    }
                    return;
                }
                if heading_level(name).is_some() {
                    self.newline();
                } else if name == "a" {
                    if let Some(link) = self.link.take() {
                        let text = link.text.trim().to_string();
                        if !text.is_empty() && !link.href.is_empty() {
                            self.push(&format!("[{text}]({})", link.href));
                        } else if !text.is_empty() {
                            self.push(&text);
                        }
                    }
                } else if is_block(name) {
                    self.newline();
                }
            }
        }
    }

    fn process_token(&mut self, token: Token) {
        match token {
            CharacterTokens(t) => {
                if self.ignore_depth > 0 {
                    return;
                }
                if t.trim().is_empty() {
                    return; // 纯空白 token 跳过，避免空格堆积
                }
                if let Some(link) = &mut self.link {
                    link.text.push_str(&t);
                } else {
                    self.push(&t);
                }
            }
            TagToken(tag) => self.process_tag(&tag),
            // 注释/解析错误/EOF/doctype 等一律忽略
            _ => {}
        }
    }

    /// 收尾：统一压缩输出（行尾去空白、合并连续空行）并 trim。
    pub fn finish(&mut self) -> String {
        if self.out.is_empty() {
            return String::new();
        }
        self.newline();
        let mut result = String::with_capacity(self.out.len());
        let mut blank = false;
        for raw_line in self.out.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                if !blank && !result.is_empty() {
                    result.push('\n');
                }
                blank = true;
            } else {
                result.push_str(line);
                result.push('\n');
                blank = false;
            }
        }
        result.trim().to_string()
    }
}

/// 本地包装：让 `Arc<Mutex<MarkdownExtractor>>` 满足 TokenSink（孤儿规则要求自类型为本地类型；
/// Arc<Mutex> 使提取器可跨 await、跨线程 Send，供 Tauri 命令使用）。
#[derive(Clone)]
struct SharedExtractor(Arc<Mutex<MarkdownExtractor>>);

impl TokenSink for SharedExtractor {
    type Handle = ();
    fn process_token(&self, token: Token, _line_number: u64) -> TokenSinkResult<Self::Handle> {
        self.0
            .lock()
            .expect("提取器锁被毒化")
            .process_token(token);
        TokenSinkResult::Continue
    }
}

/// 流式提取器封装：字节缓冲 + tokenizer + 预算检查，供 web_fetch 逐 chunk 喂入。
pub struct HtmlExtractor {
    inner: Arc<Mutex<MarkdownExtractor>>,
    tokenizer: Tokenizer<SharedExtractor>,
    pending: Vec<u8>,
}

impl HtmlExtractor {
    pub fn new(budget: usize) -> Self {
        let inner = Arc::new(Mutex::new(MarkdownExtractor::new(budget)));
        let tokenizer = Tokenizer::new(SharedExtractor(inner.clone()), TokenizerOpts::default());
        Self {
            inner,
            tokenizer,
            pending: Vec::new(),
        }
    }

    /// 喂入一个新网络 chunk（内部缓冲，只把完整 UTF-8 前缀送入 tokenizer）。
    pub fn feed(&mut self, chunk: &[u8]) {
        self.pending.extend_from_slice(chunk);
        loop {
            let valid = match std::str::from_utf8(&self.pending) {
                Ok(s) => s.len(),
                Err(e) => e.valid_up_to(),
            };
            if valid == 0 {
                break; // 首字符不完整，等下一 chunk
            }
            let s = std::str::from_utf8(&self.pending[..valid])
                .expect("valid_up_to 处为合法字符边界");
            let queue = BufferQueue::default();
            queue.push_back(StrTendril::from_slice(s));
            let _ = self.tokenizer.feed(&queue);
            self.pending.drain(..valid);
            if self.pending.is_empty() {
                break;
            }
        }
    }

    /// 是否已达到文本预算（调用方应停止下载）。
    pub fn stopped(&self) -> bool {
        self.inner.lock().expect("提取器锁被毒化").stopped
    }

    /// 结束解析并输出 markdown（统一压缩空白）。
    pub fn finish(self) -> String {
        self.tokenizer.end();
        self.inner.lock().expect("提取器锁被毒化").finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(html: &str, budget: usize) -> (bool, String) {
        let mut ex = HtmlExtractor::new(budget);
        ex.feed(html.as_bytes());
        let stopped = ex.stopped();
        (stopped, ex.finish())
    }

    #[test]
    fn extracts_headings_links_lists_and_skips_junk() {
        let html = r#"
            <html><head><style>.x{}</style></head>
            <body>
              <nav>导航</nav>
              <h1>标题一</h1>
              <p>第一段 <a href="https://example.com/a">链接A</a> 结尾。</p>
              <ul><li>项目一</li><li>项目二</li></ul>
              <script>var x = 1;</script>
              <footer>页脚</footer>
            </body></html>
        "#;
        let (_, out) = extract(html, 10_000);
        assert!(out.contains("# 标题一"), "out: {out}");
        assert!(out.contains("第一段"));
        assert!(out.contains("[链接A](https://example.com/a)"));
        assert!(out.contains("- 项目一"));
        assert!(!out.contains("var x"), "script 内容应被丢弃");
        assert!(!out.contains("导航"), "nav 内容应被丢弃");
        assert!(!out.contains("页脚"), "footer 内容应被丢弃");
    }

    #[test]
    fn budget_stops_extraction() {
        let html = format!("<p>{}</p>", "a".repeat(5000));
        let (stopped, out) = extract(&html, 1000);
        assert!(stopped, "应达到预算");
        assert!(out.chars().count() < 5000, "应被截断");
        assert!(out.chars().count() >= 1000);
    }

    #[test]
    fn feeds_across_chunk_boundaries_without_mangling_utf8() {
        // 「正确」= E6 AD A3 E7 A1 AE；逐字节喂入，模拟网络分片
        let html = "<p>正确</p>";
        let mut ex = HtmlExtractor::new(10_000);
        for b in html.as_bytes() {
            ex.feed(&[*b]);
        }
        let out = ex.finish();
        assert_eq!(out, "正确", "跨 chunk 的中文不应损坏: {out:?}");
        assert!(!out.contains('\u{fffd}'));
    }

    #[test]
    fn empty_or_textless_html_returns_empty() {
        let (_, out) = extract("<html><body><script>x</script></body></html>", 10_000);
        assert!(out.is_empty());
    }
}

