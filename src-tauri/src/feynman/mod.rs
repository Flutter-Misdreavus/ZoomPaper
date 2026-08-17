//! 费曼学习法多轮对话（闯关式教学流）。
//!
//! 用户扮演「老师」，AI 扮演「聪明但陌生的本科生」。会话以「概念计划」开场：AI 基于论文
//! 生成 5-8 个核心概念的教学路线，用户确认（可增删调序）后逐概念闯关——
//! 讲解 → 追问 → 用户点「测验我」→ 学生出题 → 用户作答 → 「交卷」判定 通过/需补讲。
//!
//! 上下文策略：论文结构以「章节地图（TOC）」常驻 system，每轮用 RAG 命中的相关章节
//! 全文补细节；历史用「滚动窗口 + 教学进展摘要」控 token（旧轮次在线压缩）。闯关进度
//! （概念计划 / 当前关卡 / 各概念状态）持久化在 `conversations.feynman_state`，由命令层读写；
//! 旧会话该列为 NULL，走「自由聊天」遗留路径。本模块只负责 prompt、状态结构与 LLM 调用。

use crate::ai::llm::{ChatMessage, Llm, Role};
use anyhow::Result;
use serde::{Deserialize, Serialize};

/// 每轮发给 LLM 的原始历史消息条数上限（窗口）；更早的轮次压缩为摘要。
pub const WINDOW_MAX_MSGS: usize = 10;

/// 「教学进展」摘要长度上限（字符），防御性截断。
const SUMMARY_MAX_CHARS: usize = 1500;

/// 章节地图 TOC 最多列出的章节数（其余省略）。
const TOC_MAX_SECTIONS: usize = 30;

/// 每轮检索该论文相关段落的条数。
pub const TOP_K: usize = 5;

/// 每轮升级为「章节级全文」的最多章节数。
pub const MAX_SECTIONS: usize = 2;

/// 单个章节全文的长度上限（字符）。
pub const SECTION_MAX_CHARS: usize = 8000;

/// 章节级上下文总长度上限（字符）。
pub const SECTION_CTX_TOTAL_MAX: usize = 12000;

/// 首轮「通读全文」的字符上限（超长截断，防御性）。
pub const FULL_PAPER_MAX_CHARS: usize = 120_000;

/// 教学计划最多概念数（超出截断）。
pub const PLAN_MAX_ITEMS: usize = 10;

/// 概念名长度上限（字符）。
pub const PLAN_NAME_MAX_CHARS: usize = 60;

/// 教学目标长度上限（字符）。
pub const OBJECTIVE_MAX_CHARS: usize = 240;

/// 学生人格 system prompt（不含论文内容，论文结构/摘要/当前关卡由组装函数拼接）。
/// 阶段感知：教学阶段一次聚焦一个点、大段输入先拆解；测验/判定由专门指令驱动。
const FEYNMAN_SYSTEM_PROMPT: &str = "你是一名正在学习这篇论文的本科生：聪明，但对这篇论文还比较陌生。用户将扮演「老师」，按照「闯关教学计划」逐个概念向你讲解（每个概念是一关：讲解 → 追问 → 测验 → 判定）。\n\n【教学阶段】你的任务：\n1. 认真听讲，表现出求知欲，但不要显得愚蠢。\n2. 当老师的讲解含糊、跳跃或缺少直觉时，礼貌地追问，让他讲清楚。\n3. 适时请老师用类比或生活中的例子解释，帮助你建立直觉。\n4. 偶尔（不是每次都）故意表现出一个基于论文内容的小错误或误解，看老师能否发现并纠正；被纠正后要表现出「恍然大悟」。\n5. 每次回应末尾，从「简洁度、准确性、直觉性」三个维度给一句简短反馈（可指出讲得好或可改进处），自然融入对话，不要写成打分表格。\n6. 如果老师一次性发来很长或多段的讲解：先在回应开头把它拆解成几个可检验的论点，逐点标注「✅ 讲清楚了 / ⚠️ 有点含糊 / ❓ 没讲到或没讲透」，再只挑其中最重要的一个点继续追问。不要逐条纠缠，不要复述原文。\n\n要求：\n- 始终用中文，语气像求知的学生，自然、口语化、不啰嗦。\n- 一次只聚焦一个点，不要一次抛出一大堆问题。\n- 紧扣论文内容，不要编造论文里没有的东西。";

/// 教学复盘 system prompt。
const REVIEW_PROMPT: &str = "你是费曼学习法的复盘教练。下面是一段「老师（用户）教学生（AI）」的教学对话，老师讲解的是某篇论文里的概念。\n\n请评估老师讲解的质量，从以下三个维度展开：\n1. 简洁度：能否用简单语言讲清楚，有没有不必要的啰嗦或术语堆砌。\n2. 准确性：讲解是否与论文内容一致，有没有错误或含糊。\n3. 直觉性：是否给出类比/直觉，帮助真正理解，而非死记硬背。\n\n输出 Markdown：先给一个总评（两三句），再分三个维度分别点评（各点出「做得好的」和「可改进的」），最后给 2-3 条具体改进建议。语气客观、有建设性。";

/// 概念计划生成指令（system）：基于已通读的论文全文提炼 5-8 个核心概念的教学路线。
const PLAN_PROMPT: &str = "你是一名学习教练，正在为「费曼学习法」制定教学计划。用户将扮演老师，向一名本科生（你）讲解这篇论文的核心概念。请从论文中提炼 5-8 个最核心的概念，作为逐关教学的路线。\n\n要求：\n- 概念必须是论文实际讨论的内容，不得编造。\n- 粒度适中：一个概念应能在 3-5 轮对话内讲清楚；过细的机制细节应并入所属概念。\n- 按「先基础后进阶」排序（先讲背景与动机，再讲核心机制，最后讲结论与局限）。\n- 每个概念配一句「教学目标」（objective）：说清讲到什么程度算讲明白，例如「能用直觉解释 Q/K/V 的含义与注意力权重的计算」。\n\n只输出一个 JSON 数组，不要任何其他文字、注释或 Markdown 代码块：\n[{\"name\":\"概念名\",\"objective\":\"教学目标\"}]";

/// 概念引导提问指令（system）：进入一个新概念时，学生针对当前概念提出一个具体的引导问题，
/// 邀请老师开始讲解（而不是等老师先开口）。
const CONCEPT_OPENING_PROMPT: &str = "现在开始学习概念「{concept}」，教学目标：「{objective}」。请以学生的口吻，针对这个概念向老师提出一个具体的引导性问题，邀请他开始讲解。\n\n要求：\n- 只问一个问题，不要追加第二问；\n- 问题要具体、有抓手，能引出这个概念的核心（可结合论文相关章节的内容给出切入点），不要泛泛地问「你能讲讲这个概念吗」；\n- 语气像好奇的学生，自然口语化；\n- 不要替老师讲解，也不要给答案或提示。";

/// 测验出题指令（system）：学生针对当前概念只出 1 道题，选最能暴露理解缺口的题型。
const QUIZ_PROMPT: &str = "老师刚刚讲完了「{concept}」这个概念，教学目标：「{objective}」。现在轮到你出题，检验他是否真的讲明白了。\n\n只出 1 道测验题，从下面三种题型里选一个最能检验他理解深度的：\n- 「应用题」：让老师用这个概念解释一个新情境或论文里的具体现象/结果；\n- 「反例题」：给出一个包含细微错误的理解，问老师错在哪里；\n- 「类比题」：请老师用生活类比解释核心机制。\n\n要求：\n- 紧扣「{concept}」的教学目标，选最能暴露理解缺口的题型；\n- 只问一个问题，不要追加第二问，也不要列编号；\n- 语气像好奇的学生，自然口语化；\n- 不要给答案，也不要提示。";

/// 测验判定指令（user）：学生对照论文判定老师是否讲明白了当前概念。
const JUDGE_PROMPT: &str = "学生（你）针对概念「{concept}」出了一道测验题，老师（用户）已经作答（上方对话中出题之后的内容）。教学目标：「{objective}」。请对照论文相关内容，判断老师是否真正讲明白了这个概念。\n\n第一行只能输出「通过」或「需补讲」二选一（不要其他字符）。\n第二行起给 2-3 句理由：\n- 通过：肯定老师哪里讲得好（准确、有直觉、能应用）；\n- 需补讲：点名具体缺口——哪些点含糊、错误或完全没讲到。\n不要输出其他内容。";

/// 压缩「教学进展」摘要的 system prompt：把旧摘要与新滑出窗口的消息合并更新。
const SUMMARY_PROMPT: &str = "你正在整理一段费曼学习法教学对话的「进展摘要」。用户是老师，AI 是学生。\n\n请把对话压缩成一份 Markdown 摘要（3-5 条要点），记录：已经讲了哪些概念、学生当前的疑问、老师讲解中值得延续或待补充的地方。若消息中提供了已有摘要，请把它与新增对话合并更新，不要丢失关键信息。\n\n要求：直接输出摘要正文，控制在 350 字以内，不要寒暄。";

/// 概念完成摘要指令（system）：概念测验通过后，学生把这段教学对话压缩成供后续概念参考的摘要。
const CONCEPT_SUMMARY_PROMPT: &str = "你是费曼学习法的教学记录员。学生（你）刚刚完成了概念「{concept}」的学习并通过了测验。请把这段教学对话压缩成一份概念摘要（200 字以内），记录：\n1. 这个概念的核心要点（老师讲解的关键内容，用你能复述的方式）；\n2. 老师用过的类比或直觉（后续概念可以引用）；\n3. 需要记住的薄弱点（如果补讲过）。\n\n这份摘要会作为你对这个概念的「已有知识」传给后续所有概念的学习，请用第一人称学生口吻写（如「我理解了……」「老师用……比喻讲」）。直接输出摘要正文，不要标题。";

/// 会话中的一条消息（持久化到 conversations.messages 的 JSON）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeynmanMessage {
    pub role: Role,
    pub content: String,
}

/// `feynman_*` 的返回：学生回应 + 所属会话 id + 闯关状态（旧会话为 None）。
/// `concept_session_id`：概念级会话机制下，新建/激活的概念会话行 id（教学轮为 None）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeynmanTurn {
    pub conversation_id: String,
    pub reply: String,
    pub state: Option<FeynmanState>,
    #[serde(default)]
    pub concept_session_id: Option<String>,
}

/// 教学计划中的一项（一个概念 + 教学目标）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanItem {
    pub name: String,
    #[serde(default)]
    pub objective: String,
}

/// 单个概念的闯关状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConceptStatus {
    #[default]
    Pending,
    Teaching,
    /// 学生已出题，老师正在作答（概念级子状态）
    Quiz,
    Passed,
    Weak,
}

/// 会话级闯关阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageStatus {
    #[default]
    /// 概念计划已生成，等待老师确认/编辑
    Planning,
    /// 正在讲解当前概念（或测验通过后等待进入下一关）
    Teaching,
    /// 学生已出题，老师正在作答
    Quiz,
    /// 全部概念已通过测验
    Done,
}

/// 单个概念的状态记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConceptState {
    pub name: String,
    #[serde(default)]
    pub status: ConceptStatus,
    /// 上次测验未通过时记录的缺口描述
    #[serde(default)]
    pub weak_points: Vec<String>,
    /// 测验次数（含未通过轮次）
    #[serde(default)]
    pub quiz_attempts: u32,
    /// 通过测验的时间戳（unix 秒），未通过为 None
    #[serde(default)]
    pub taught_at: Option<i64>,
    /// 该概念独立会话行的 conversation id（概念级会话机制；旧结构为 None）
    #[serde(default)]
    pub session_id: Option<String>,
    /// 概念完成摘要（测验通过后生成，供后续概念参考；未通过为 None）
    #[serde(default)]
    pub summary: Option<String>,
}

/// 会话级闯关状态（持久化于 conversations.feynman_state 的 JSON）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeynmanState {
    /// 教学计划（确认后的路线）
    pub plan: Vec<PlanItem>,
    /// 当前所在概念的下标
    #[serde(default)]
    pub current_index: usize,
    /// 会话阶段
    #[serde(default)]
    pub status: StageStatus,
    /// 各概念状态（与 plan 一一对应）
    #[serde(default)]
    pub concepts: Vec<ConceptState>,
}

impl FeynmanState {
    /// 以 AI 生成的计划初始化：planning 阶段，全部概念 pending。
    pub fn new(plan: Vec<PlanItem>) -> Self {
        let concepts = plan
            .iter()
            .map(|p| ConceptState {
                name: p.name.clone(),
                status: ConceptStatus::Pending,
                weak_points: Vec::new(),
                quiz_attempts: 0,
                taught_at: None,
                session_id: None,
                summary: None,
            })
            .collect();
        FeynmanState {
            plan,
            current_index: 0,
            status: StageStatus::Planning,
            concepts,
        }
    }

    /// 当前概念（计划项）；计划为空返回 None。
    pub fn current_concept(&self) -> Option<&PlanItem> {
        self.plan.get(self.current_index)
    }

}

/// 组装章节地图：`【论文章节】\n- {name}`，节名截断 ≤60 字符、至多 `TOC_MAX_SECTIONS` 条。
pub fn build_toc(sections: &[String]) -> String {
    if sections.is_empty() {
        return String::new();
    }
    let mut out = String::from("【论文章节】\n");
    for s in sections.iter().take(TOC_MAX_SECTIONS) {
        let name: String = s.chars().take(60).collect();
        out.push_str(&format!("- {name}\n"));
    }
    if sections.len() > TOC_MAX_SECTIONS {
        out.push_str(&format!(
            "- ……（共 {} 节，仅列出前 {TOC_MAX_SECTIONS} 节）\n",
            sections.len()
        ));
    }
    out
}

/// 拼「论文全文」块（首轮通读用）：截断到 `FULL_PAPER_MAX_CHARS` 后加 `【论文全文】` 前缀。
pub fn build_full_paper(md: &str) -> String {
    let mut s = md.to_string();
    if s.chars().count() > FULL_PAPER_MAX_CHARS {
        s = s.chars().take(FULL_PAPER_MAX_CHARS).collect();
        s.push_str("\n\n……（论文过长，已截断）");
    }
    format!("【论文全文】\n{s}")
}

/// 把选中的章节全文拼成上下文：`【论文相关章节】\n### {section}\n{text}`。
pub fn build_section_context(sections: &[(String, String)]) -> String {
    if sections.is_empty() {
        return String::new();
    }
    let mut ctx = String::from("【论文相关章节】\n");
    for (section, text) in sections {
        ctx.push_str(&format!("### {section}\n{text}\n\n"));
    }
    ctx
}

/// 把完整历史切成「滑出部分（overflow，将被压缩成摘要）+ 最近窗口（window，原样保留）」。
/// 历史长度不超过窗口时 overflow 为空。
pub fn split_window(
    history: &[FeynmanMessage],
    max_msgs: usize,
) -> (Vec<FeynmanMessage>, Vec<FeynmanMessage>) {
    if history.len() <= max_msgs {
        return (Vec::new(), history.to_vec());
    }
    let n = history.len() - max_msgs;
    (history[..n].to_vec(), history[n..].to_vec())
}

/// 组装压缩摘要的消息：system 为压缩 prompt；user 为「已有摘要（若有）+ 新滑出的消息」。
pub fn build_summary_messages(
    existing: Option<&str>,
    overflow: &[FeynmanMessage],
) -> Vec<ChatMessage> {
    let mut content = String::new();
    if let Some(ex) = existing {
        if !ex.trim().is_empty() {
            content.push_str("【已有摘要】\n");
            content.push_str(ex);
            content.push('\n');
        }
    }
    content.push_str("【新增对话】\n");
    for m in overflow {
        let role_label = match m.role {
            Role::User => "老师",
            Role::Assistant => "学生",
            Role::System => "系统",
        };
        content.push_str(&format!("{role_label}：{}\n\n", m.content));
    }
    vec![
        ChatMessage {
            role: Role::System,
            content: SUMMARY_PROMPT.to_string(),
        },
        ChatMessage {
            role: Role::User,
            content,
        },
    ]
}

/// 调 LLM 把「旧摘要 + 滑出消息」压缩成新摘要，并做长度上限截断。
pub async fn roll_summary(
    llm: &Llm,
    existing: Option<&str>,
    overflow: &[FeynmanMessage],
) -> Result<String> {
    let mut summary = llm.chat(&build_summary_messages(existing, overflow)).await?;
    if summary.chars().count() > SUMMARY_MAX_CHARS {
        summary = summary.chars().take(SUMMARY_MAX_CHARS).collect();
    }
    Ok(summary)
}

/// 组装「生成教学计划」消息：system（计划指令 + 章节地图 + 论文全文）+ 触发指令。
pub fn build_plan_messages(toc: &str, full_paper: &str) -> Vec<ChatMessage> {
    let mut system = format!("{PLAN_PROMPT}\n\n{toc}");
    if !full_paper.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(full_paper);
    }
    vec![
        ChatMessage {
            role: Role::System,
            content: system,
        },
        ChatMessage {
            role: Role::User,
            content: "请生成教学计划。".to_string(),
        },
    ]
}

/// 从 LLM 回复中解析教学计划 JSON 数组（容忍 Markdown 围栏与前后杂文），失败返回 None。
fn extract_json_array(raw: &str) -> Option<Vec<PlanItem>> {
    // 直接解析
    if let Ok(items) = serde_json::from_str::<Vec<PlanItem>>(raw.trim()) {
        return Some(items);
    }
    // 剥掉 ```json ... ``` 围栏
    let mut text = raw.trim().to_string();
    if text.starts_with("```") {
        let lines: Vec<&str> = text.lines().collect();
        let start = lines
            .iter()
            .position(|l| l.trim().starts_with("```"))
            .map(|i| i + 1)
            .unwrap_or(0);
        let end = lines
            .iter()
            .rposition(|l| l.trim().starts_with("```"))
            .unwrap_or(lines.len());
        text = lines[start..end].join("\n");
    }
    // 取首个 [ 与末个 ] 之间的子串
    if let (Some(a), Some(b)) = (text.find('['), text.rfind(']')) {
        if b > a {
            if let Ok(items) = serde_json::from_str::<Vec<PlanItem>>(&text[a..=b]) {
                return Some(items);
            }
        }
    }
    None
}

/// 归一化计划：去空名、截断长度、上限 `PLAN_MAX_ITEMS` 条。
pub fn normalize_plan(plan: Vec<PlanItem>) -> Vec<PlanItem> {
    let mut out = Vec::new();
    for item in plan {
        let name: String = item.name.trim().chars().take(PLAN_NAME_MAX_CHARS).collect();
        if name.is_empty() {
            continue;
        }
        let objective: String = item
            .objective
            .trim()
            .chars()
            .take(OBJECTIVE_MAX_CHARS)
            .collect();
        out.push(PlanItem { name, objective });
        if out.len() >= PLAN_MAX_ITEMS {
            break;
        }
    }
    out
}

/// 解析教学计划；解析失败或归一化后为空返回 None。
pub fn parse_plan(raw: &str) -> Option<Vec<PlanItem>> {
    let items = extract_json_array(raw)?;
    let normalized = normalize_plan(items);
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// 组装「概念引导提问」消息：system（学生人格 + 章节地图 + 相关章节 + 当前关卡 +
/// 提问指令）+ 窗口历史。用于确认计划后从第一个概念、以及每次进入下一概念时，
/// 学生主动提出一个引导问题邀请老师讲解。
pub fn build_concept_opening_messages(
    toc: &str,
    context: &str,
    window: &[FeynmanMessage],
    concept: &str,
    objective: &str,
    summary_chain: &str,
) -> Vec<ChatMessage> {
    let mut system = format!("{FEYNMAN_SYSTEM_PROMPT}\n\n{toc}");
    if !context.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(context);
    }
    system.push_str(&format!(
        "\n\n【当前关卡】\n- 概念：{concept}\n- 教学目标：{objective}\n- 阶段：开始讲解新概念"
    ));
    system.push_str("\n\n");
    system.push_str(&CONCEPT_OPENING_PROMPT.replace("{concept}", concept).replace("{objective}", objective));
    if !summary_chain.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(summary_chain);
    }
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: system,
    }];
    push_history(&mut messages, window);
    messages
}

/// 压入历史消息；若历史以 assistant 开头（「开始」后无前置 user），先补占位 user，
/// 满足 Anthropic Messages API「首条须为 user」的交替要求。连续同角色消息合并为一条
/// （如教学回复后紧跟测验出题，同为 assistant），保证多 Provider 交替约束安全。
fn push_history(messages: &mut Vec<ChatMessage>, history: &[FeynmanMessage]) {
    if matches!(history.first().map(|m| m.role), Some(Role::Assistant)) {
        messages.push(ChatMessage {
            role: Role::User,
            content: "开始".to_string(),
        });
    }
    for m in history {
        if let Some(last) = messages.last_mut() {
            if last.role == m.role {
                last.content.push_str("\n\n");
                last.content.push_str(&m.content);
                continue;
            }
        }
        messages.push(ChatMessage {
            role: m.role,
            content: m.content.clone(),
        });
    }
}

/// 摘要链长度上限（字符），防御性截断。
pub const SUMMARY_CHAIN_MAX_CHARS: usize = 3000;

/// 拼接 `concepts[0..upto]` 的概念完成摘要为「之前概念摘要」块（跳过 None/空）。
/// 供进入新概念时注入 system，作为学生对已学概念的「已有知识」（仅背景，不参与测验）。
pub fn build_summary_chain(state: &FeynmanState, upto: usize) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (i, c) in state.concepts.iter().take(upto).enumerate() {
        if let Some(s) = &c.summary {
            if !s.trim().is_empty() {
                let name = state.plan.get(i).map(|p| p.name.as_str()).unwrap_or(c.name.as_str());
                parts.push(format!("概念 {}「{name}」：{s}", i + 1));
            }
        }
    }
    if parts.is_empty() {
        return String::new();
    }
    let mut chain = format!("【之前概念摘要】\n{}", parts.join("\n"));
    if chain.chars().count() > SUMMARY_CHAIN_MAX_CHARS {
        chain = chain.chars().take(SUMMARY_CHAIN_MAX_CHARS).collect();
        chain.push_str("\n……（摘要过长，已截断）");
    }
    chain
}

/// 组装「生成概念完成摘要」消息：system（学生人格 + 章节地图 + 相关章节 + 当前关卡 +
/// 摘要指令）+ 窗口历史。测验通过后调用，输出该概念的完成摘要。
pub fn build_concept_summary_messages(
    toc: &str,
    context: &str,
    window: &[FeynmanMessage],
    concept: &str,
) -> Vec<ChatMessage> {
    let mut system = format!("{FEYNMAN_SYSTEM_PROMPT}\n\n{toc}");
    if !context.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(context);
    }
    system.push_str(&format!(
        "\n\n【当前关卡】\n- 概念：{concept}\n- 阶段：生成概念完成摘要\n\n"
    ));
    system.push_str(&CONCEPT_SUMMARY_PROMPT.replace("{concept}", concept));
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: system,
    }];
    push_history(&mut messages, window);
    messages
}

/// 组装「当前关卡」说明块（按概念索引）：阶段 + 该概念 + 教学目标（+ 上次测验缺口），注入 system。
/// 概念级会话机制下激活的概念可能不是主线 `current_index`，故按 `idx` 定位。
pub fn build_stage_note(state: &FeynmanState, idx: usize) -> String {
    let cur_passed = state
        .concepts
        .get(idx)
        .map(|c| c.status == ConceptStatus::Passed)
        .unwrap_or(false);
    let stage_label = match state.status {
        StageStatus::Planning => "制定教学计划（等待老师确认路线）",
        StageStatus::Teaching if cur_passed => "本概念已通过测验（老师可进入下一关）",
        StageStatus::Teaching => "讲解当前概念",
        StageStatus::Quiz => "老师正在作答测验题",
        StageStatus::Done => "全部概念已讲完（老师可补充讲解或生成复盘）",
    };
    let mut note = format!("【当前关卡】\n- 阶段：{stage_label}");
    if let Some(concept) = state.plan.get(idx) {
        note.push_str(&format!("\n- 概念：{}", concept.name));
        if !concept.objective.is_empty() {
            note.push_str(&format!("\n- 教学目标：{}", concept.objective));
        }
    }
    if let Some(cs) = state.concepts.get(idx) {
        if cs.status == ConceptStatus::Weak && !cs.weak_points.is_empty() {
            note.push_str("\n- 上次测验缺口：");
            note.push_str(&cs.weak_points.join("；"));
        }
    }
    note
}

/// 组装对话消息：system（学生人格 + 章节地图 + [首轮论文全文] + 教学进展摘要 + 当前关卡）+
/// 窗口历史 + 当前讲解（含相关章节）。`full_paper` 仅在首轮传入，后续轮次为 `None`。
/// `stage_note` 为空（旧会话）时省略当前关卡块。
pub fn build_turn_messages(
    toc: &str,
    full_paper: Option<&str>,
    summary: Option<&str>,
    context: &str,
    window: &[FeynmanMessage],
    user_msg: &str,
    stage_note: &str,
    summary_chain: &str,
) -> Vec<ChatMessage> {
    let mut system = format!("{FEYNMAN_SYSTEM_PROMPT}\n\n{toc}");
    if let Some(fp) = full_paper {
        if !fp.trim().is_empty() {
            system.push_str("\n\n");
            system.push_str(fp);
        }
    }
    if let Some(s) = summary {
        if !s.trim().is_empty() {
            system.push_str("\n\n【教学进展】\n");
            system.push_str(s);
        }
    }
    if !stage_note.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(stage_note);
    }
    if !summary_chain.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(summary_chain);
    }
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: system,
    }];
    push_history(&mut messages, window);
    let user_content = if context.is_empty() {
        user_msg.to_string()
    } else {
        format!("{context}\n\n{user_msg}")
    };
    // 窗口末尾若已是 user（如多次作答后直接续讲），合并进同一条，保持交替约束
    if let Some(last) = messages.last_mut() {
        if last.role == Role::User {
            last.content.push_str("\n\n");
            last.content.push_str(&user_content);
            return messages;
        }
    }
    messages.push(ChatMessage {
        role: Role::User,
        content: user_content,
    });
    messages
}

/// 组装「出测验题」消息：system（学生人格 + 章节地图 + 相关章节 + 摘要 + 当前关卡 +
/// 出题指令）+ 窗口历史。出题指令放 system，避免与窗口末尾的讲解消息合并。
/// `attempts` 为该概念已测验次数（未通过累计），用于降难度提示。
pub fn build_quiz_messages(
    toc: &str,
    summary: Option<&str>,
    context: &str,
    window: &[FeynmanMessage],
    concept: &str,
    objective: &str,
    attempts: u32,
    summary_chain: &str,
) -> Vec<ChatMessage> {
    let mut system = format!("{FEYNMAN_SYSTEM_PROMPT}\n\n{toc}");
    if !context.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(context);
    }
    if let Some(s) = summary {
        if !s.trim().is_empty() {
            system.push_str("\n\n【教学进展】\n");
            system.push_str(s);
        }
    }
    system.push_str(&format!(
        "\n\n【当前关卡】\n- 概念：{concept}\n- 教学目标：{objective}\n- 阶段：出测验题\n\n"
    ));
    let mut quiz = QUIZ_PROMPT.replace("{concept}", concept).replace("{objective}", objective);
    if attempts >= 1 {
        quiz.push_str(&format!(
            "\n\n注意：这是老师第 {} 次测验这个概念（此前未通过）。请适当降低难度：可以先给一个小提示，或考一个更基础的子问题，帮助老师把概念补起来。",
            attempts + 1
        ));
    }
    system.push_str(&quiz);
    if !summary_chain.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(summary_chain);
    }
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: system,
    }];
    push_history(&mut messages, window);
    messages
}

/// 组装「判定测验」消息：system（学生人格 + 章节地图 + 相关章节 + 摘要 + 当前关卡 +
/// 判定指令）+ 窗口历史（含出题与作答）。判定指令放 system，避免与作答消息合并。
pub fn build_judge_messages(
    toc: &str,
    summary: Option<&str>,
    context: &str,
    window: &[FeynmanMessage],
    concept: &str,
    objective: &str,
    summary_chain: &str,
) -> Vec<ChatMessage> {
    let mut system = format!("{FEYNMAN_SYSTEM_PROMPT}\n\n{toc}");
    if !context.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(context);
    }
    if let Some(s) = summary {
        if !s.trim().is_empty() {
            system.push_str("\n\n【教学进展】\n");
            system.push_str(s);
        }
    }
    system.push_str(&format!(
        "\n\n【当前关卡】\n- 概念：{concept}\n- 教学目标：{objective}\n- 阶段：判定测验结果\n\n"
    ));
    system.push_str(&JUDGE_PROMPT.replace("{concept}", concept).replace("{objective}", objective));
    if !summary_chain.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(summary_chain);
    }
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: system,
    }];
    push_history(&mut messages, window);
    messages
}

/// 解析判定回复：true = 通过，false = 需补讲。容错首行格式（加粗/符号前缀）。
pub fn parse_judge_verdict(reply: &str) -> bool {
    let first_line = reply.lines().next().unwrap_or("").trim();
    if first_line.contains("需补讲") || first_line.contains("需要补讲") {
        return false;
    }
    if first_line.contains("通过") {
        return true;
    }
    // 兜底：正文明确出现「需补讲」判需补讲，否则按通过（prompt 已约束首行格式）
    !reply.contains("需补讲") && !reply.contains("需要补讲")
}

/// 调用 LLM 完成一轮教学对话，返回学生回应。
pub async fn turn(llm: &Llm, messages: &[ChatMessage]) -> Result<String> {
    llm.chat(messages).await
}

/// 组装教学复盘消息：system 为复盘 prompt（附教学进展摘要与闯关状态），其后是窗口内的对话。
pub fn build_review_messages(
    summary: Option<&str>,
    state_note: &str,
    window: &[FeynmanMessage],
) -> Vec<ChatMessage> {
    let mut system = REVIEW_PROMPT.to_string();
    if let Some(s) = summary {
        if !s.trim().is_empty() {
            system.push_str("\n\n【教学进展摘要】\n");
            system.push_str(s);
        }
    }
    if !state_note.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(state_note);
    }
    let mut messages = vec![ChatMessage {
        role: Role::System,
        content: system,
    }];
    push_history(&mut messages, window);
    messages
}

/// 调用 LLM 生成教学复盘。
pub async fn review(
    llm: &Llm,
    summary: Option<&str>,
    state_note: &str,
    window: &[FeynmanMessage],
) -> Result<String> {
    llm.chat(&build_review_messages(summary, state_note, window)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: Role, content: &str) -> FeynmanMessage {
        FeynmanMessage {
            role,
            content: content.to_string(),
        }
    }

    #[test]
    fn build_toc_formats_and_caps_sections() {
        // 空 → 空字符串
        assert_eq!(build_toc(&[]), "");

        // 超长节名截断到 60 字符
        let long = "x".repeat(100);
        let toc = build_toc(&[long]);
        assert!(toc.starts_with("【论文章节】\n- "));
        assert!(toc.contains(&"x".repeat(60)));
        assert!(!toc.contains(&"x".repeat(61)));

        // 超过 TOC_MAX_SECTIONS → 省略提示
        let many: Vec<String> = (0..TOC_MAX_SECTIONS + 5)
            .map(|i| format!("Sec {i}"))
            .collect();
        let toc = build_toc(&many);
        assert_eq!(toc.matches("- Sec ").count(), TOC_MAX_SECTIONS);
        assert!(toc.contains("仅列出前"));
    }

    #[test]
    fn build_section_context_formats_sections() {
        assert_eq!(build_section_context(&[]), "");
        let ctx = build_section_context(&[
            ("Method".into(), "核心方法正文".into()),
            ("Results".into(), "结果正文".into()),
        ]);
        assert!(ctx.starts_with("【论文相关章节】\n"));
        assert!(ctx.contains("### Method\n核心方法正文"));
        assert!(ctx.contains("### Results\n结果正文"));
    }

    #[test]
    fn split_window_partitions_history() {
        let hist: Vec<FeynmanMessage> = (0..12).map(|i| msg(Role::User, &i.to_string())).collect();

        // 不足窗口 → overflow 空，window 全量
        let (o, w) = split_window(&hist[..5], 10);
        assert!(o.is_empty());
        assert_eq!(w.len(), 5);

        // 超过窗口 → overflow 前 n，window 后 10
        let (o, w) = split_window(&hist, 10);
        assert_eq!(o.len(), 2);
        assert_eq!(o[0].content, "0");
        assert_eq!(w.len(), 10);
        assert_eq!(w[0].content, "2");
    }

    #[test]
    fn build_summary_messages_includes_existing_and_overflow() {
        let overflow = vec![
            msg(Role::User, "我来教你注意力"),
            msg(Role::Assistant, "什么是注意力？"),
        ];
        let msgs = build_summary_messages(Some("旧摘要：讲了 Transformer"), &overflow);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("进展摘要"));
        assert!(msgs[1].content.contains("【已有摘要】"));
        assert!(msgs[1].content.contains("旧摘要"));
        assert!(msgs[1].content.contains("【新增对话】"));
        assert!(msgs[1].content.contains("老师：我来教你注意力"));
        assert!(msgs[1].content.contains("学生：什么是注意力？"));

        // 无旧摘要 → 只含新增对话
        let msgs = build_summary_messages(None, &overflow);
        assert!(!msgs[1].content.contains("已有摘要"));
        assert!(msgs[1].content.contains("新增对话"));
    }

    #[test]
    fn build_full_paper_truncates_long_markdown() {
        let short = build_full_paper("# Title\nbody");
        assert!(short.starts_with("【论文全文】"));
        assert!(short.contains("# Title"));

        let long = "a".repeat(FULL_PAPER_MAX_CHARS + 100);
        let out = build_full_paper(&long);
        assert!(out.contains("已截断"));
        assert!(out.chars().count() < FULL_PAPER_MAX_CHARS + 200);
    }

    #[test]
    fn parse_plan_handles_plain_fenced_and_noisy_replies() {
        // 纯 JSON
        let items = parse_plan(
            r#"[{"name":"注意力机制","objective":"解释 QKV"},{"name":"多头注意力","objective":"解释多头"}]"#,
        )
        .unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "注意力机制");
        assert_eq!(items[1].objective, "解释多头");

        // Markdown 围栏 + 前后杂文
        let items = parse_plan(
            "好的，这是计划：\n```json\n[{\"name\":\"A\",\"objective\":\"目标A\"}]\n```\n请确认",
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "A");

        // 无法解析 → None
        assert!(parse_plan("完全不是 JSON").is_none());
        assert!(parse_plan("[]").is_none()); // 空数组 → None
    }

    #[test]
    fn normalize_plan_trims_drops_empty_and_caps() {
        let plan = vec![
            PlanItem { name: "  注意力  ".into(), objective: "目标".into() },
            PlanItem { name: "  ".into(), objective: "空名".into() },
        ];
        let out = normalize_plan(plan);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "注意力");

        // 超长名称截断、超量截断
        let many: Vec<PlanItem> = (0..PLAN_MAX_ITEMS + 5)
            .map(|i| PlanItem { name: format!("概念{i}"), objective: String::new() })
            .collect();
        let out = normalize_plan(many);
        assert_eq!(out.len(), PLAN_MAX_ITEMS);
        let long_name = PlanItem { name: "x".repeat(100), objective: String::new() };
        assert_eq!(normalize_plan(vec![long_name])[0].name.chars().count(), PLAN_NAME_MAX_CHARS);
    }

    #[test]
    fn feynman_state_new_builds_planning_state() {
        let plan = vec![
            PlanItem { name: "A".into(), objective: "oA".into() },
            PlanItem { name: "B".into(), objective: String::new() },
        ];
        let state = FeynmanState::new(plan);
        assert_eq!(state.status, StageStatus::Planning);
        assert_eq!(state.current_index, 0);
        assert_eq!(state.concepts.len(), 2);
        assert!(state.concepts.iter().all(|c| c.status == ConceptStatus::Pending));
        assert_eq!(state.current_concept().unwrap().name, "A");
    }

    #[test]
    fn build_stage_note_includes_concept_and_objective() {
        let mut state = FeynmanState::new(vec![PlanItem {
            name: "自注意力".into(),
            objective: "解释 QKV".into(),
        }]);
        let note = build_stage_note(&state, 0);
        assert!(note.contains("制定教学计划"));
        assert!(note.contains("自注意力"));
        assert!(note.contains("解释 QKV"));

        // teaching 阶段 + 薄弱点
        state.status = StageStatus::Teaching;
        state.concepts[0].status = ConceptStatus::Weak;
        state.concepts[0].weak_points = vec!["Q 的定义含糊".into()];
        let note = build_stage_note(&state, 0);
        assert!(note.contains("讲解当前概念"));
        assert!(note.contains("Q 的定义含糊"));
    }

    #[test]
    fn build_plan_messages_has_plan_prompt_toc_and_fullpaper() {
        let msgs = build_plan_messages("【论文章节】\n- Method", "【论文全文】\n# Title\n正文…");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("教学计划"));
        assert!(msgs[0].content.contains("JSON 数组"));
        assert!(msgs[0].content.contains("论文章节"));
        assert!(msgs[0].content.contains("论文全文"));
        assert_eq!(msgs[1].role, Role::User);
    }

    #[test]
    fn build_concept_opening_messages_has_context_and_single_question_instruction() {
        let window = vec![msg(Role::Assistant, "开场白")];
        let msgs = build_concept_opening_messages(
            "【论文章节】\n- Method",
            "【论文相关章节】\n### Method\n…",
            &window,
            "推理接口",
            "能说出三种中间状态传递方式的代价",
            "",
        );
        assert_eq!(msgs.len(), 3); // [system, 占位user, assistant开场白]
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("开始讲解新概念"));
        assert!(msgs[0].content.contains("推理接口"));
        assert!(msgs[0].content.contains("能说出三种中间状态传递方式的代价"));
        assert!(msgs[0].content.contains("只问一个问题"));
        assert!(msgs[0].content.contains("不要追加第二问"));
        assert!(msgs[0].content.contains("论文相关章节"));
        assert_eq!(msgs[1].content, "开始");
        assert_eq!(msgs[2].content, "开场白");

        // 空窗口 → 直接 [system, 提问指令作为唯一 user 消息由模型响应]
        let msgs = build_concept_opening_messages("", "", &[], "X", "目标", "【之前概念摘要】\n概念 1：……");
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].content.contains("X"));
        assert!(msgs[0].content.contains("之前概念摘要"));
        assert!(msgs[0].content.contains("概念 1：……"));
    }

    #[test]
    fn build_turn_messages_has_system_toc_fullpaper_summary_stage_and_context() {
        let window = vec![
            msg(Role::User, "我来教你注意力"),
            msg(Role::Assistant, "什么是注意力？"),
        ];
        let msgs = build_turn_messages(
            "【论文章节】\n- Method",
            Some("【论文全文】\n正文…"),
            Some("讲了注意力机制"),
            "【论文相关章节】\n### Method\n…",
            &window,
            "注意力就是…",
            "【当前关卡】\n- 概念：注意力",
            "【之前概念摘要】\n概念 1：……",
        );
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("本科生"));
        assert!(msgs[0].content.contains("论文章节"));
        assert!(msgs[0].content.contains("论文全文"));
        assert!(msgs[0].content.contains("教学进展"));
        assert!(msgs[0].content.contains("讲了注意力机制"));
        assert!(msgs[0].content.contains("当前关卡"));
        assert!(msgs[0].content.contains("注意力"));
        assert!(msgs[0].content.contains("之前概念摘要")); // 摘要链注入
        // 已删除要点笔记，system 不应再包含笔记注入
        assert!(!msgs[0].content.contains("要点笔记"));
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[2].role, Role::Assistant);
        assert_eq!(msgs[3].role, Role::User);
        assert!(msgs[3].content.contains("【论文相关章节】"));
        assert!(msgs[3].content.contains("注意力就是…"));

        // 非首轮（full_paper=None）+ 空 stage_note + 空摘要链 → system 不含全文块与关卡块
        let msgs = build_turn_messages("【论文章节】\n- Method", None, None, "", &[], "继续", "", "");
        assert!(!msgs[0].content.contains("论文全文"));
        assert!(!msgs[0].content.contains("当前关卡"));
        assert!(!msgs[0].content.contains("之前概念摘要"));
    }

    #[test]
    fn build_turn_messages_without_context_omits_block() {
        let msgs = build_turn_messages("", None, None, "", &[], "直接讲解", "", "");
        assert_eq!(msgs[1].content, "直接讲解");
    }

    #[test]
    fn build_turn_messages_prepends_user_when_window_starts_with_assistant() {
        let window = vec![msg(Role::Assistant, "开场白")];
        let msgs = build_turn_messages("", None, None, "", &window, "我来教你", "", "");
        // [system, 占位user, assistant开场, user讲解]
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[1].content, "开始");
        assert_eq!(msgs[2].role, Role::Assistant);
        assert_eq!(msgs[3].content, "我来教你");
    }

    #[test]
    fn push_history_merges_consecutive_same_role_messages() {
        // 连续 assistant（如教学回复后紧跟测验出题）合并为一条
        let window = vec![
            msg(Role::Assistant, "教学回复"),
            msg(Role::Assistant, "测验题 1. ..."),
            msg(Role::User, "作答"),
        ];
        let msgs = build_turn_messages("", None, None, "", &window, "继续讲", "", "");
        // [system, 占位user, assistant(合并两条), user(作答+继续讲合并)]
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0].role, Role::System);
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[1].content, "开始");
        assert_eq!(msgs[2].role, Role::Assistant);
        assert!(msgs[2].content.contains("教学回复"));
        assert!(msgs[2].content.contains("测验题"));
        assert_eq!(msgs[3].role, Role::User);
        assert!(msgs[3].content.contains("作答"));
        assert!(msgs[3].content.contains("继续讲"));
    }

    #[test]
    fn build_quiz_messages_has_context_history_and_quiz_prompt() {
        let window = vec![
            msg(Role::User, "Q 是查询向量"),
            msg(Role::Assistant, "那 K 呢？"),
        ];
        let msgs = build_quiz_messages(
            "【论文章节】\n- Method",
            Some("讲了注意力"),
            "【论文相关章节】\n### Method\n…",
            &window,
            "注意力机制",
            "解释 QKV",
            0,
            "",
        );
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("出测验题"));
        assert!(msgs[0].content.contains("注意力机制"));
        assert!(msgs[0].content.contains("解释 QKV"));
        // 只出一题，不列编号
        assert!(msgs[0].content.contains("只出 1 道测验题"));
        assert!(msgs[0].content.contains("不要追加第二问"));
        assert_eq!(msgs[1].content, "Q 是查询向量");
        assert_eq!(msgs[2].content, "那 K 呢？");

        // 有失败记录 → 提示降难度
        let msgs = build_quiz_messages("", None, "", &[], "X", "目标", 2, "");
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].content.contains("第 3 次测验"));
        assert!(msgs[0].content.contains("降低难度"));
    }

    #[test]
    fn build_judge_messages_has_judge_prompt() {
        let window = vec![
            msg(Role::Assistant, "1. 什么是 Q？\n2. 这个说法对吗？"),
            msg(Role::User, "Q 是查询向量……"),
        ];
        let msgs = build_judge_messages(
            "【论文章节】\n- Method",
            None,
            "",
            &window,
            "注意力机制",
            "解释 QKV",
            "【之前概念摘要】\n概念 1：……",
        );
        assert_eq!(msgs.len(), 4);
        assert!(msgs[0].content.contains("判定测验结果"));
        assert!(msgs[0].content.contains("通过」或「需补讲"));
        // 窗口以 assistant 开头 → 先补占位 user
        assert_eq!(msgs[1].content, "开始");
        assert_eq!(msgs[2].content, "1. 什么是 Q？\n2. 这个说法对吗？");
        assert_eq!(msgs[3].content, "Q 是查询向量……");
    }

    #[test]
    fn parse_judge_verdict_classifies() {
        assert!(parse_judge_verdict("通过\n你讲得很清楚，Q 的定义准确……"));
        assert!(parse_judge_verdict("**通过**\n讲得好"));
        assert!(!parse_judge_verdict("需补讲\nQ 的含义讲得含糊……"));
        assert!(!parse_judge_verdict("❌ 需补讲\n……"));
        // 首行异常时兜底按正文判断
        assert!(!parse_judge_verdict("老师还需补讲\nQ 没讲透"));
        assert!(parse_judge_verdict("你讲得不错\n基本通过"));
    }

    #[test]
    fn build_review_messages_has_system_summary_state_and_window() {
        let window = vec![msg(Role::User, "我来讲")];
        let msgs = build_review_messages(Some("讲了注意力"), "【当前关卡】\n- 概念：注意力", &window);
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("复盘"));
        assert!(msgs[0].content.contains("教学进展摘要"));
        assert!(msgs[0].content.contains("讲了注意力"));
        assert!(msgs[0].content.contains("当前关卡"));
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[1].content, "我来讲");
    }

    #[test]
    fn build_review_messages_prepends_user_when_window_starts_with_assistant() {
        let window = vec![msg(Role::Assistant, "开场白")];
        let msgs = build_review_messages(None, "", &window);
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(msgs[1].content, "开始");
        assert_eq!(msgs[2].role, Role::Assistant);
    }

    #[test]
    fn build_summary_chain_skips_empty_and_caps() {
        let mut state = FeynmanState::new(vec![
            PlanItem { name: "A".into(), objective: String::new() },
            PlanItem { name: "B".into(), objective: String::new() },
            PlanItem { name: "C".into(), objective: String::new() },
        ]);
        // 全部无摘要 → 空
        assert_eq!(build_summary_chain(&state, 3), "");

        // 只有 0、2 有摘要，upto=2 只取 0
        state.concepts[0].summary = Some("用词典比喻 J-space".into());
        state.concepts[2].summary = Some("第三概念摘要".into());
        let chain = build_summary_chain(&state, 2);
        assert!(chain.starts_with("【之前概念摘要】"));
        assert!(chain.contains("概念 1「A」：用词典比喻 J-space"));
        assert!(!chain.contains("第三概念摘要")); // upto=2 不含索引 2

        let chain = build_summary_chain(&state, 3);
        assert!(chain.contains("概念 3「C」：第三概念摘要"));

        // 超长截断
        let mut big = FeynmanState::new(vec![PlanItem { name: "X".into(), objective: String::new() }]);
        big.concepts[0].summary = Some("长".repeat(SUMMARY_CHAIN_MAX_CHARS + 100));
        let chain = build_summary_chain(&big, 1);
        assert!(chain.contains("已截断"));
        assert!(chain.chars().count() <= SUMMARY_CHAIN_MAX_CHARS + 20);
    }

    #[test]
    fn build_concept_summary_messages_has_instruction_and_history() {
        let window = vec![
            msg(Role::User, "Q 是查询向量"),
            msg(Role::Assistant, "我理解了！"),
        ];
        let msgs = build_concept_summary_messages("【论文章节】\n- Method", "【论文相关章节】\n### Method\n…", &window, "注意力机制");
        assert_eq!(msgs[0].role, Role::System);
        assert!(msgs[0].content.contains("生成概念完成摘要"));
        assert!(msgs[0].content.contains("注意力机制"));
        assert!(msgs[0].content.contains("200 字以内"));
        assert!(msgs[0].content.contains("第一人称"));
        assert_eq!(msgs[1].content, "Q 是查询向量");
        assert_eq!(msgs[2].content, "我理解了！");
    }

    #[test]
    fn concept_state_serializes_session_and_summary_with_defaults() {
        // 新结构往返
        let state = FeynmanState::new(vec![PlanItem { name: "A".into(), objective: "o".into() }]);
        let mut s2 = state.clone();
        s2.concepts[0].session_id = Some("conv-0".into());
        s2.concepts[0].summary = Some("摘要".into());
        let json = serde_json::to_string(&s2).unwrap();
        let back: FeynmanState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.concepts[0].session_id.as_deref(), Some("conv-0"));
        assert_eq!(back.concepts[0].summary.as_deref(), Some("摘要"));

        // 旧结构（无 session_id/summary 字段）解析为 None（legacy 兼容）
        let legacy_json = r#"{"plan":[{"name":"A","objective":"o"}],"current_index":0,"status":"teaching","concepts":[{"name":"A","status":"passed","weak_points":[],"quiz_attempts":1,"taught_at":1700000000}]}"#;
        let legacy: FeynmanState = serde_json::from_str(legacy_json).unwrap();
        assert!(legacy.concepts[0].session_id.is_none());
        assert!(legacy.concepts[0].summary.is_none());
        assert_eq!(legacy.concepts[0].status, ConceptStatus::Passed);
    }
}
