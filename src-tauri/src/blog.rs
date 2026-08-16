//! AI 博客生成：论文 Markdown → 审稿式科普博客正文 + 第一性原理深度剖析。
//!
//! 一次生成包含两次顺序 LLM 调用：
//! 1. 正文：按「冷静客观的审稿人」prompt 生成论文解读文章（不吹捧、严格核查
//!    证据），并从论文 Markdown 提取图表清单（编号 + 说明 + 相对路径）注入
//!    prompt，强制嵌入论文原图；若 LLM 输出未引用任何已知图片，
//!    [`ensure_figures_embedded`] 自动在文末补「论文原图」区块兜底，保证
//!    「一定引用原文图片」。
//! 2. 剖析：按「第一性原理思考者」prompt 生成六维深度剖析（Task / Challenge /
//!    Insight / Novelty / Potential Flaw / Motivation）。
//!
//! 两部分拼接为单一 Markdown 落盘：正文在前，`# 深度剖析` 标记之后为六个 `##`
//! 段落（标题为英文锚点，界面显示中文标签）。本模块只负责 prompt 与调用 LLM；
//! 落盘 `blog.md` 与回写 `blog_md_path` 由命令层完成。

use crate::ai::llm::{ChatMessage, Llm, Role};
use anyhow::Result;
use std::collections::HashSet;

/// 超长论文截断阈值（字符）。约 12 万字符 ≈ 3 万 token，
/// 低于 gpt-4o-mini / Claude 的上下文上限，避免越界。
const MAX_MD_CHARS: usize = 120_000;

/// 博客正文与深度剖析的分界标记（H1），前端 `parseBlog` 依赖该行精确切分。
const ANALYSIS_MARKER: &str = "# 深度剖析";

/// 注入 prompt 的图表数量上限（防 token 膨胀）。
const MAX_FIGURES: usize = 30;

/// 图片上方查找 Figure/Table 说明的最大行数。
const CAPTION_LOOKBACK: usize = 4;

/// 论文中提取出的图表条目（供博客嵌入原图）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Figure {
    /// 图表编号，如 `Figure 1` / `Table 2`；无法识别时为兜底编号。
    pub id: String,
    /// 图表说明（caption），无说明时为空。
    pub caption: String,
    /// 相对论文目录的图片路径（如 `images/1.jpg`）。
    pub path: String,
}

/// 冷静客观审稿式正文 system prompt（后续若重写博客提示词，改这里即可）。
const BLOG_SYSTEM_PROMPT: &str = "你是一位冷静客观的科技论文评审写手，为程序员、工程师与 AI 爱好者撰写论文解读文章。你的立场是审稿人：不吹捧、不轻信，客观呈现论文的主张、证据与不足。文风轻松口语化（让非领域读者读得下去），但不追求爆款流量，不夸大、不煽情。

【语言风格】
1. 口语化、短句为主、多用设问（「这真的可行吗？」），像技术圈朋友在聊论文；允许第一人称表达阅读感受（「我读完之后的第一反应是…」）。
2. 克制：禁用夸张吹捧词，不要满屏感叹号；情绪以「审慎」「持保留意见」为主。
3. 审慎表达：论文的主张用「作者声称」「论文报告」「实验显示」区分；作者的解释与已验证的事实要分开（「作者认为这之所以有效，是因为…，但这一点并没有被直接验证」）。
4. 术语首次出现必须给出通俗解释；复杂公式用生活化类比；保留必要英文术语但紧跟中文解释。

【文章结构】（按顺序，可根据论文类型微调）
1. 【开头：冷静的钩子】这篇论文想解决什么问题？为什么值得关注？（直说问题本身的分量，不吹）
2. 【背景】当前痛点 + 现有方法的局限 + 这篇论文的主张。
3. 【核心方法：用人话讲清楚】一句话类比（必须）+ 分步骤图解（1-2-3 步骤）+ 创新点（客观描述，不拔高）。
4. 【实验实测：数据说话，但要较真】Markdown 对比表格 + 核查结果：对比是否公平、baseline 是否太弱、差异是否显著（有无置信区间/多次运行）、是否只报最好结果、消融是否完整、数据与算力成本、可复现性（代码/超参/种子是否公开）。
5. 【深度解读：为什么（可能）有效】作者给出的解释 + 它是被验证的事实还是讲得通的假设？与已知工作的联系。
6. 【审稿意见：局限与质疑】逐条列出主要疑点与局限：方法的关键假设、实验缺口、泛化性边界、可复现性、与相关工作的真实增量、可能的失败模式；明确写出「审稿人最想问的问题」。
7. 【业界影响：冷静评估】实际应用价值 + 对现有工具的影响 + 哪些是实在的进步、哪些还需要更多证据。
8. 【结尾：一句话总结 + 个人判断】这篇文章在什么前提下可信？值得读吗？留下一个开放问题（「你怎么看？」）。

【审稿核查清单】（写作前逐项过一遍，发现的问题写进第 4、6 段）
- 标题/摘要的强声称是否有实验直接支撑？
- baseline 是否公平、是否挑了最弱的比？
- 是否只报告最好的结果（cherry-pick）？
- 有无数次运行的方差 / 置信区间 / 显著性检验？
- 每个设计决策是否都有消融实验支持？
- 结论在多大范围内成立（数据集、场景、任务）？
- 代码 / 超参 / 复现细节是否公开？
- 方法的收益是否靠堆算力或工程 trick 换来的？
- 与 prior work 相比，真实增量有多大？

【视觉元素】
1. 必须包含至少一个 Markdown 对比表格。
2. 关键数字用 **粗体** 或 `代码块` 高亮。
3. 复杂方法用 1-2-3 步骤展示。
4. 提及论文图表处标注「见论文 Figure N」。

【引用论文原图（强制要求）】
- 用户消息会提供「图表清单」，列出论文中的图表编号、说明与图片相对路径（博客与论文同一目录，相对路径可直接使用）。
- 必须在文章合适位置（如核心方法、实验实测部分）嵌入至少 1-2 张与内容相关的原图，写法为 Markdown 图片：![图片说明](相对路径)。
- 图片路径必须与清单中给出的完全一致，原样复制，严禁改写、拼凑或臆造路径。
- 嵌入图片的同时，在正文用「见论文 Figure N」标注对应图表。
- 若清单为空（论文未提取到图表），则只用文字描述，不要编造图片。

【输出要求】
- 直接输出 Markdown 正文，不要写「好的」「以下是…」等寒暄。
- 禁止在正文中出现「# 深度剖析」这一标题（该标记为深度剖析栏目保留）。
- 篇幅适中，信息密度高，不要注水。";

/// 第一性原理深度剖析 system prompt。
const ANALYSIS_SYSTEM_PROMPT: &str = "你是第一性原理思考者，擅长从万物基本原理和常识出发，推演做事思路。请仔细阅读并分析这篇文章，就以下 6 点进行有条理的列举与讲解：

1. Task：这篇文章解决的是什么问题？请尽可能形式化！
2. Challenge：传统的方法在解决这个问题时遇到了什么挑战？
3. Insight：
   1). 作者的 Insight 是被什么 Inspiration 启发的？
   2). 作者的 Insight 究竟是什么？是在什么方面上的 Insight？对于每个 Insight，是哪些上述的 Inspiration 启发的？
4. Novelty：作者本篇文章的 Novelty 体现在何处？是否有架构上、方法上还是策略上的，支持自己 Insight 的创新？
   对于每一个 Novelty，请清晰严格按这个格式描述：【创新点解决的问题是什么】->【受哪个 insight 启发】->【设计了什么创新点，尽可能具体描述】
5. Potential Flaw：
   1). 当前问题的情境是否有局限？有没有可能通过延伸架构，解决一些新情境（例如：维度更多、条件更多、约束更多）下的问题？
   2). 在目前情境下，若数据有什么样的不好的性质，解决可能会遇到特别的困难？
   3). 在以上这些困难中，哪种困难值得深度挖掘写成 paper？
6. Motivation：
   请你总结这篇文章想到 general idea 的方式，最好以问句形式给出（如：之前的方法……，那可不可以尝试一下 xxx），遵循第一性原理，从问题的本质出发，找到最合理、最容易的，想到本篇文章 idea 的方式。

输出要求（严格遵守）：
- 依次输出以下六个部分，每部分以二级标题开头，标题必须精确为：Task、Challenge、Insight、Novelty、Potential Flaw、Motivation。
- 不得遗漏任何部分，不得增改标题；六个部分之外不要输出寒暄或总结。
- 每部分内容用 Markdown 撰写，简明扼要。";

/// 截断超长论文 Markdown，博客正文与深度剖析两次调用共用。
fn truncate_markdown(markdown: &str) -> String {
    let mut md = markdown.to_string();
    if md.chars().count() > MAX_MD_CHARS {
        md = md.chars().take(MAX_MD_CHARS).collect();
        md.push_str("\n\n……（论文过长，已截断）");
    }
    md
}

/// 提取一行内的 Markdown 行内图片引用 `![alt](path)`，返回 (alt, path) 列表。
fn inline_image_refs(line: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = line;
    loop {
        let Some(open) = rest.find("![") else { break };
        let after_open = &rest[open + 2..];
        let Some(close) = after_open.find(']') else { break };
        let alt = after_open[..close].trim();
        let after_close = &after_open[close + 1..];
        let Some(open_paren) = after_close.strip_prefix('(') else { break };
        let Some(paren_end) = open_paren.find(')') else { break };
        let path = open_paren[..paren_end].trim();
        out.push((alt.to_string(), path.to_string()));
        rest = &open_paren[paren_end + 1..];
    }
    out
}

/// 在行中查找 `Figure N` / `Table N`（不区分大小写），返回规范化编号。
fn find_figure_label(line: &str) -> Option<String> {
    let lower = line.to_lowercase();
    for kw in ["figure ", "table "] {
        if let Some(pos) = lower.find(kw) {
            let rest = &line[pos + kw.len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() {
                let word = &line[pos..pos + kw.len()];
                let label = format!("{} {}", word.trim(), digits);
                return Some(label);
            }
        }
    }
    None
}

/// 判断是否为可用的相对图片路径（排除远程 / data URI / 绝对路径 / Windows 盘符）。
fn is_relative_image_path(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    if path.starts_with("http://")
        || path.starts_with("https://")
        || path.starts_with("data:")
    {
        return false;
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return false;
    }
    // Windows 盘符（`C:\...` / `C:/...`）
    if path.len() >= 2 && path.as_bytes()[1] == b':' {
        return false;
    }
    true
}

/// 从论文 Markdown 提取图表清单：扫描图片引用，向上查找 Figure/Table 说明，
/// 按路径去重，上限 [`MAX_FIGURES`] 张。
pub fn extract_figures(markdown: &str) -> Vec<Figure> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut figures = Vec::new();
    let mut seen = HashSet::new();

    'outer: for (idx, line) in lines.iter().enumerate() {
        for (alt, path) in inline_image_refs(line) {
            if !is_relative_image_path(&path) || !seen.insert(path.clone()) {
                continue;
            }
            // 向上最多 CAPTION_LOOKBACK 行找最近的 Figure/Table 说明
            let mut id = String::new();
            let mut caption = String::new();
            for k in (idx.saturating_sub(CAPTION_LOOKBACK)..idx).rev() {
                if let Some(label) = find_figure_label(lines[k]) {
                    id = label;
                    caption = lines[k].trim().to_string();
                    break;
                }
            }
            if id.is_empty() {
                if !alt.is_empty() {
                    caption = alt;
                }
                id = format!("图片 {}", figures.len() + 1);
            }
            figures.push(Figure { id, caption, path });
            if figures.len() >= MAX_FIGURES {
                break 'outer;
            }
        }
    }
    figures
}

/// 图表清单段落文本（追加到 user 消息，供 LLM 按原样路径嵌入原图）。
fn figure_inventory(figures: &[Figure]) -> String {
    if figures.is_empty() {
        return "（论文未提取到图表，本次博客不嵌入图片，仅文字描述。）".to_string();
    }
    let mut s = String::from(
        "以下是论文中提取到的图表清单（图片路径为相对论文目录的相对路径，博客与论文在同一目录，可直接用于 Markdown 图片引用）：\n",
    );
    for f in figures {
        let caption = if f.caption.is_empty() {
            "（无说明）".to_string()
        } else {
            f.caption.clone()
        };
        s.push_str(&format!("- {}（{}）：{}\n", f.id, f.path, caption));
    }
    s
}

/// 组装博客正文对话消息：system 为公众号风格 prompt，user 为论文全文（超长截断）
/// + 图表清单。
pub fn build_messages(markdown: &str, figures: &[Figure]) -> Vec<ChatMessage> {
    let mut user = format!(
        "以下是一篇论文的 Markdown 全文，请据此撰写博客：\n\n{}",
        truncate_markdown(markdown)
    );
    user.push('\n');
    user.push_str(&figure_inventory(figures));
    vec![
        ChatMessage {
            role: Role::System,
            content: BLOG_SYSTEM_PROMPT.to_string(),
        },
        ChatMessage {
            role: Role::User,
            content: user,
        },
    ]
}

/// 组装深度剖析对话消息：system 为第一性原理 prompt，user 为论文 Markdown 全文。
pub fn build_analysis_messages(markdown: &str) -> Vec<ChatMessage> {
    vec![
        ChatMessage {
            role: Role::System,
            content: ANALYSIS_SYSTEM_PROMPT.to_string(),
        },
        ChatMessage {
            role: Role::User,
            content: format!(
                "以下是一篇论文的 Markdown 全文，请据此完成深度剖析：\n\n{}",
                truncate_markdown(markdown)
            ),
        },
    ]
}

/// 兜底：若正文未引用任何清单内的图片路径，在文末追加「论文原图」区块
/// （至多前 3 张），保证「一定引用原文图片」。
pub fn ensure_figures_embedded(blog: &str, figures: &[Figure]) -> String {
    if figures.is_empty() {
        return blog.to_string();
    }
    let referenced = figures.iter().any(|f| blog.contains(f.path.as_str()));
    if referenced {
        return blog.to_string();
    }
    let mut extra = String::from("\n\n## 论文原图\n\n");
    for f in figures.iter().take(3) {
        let caption = if f.caption.is_empty() {
            f.id.clone()
        } else {
            f.caption.clone()
        };
        extra.push_str(&format!("![{caption}]({})\n\n", f.path));
    }
    format!("{blog}{extra}")
}

/// 拼接博客正文与深度剖析为单一 Markdown 文件内容（前端按 `ANALYSIS_MARKER` 切分）。
pub fn join_blog(body: &str, analysis: &str) -> String {
    format!("{body}\n\n{ANALYSIS_MARKER}\n\n{analysis}")
}

/// 生成博客：先按公众号风格 prompt 生成正文（含原图嵌入 + 兜底），
/// 再生成六维深度剖析，拼接返回组合 Markdown。
pub async fn generate_blog(llm: &Llm, markdown: &str, figures: &[Figure]) -> Result<String> {
    let body = llm.chat(&build_messages(markdown, figures)).await?;
    let body = ensure_figures_embedded(&body, figures);
    let analysis = llm.chat(&build_analysis_messages(markdown)).await?;
    Ok(join_blog(&body, &analysis))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 剖析要求的六个段落标题（与 `ANALYSIS_SYSTEM_PROMPT` 一致）。
    const ANALYSIS_HEADINGS: [&str; 6] = [
        "Task",
        "Challenge",
        "Insight",
        "Novelty",
        "Potential Flaw",
        "Motivation",
    ];

    fn fig(id: &str, caption: &str, path: &str) -> Figure {
        Figure {
            id: id.to_string(),
            caption: caption.to_string(),
            path: path.to_string(),
        }
    }

    #[test]
    fn build_messages_uses_reviewer_prompt_and_includes_markdown() {
        let msgs = build_messages("# Title\n\nAbstract text.", &[]);

        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("审稿"));
        assert!(msgs[0].content.contains("作者声称"));
        assert_eq!(msgs[1].role, Role::User);
        assert!(msgs[1].content.contains("# Title"));
    }

    #[test]
    fn build_analysis_messages_requires_all_six_headings() {
        let msgs = build_analysis_messages("# Title\n\nAbstract text.");

        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::System);
        for h in ANALYSIS_HEADINGS {
            assert!(msgs[0].content.contains(h), "剖析 prompt 缺少标题 {h}");
        }
        assert_eq!(msgs[1].role, Role::User);
        assert!(msgs[1].content.contains("# Title"));
    }

    #[test]
    fn truncation_applies_to_both_message_builders() {
        let long = "a".repeat(MAX_MD_CHARS + 100);
        assert!(build_messages(&long, &[])[1].content.contains("已截断"));
        assert!(build_analysis_messages(&long)[1].content.contains("已截断"));
    }

    #[test]
    fn join_blog_concatenates_body_analysis_and_marker() {
        let joined = join_blog("正文", "## Task\nxxx");

        assert!(joined.starts_with("正文"));
        assert!(joined.contains("# 深度剖析"));
        assert!(joined.ends_with("## Task\nxxx"));
    }

    #[test]
    fn extract_figures_finds_images_with_preceding_captions() {
        let md = "正文\n\n**Figure 1**: 方法总览\n\n![](images/1.jpg)\n\n**Table 2** | 实验结果\n\n![](images/2.png)";
        let figs = extract_figures(md);

        assert_eq!(figs.len(), 2);
        assert_eq!(figs[0].id, "Figure 1");
        assert!(figs[0].caption.contains("方法总览"));
        assert_eq!(figs[0].path, "images/1.jpg");
        assert_eq!(figs[1].id, "Table 2");
        assert_eq!(figs[1].path, "images/2.png");
    }

    #[test]
    fn extract_figures_uses_alt_fallback_and_dedupes() {
        let md = "![架构图](images/a.jpg)\n\n![架构图](images/a.jpg)\n\n文字";
        let figs = extract_figures(md);

        assert_eq!(figs.len(), 1);
        assert_eq!(figs[0].id, "图片 1");
        assert_eq!(figs[0].caption, "架构图");
        assert_eq!(figs[0].path, "images/a.jpg");
    }

    #[test]
    fn extract_figures_ignores_remote_and_absolute_paths() {
        let md = "![远程](https://example.com/a.png)\n\n![](/abs/b.png)\n\n![](images/ok.jpg)";
        let figs = extract_figures(md);

        assert_eq!(figs.len(), 1);
        assert_eq!(figs[0].path, "images/ok.jpg");
    }

    #[test]
    fn build_messages_includes_figure_inventory() {
        let figs = vec![fig("Figure 1", "方法总览", "images/1.jpg")];
        let msgs = build_messages("# T\n\ntext", &figs);

        assert!(msgs[1].content.contains("图表清单"));
        assert!(msgs[1].content.contains("Figure 1"));
        assert!(msgs[1].content.contains("images/1.jpg"));
    }

    #[test]
    fn build_messages_notes_when_no_figures() {
        let msgs = build_messages("# T\n\ntext", &[]);

        assert!(msgs[1].content.contains("未提取到图表"));
    }

    #[test]
    fn ensure_figures_embeds_fallback_when_missing() {
        let figs = vec![
            fig("Figure 1", "a", "images/1.jpg"),
            fig("Figure 2", "b", "images/2.jpg"),
            fig("Figure 3", "c", "images/3.jpg"),
            fig("Figure 4", "d", "images/4.jpg"),
        ];
        let out = ensure_figures_embedded("只有文字", &figs);

        assert!(out.contains("## 论文原图"));
        assert!(out.contains("images/1.jpg"));
        assert!(out.contains("images/3.jpg"));
        assert!(!out.contains("images/4.jpg")); // 至多前 3 张
    }

    #[test]
    fn ensure_figures_keeps_blog_when_any_referenced() {
        let figs = vec![fig("Figure 1", "a", "images/1.jpg")];
        let blog = "见论文 Figure 1\n\n![](images/1.jpg)";
        let out = ensure_figures_embedded(blog, &figs);

        assert_eq!(out, blog);
    }

    #[test]
    fn ensure_figures_noop_when_empty_list() {
        let out = ensure_figures_embedded("只有文字", &[]);
        assert_eq!(out, "只有文字");
    }
}
