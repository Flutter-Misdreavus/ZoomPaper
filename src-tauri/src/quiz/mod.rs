//! 论文阅读理解测验（quiz/mod.rs）。
//!
//! AI 通读论文（全文或用户勾选章节）后出一套阅读理解题：选择题 + 主观题。
//! 两种答题模式：
//! - **考试模式（exam）**：整卷作答后统一交卷，AI 一次批改全部主观题并给出总评报告；
//! - **练习模式（practice）**：逐题作答、即时反馈。
//!
//! 选择题由本地对照答案判分；主观题由 LLM 对照原文与参考答案批改（得分 / 反馈 / 缺口）。
//! 本模块只负责 prompt、结构体、消息组装与 LLM 输出的容错解析；DB 读写与命令编排在
//! `commands.rs`，表结构见 `db/migrations.rs`（v12 `quizzes` 表）。

use crate::ai::llm::{ChatMessage, Role};
use serde::{Deserialize, Serialize};

/// 喂给 LLM 的论文内容字符上限（全文或选中章节拼接后统一截断）。
pub const CONTENT_MAX_CHARS: usize = 120_000;

/// 单套卷的题数上限（选择 + 主观合计，防御性截断）。
pub const MAX_QUESTIONS: usize = 15;

/// 每道题的满分（选择 / 主观统一，总分为百分制折算）。
pub const QUESTION_MAX_SCORE: f64 = 10.0;

/// 题干长度上限（字符）。
const QUESTION_MAX_CHARS: usize = 500;

/// 选项 / 参考答案 / 解析的长度上限（字符）。
const FIELD_MAX_CHARS: usize = 1000;

/// 单条「知识缺口」的长度上限（字符）。
const GAP_MAX_CHARS: usize = 200;

/// 出题指令（system）：按配置出选择 + 主观题，只输出 JSON 数组。
const GENERATE_QUIZ_PROMPT: &str = "你是一位论文阅读理解测验的命题人。请基于给定的论文内容，出一套阅读理解题，检验读者是否真正读懂了这篇论文。\n\n要求：\n- 题目必须基于论文实际内容，不得编造论文里没有的信息；\n- 覆盖论文的不同部分，不要集中在单一章节；\n- 选择题：4 个选项，只有 1 个正确答案，干扰项要「像对的」（基于常见误解设计），answer 填正确选项的字母（A/B/C/D）；\n- 主观题：答案无法在原文中直接抄到，需要理解后用自己的话回答；answer 给参考答案（100-200 字，含关键要点），explanation 给评分要点；\n- 每题标注其出处章节名（section，须从给定章节列表中原样选取；全文出题时同样标注）。\n\n只输出一个 JSON 数组，不要任何其他文字、注释或 Markdown 代码块：\n[{\"type\":\"choice\",\"question\":\"题干\",\"options\":[\"选项一\",\"选项二\",\"选项三\",\"选项四\"],\"answer\":\"A\",\"explanation\":\"解析\",\"section\":\"章节名\"},{\"type\":\"subjective\",\"question\":\"题干\",\"answer\":\"参考答案\",\"explanation\":\"评分要点\",\"section\":\"章节名\"}]";

/// 练习模式单题批改指令（system）：对照原文与参考答案批改一道主观题，只输出 JSON 对象。
const JUDGE_ONE_PROMPT: &str = "你是一位论文阅读理解测验的阅卷人。请对照论文原文与参考答案，批改读者对一道主观题的回答。\n\n批改维度：\n1. 准确性：回答是否与论文内容一致，有无事实性错误；\n2. 完整性：覆盖了参考答案的哪些关键要点，遗漏了什么；\n3. 理解深度：是死记硬背还是真正理解（能用自己的话、能举一反三）。\n\n只输出一个 JSON 对象，不要任何其他文字、注释或 Markdown 代码块：\n{\"score\":7,\"feedback\":\"2-4 句具体反馈：哪里答得好、哪里有误或遗漏\",\"gaps\":[\"缺口一\",\"缺口二\"]}\n\nscore 为 0-10 的整数；gaps 列出未掌握的具体知识点（无遗漏则为空数组）。";

/// 考试模式整卷批改指令（system）：批改全部主观题并输出总评报告，只输出 JSON 对象。
const GRADE_ALL_PROMPT: &str = "你是一位论文阅读理解测验的阅卷人。读者已整卷作答完毕，选择题已由系统判分（结果会一并给出），请批改其中的主观题，并基于整套卷的作答情况输出一份总评报告。\n\n主观题批改维度：准确性（与论文一致）、完整性（要点覆盖）、理解深度（是否真正理解）。\n\n只输出一个 JSON 对象，不要任何其他文字、注释或 Markdown 代码块：\n{\"grades\":[{\"question_id\":3,\"score\":7,\"feedback\":\"2-4 句具体反馈\",\"gaps\":[\"缺口一\"]}],\"report\":\"Markdown 总评报告\"}\n\n要求：\n- grades 覆盖每一道主观题，question_id 与题目编号一一对应；score 为 0-10 的整数；gaps 无遗漏则为空数组；\n- report 用 Markdown 撰写，包含：总体评价（两三句）、掌握较好的方面、薄弱点（结合具体错题）、建议重读的章节或内容；语气客观、有建设性。";

/// 出题配置（生成前由用户选择）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuizConfig {
    /// 选择题数量（0-10）。
    pub choice_count: usize,
    /// 主观题数量（0-5）。
    pub subjective_count: usize,
    /// 难度：基础 / 进阶 / 挑战。
    pub difficulty: String,
    /// 侧重点：全面 / 方法 / 实验 / 结论。
    pub focus: String,
    /// 出题章节（原样章节名）；空 = 全文。
    #[serde(default)]
    pub sections: Vec<String>,
}

/// 题型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionType {
    Choice,
    Subjective,
}

/// 一道测验题（questions JSON 数组的元素，含答案与解析）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuizQuestion {
    pub id: usize,
    pub qtype: QuestionType,
    pub question: String,
    /// 选择题选项（不含字母前缀，前端渲染 A/B/C/D）；主观题为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    /// 选择题：正确选项字母（"A"）；主观题：参考答案。
    pub answer: String,
    /// 选择题：解析；主观题：评分要点。
    #[serde(default)]
    pub explanation: String,
    /// 出处章节名（可能为空）。
    #[serde(default)]
    pub section: String,
}

/// 用户对一道题的作答。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserAnswer {
    pub question_id: usize,
    /// 选择题：选项字母；主观题：自由文本。
    pub answer: String,
}

/// 一道题的批改结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionGrade {
    pub question_id: usize,
    /// 选择题：本地判定的对错；主观题为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correct: Option<bool>,
    pub score: f64,
    pub max_score: f64,
    pub feedback: String,
    /// 未掌握的具体知识点。
    #[serde(default)]
    pub gaps: Vec<String>,
}

/// 前端-facing 的完整测验记录（quizzes 表行解析后）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quiz {
    pub id: String,
    pub paper_id: String,
    /// exam / practice。
    pub mode: String,
    pub config: QuizConfig,
    pub questions: Vec<QuizQuestion>,
    #[serde(default)]
    pub answers: Vec<UserAnswer>,
    #[serde(default)]
    pub grading: Vec<QuestionGrade>,
    #[serde(default)]
    pub report: Option<String>,
    /// 总得分（百分制），批改完成后写入。
    #[serde(default)]
    pub score: Option<f64>,
    /// answering / done。
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 历史列表条目（不含题目与批改详情）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuizSummary {
    pub id: String,
    pub mode: String,
    pub difficulty: String,
    pub focus: String,
    pub question_count: usize,
    #[serde(default)]
    pub score: Option<f64>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 截断论文内容到 `CONTENT_MAX_CHARS`（防御性）。
pub fn truncate_content(content: &str) -> String {
    let mut s = content.to_string();
    if s.chars().count() > CONTENT_MAX_CHARS {
        s = s.chars().take(CONTENT_MAX_CHARS).collect();
        s.push_str("\n\n……（内容过长，已截断）");
    }
    s
}

/// 组装「出题」消息：system（出题指令 + 配置 + 章节地图 + 论文内容）+ 触发指令。
pub fn build_generate_messages(config: &QuizConfig, toc: &str, content: &str) -> Vec<ChatMessage> {
    let mut system = GENERATE_QUIZ_PROMPT.to_string();
    system.push_str(&format!(
        "\n\n【出题配置】\n- 选择题：{} 道\n- 主观题：{} 道\n- 难度：{}\n- 侧重点：{}",
        config.choice_count, config.subjective_count, config.difficulty, config.focus
    ));
    if !config.sections.is_empty() {
        system.push_str(&format!(
            "\n- 出题范围：仅以下章节 —— {}",
            config.sections.join("、")
        ));
    }
    if !toc.is_empty() {
        system.push_str("\n\n");
        system.push_str(toc);
    }
    system.push_str("\n\n【论文内容】\n");
    system.push_str(content);
    vec![
        ChatMessage {
            role: Role::System,
            content: system,
        },
        ChatMessage {
            role: Role::User,
            content: "请按配置出题。".to_string(),
        },
    ]
}

/// 组装「单题批改」消息（练习模式主观题）：system 批改指令；user 为题目 + 作答 + 相关原文。
pub fn build_judge_one_messages(
    question: &QuizQuestion,
    answer: &str,
    context: &str,
) -> Vec<ChatMessage> {
    let mut user = format!(
        "【题目】{}\n\n【参考答案】{}\n\n【评分要点】{}\n\n【读者回答】\n{}",
        question.question, question.answer, question.explanation, answer
    );
    if !context.trim().is_empty() {
        user.push_str("\n\n【论文相关原文】\n");
        user.push_str(context);
    }
    vec![
        ChatMessage {
            role: Role::System,
            content: JUDGE_ONE_PROMPT.to_string(),
        },
        ChatMessage {
            role: Role::User,
            content: user,
        },
    ]
}

/// 组装「整卷批改」消息（考试模式）：system 批改指令；user 为选择题判分结果 +
/// 全部主观题（题目 / 参考答案 / 读者回答）+ 相关原文。
pub fn build_grade_all_messages(
    questions: &[QuizQuestion],
    answers: &[UserAnswer],
    choice_grades: &[QuestionGrade],
    context: &str,
) -> Vec<ChatMessage> {
    let mut user = String::from("【选择题系统判分结果】\n");
    let mut has_choice = false;
    for g in choice_grades {
        if let Some(q) = questions.iter().find(|q| q.id == g.question_id) {
            has_choice = true;
            let user_answer = answers
                .iter()
                .find(|a| a.question_id == q.id)
                .map(|a| a.answer.as_str())
                .unwrap_or("（未作答）");
            user.push_str(&format!(
                "- 第 {} 题：{}（读者回答 {}，正确答案 {}）\n  题目：{}\n",
                q.id,
                if g.correct == Some(true) { "正确" } else { "错误" },
                user_answer,
                q.answer,
                q.question
            ));
        }
    }
    if !has_choice {
        user.push_str("（本卷无选择题）\n");
    }
    user.push_str("\n【主观题待批改】\n");
    for q in questions
        .iter()
        .filter(|q| q.qtype == QuestionType::Subjective)
    {
        let user_answer = answers
            .iter()
            .find(|a| a.question_id == q.id)
            .map(|a| a.answer.as_str())
            .unwrap_or("（未作答）");
        user.push_str(&format!(
            "\n## 第 {} 题\n题目：{}\n参考答案：{}\n评分要点：{}\n读者回答：\n{}\n",
            q.id, q.question, q.answer, q.explanation, user_answer
        ));
    }
    if !context.trim().is_empty() {
        user.push_str("\n【论文相关原文】\n");
        user.push_str(context);
    }
    vec![
        ChatMessage {
            role: Role::System,
            content: GRADE_ALL_PROMPT.to_string(),
        },
        ChatMessage {
            role: Role::User,
            content: user,
        },
    ]
}

/// 从 LLM 回复中解析 JSON 数组（容忍 Markdown 围栏与前后杂文），失败返回 None。
/// 与费曼的 extract_json_array 同策略：直接解析 → 剥 ``` 围栏 → 取首个 `[` 到末个 `]`。
fn extract_json_array<T: serde::de::DeserializeOwned>(raw: &str) -> Option<Vec<T>> {
    if let Ok(items) = serde_json::from_str::<Vec<T>>(raw.trim()) {
        return Some(items);
    }
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
    if let (Some(a), Some(b)) = (text.find('['), text.rfind(']')) {
        if b > a {
            if let Ok(items) = serde_json::from_str::<Vec<T>>(&text[a..=b]) {
                return Some(items);
            }
        }
    }
    None
}

/// 从 LLM 回复中解析 JSON 对象（同三级容错，括号换成 `{}`）。
fn extract_json_object<T: serde::de::DeserializeOwned>(raw: &str) -> Option<T> {
    if let Ok(obj) = serde_json::from_str::<T>(raw.trim()) {
        return Some(obj);
    }
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
    if let (Some(a), Some(b)) = (text.find('{'), text.rfind('}')) {
        if b > a {
            if let Ok(obj) = serde_json::from_str::<T>(&text[a..=b]) {
                return Some(obj);
            }
        }
    }
    None
}

/// LLM 出题的原始 JSON 元素（qtype 用字符串容错解析）。
#[derive(Debug, Deserialize)]
struct RawQuestion {
    #[serde(rename = "type")]
    qtype: String,
    question: String,
    #[serde(default)]
    options: Option<Vec<String>>,
    #[serde(default)]
    answer: String,
    #[serde(default)]
    explanation: String,
    #[serde(default)]
    section: String,
}

/// 归一化选择题答案字母：取首个 A-D 字母（大写）。
fn normalize_choice_letter(raw: &str) -> Option<String> {
    raw.chars()
        .filter_map(|c| {
            let u = c.to_ascii_uppercase();
            ('A'..='Z').contains(&u).then_some(u)
        })
        .next()
        .map(|c| c.to_string())
}

/// 归一化题目列表：去空题、选择题校验选项与答案字母、逐字段截断、重排 id、
/// 上限 `MAX_QUESTIONS` 条。
pub fn normalize_questions(raw: Vec<RawQuestion>) -> Vec<QuizQuestion> {
    let mut out = Vec::new();
    for r in raw {
        let question: String = r.question.trim().chars().take(QUESTION_MAX_CHARS).collect();
        if question.is_empty() {
            continue;
        }
        let explanation: String = r.explanation.trim().chars().take(FIELD_MAX_CHARS).collect();
        let section: String = r.section.trim().chars().take(120).collect();
        let q = match r.qtype.trim().to_lowercase().as_str() {
            "choice" => {
                let options: Vec<String> = r
                    .options
                    .unwrap_or_default()
                    .into_iter()
                    .map(|o| o.trim().chars().take(FIELD_MAX_CHARS).collect::<String>())
                    .filter(|o| !o.is_empty())
                    .take(6)
                    .collect();
                if options.len() < 2 {
                    continue;
                }
                let Some(letter) = normalize_choice_letter(&r.answer) else {
                    continue;
                };
                // 答案字母必须落在选项范围内
                let idx = letter.as_bytes()[0] - b'A';
                if idx as usize >= options.len() {
                    continue;
                }
                QuizQuestion {
                    id: 0,
                    qtype: QuestionType::Choice,
                    question,
                    options: Some(options),
                    answer: letter,
                    explanation,
                    section,
                }
            }
            "subjective" => {
                let answer: String = r.answer.trim().chars().take(FIELD_MAX_CHARS).collect();
                if answer.is_empty() {
                    continue;
                }
                QuizQuestion {
                    id: 0,
                    qtype: QuestionType::Subjective,
                    question,
                    options: None,
                    answer,
                    explanation,
                    section,
                }
            }
            _ => continue,
        };
        out.push(q);
        if out.len() >= MAX_QUESTIONS {
            break;
        }
    }
    for (i, q) in out.iter_mut().enumerate() {
        q.id = i + 1;
    }
    out
}

/// 解析出题结果；解析失败或归一化后为空返回 None。
pub fn parse_questions(raw: &str) -> Option<Vec<QuizQuestion>> {
    let items = extract_json_array::<RawQuestion>(raw)?;
    let normalized = normalize_questions(items);
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// 本地判分一道选择题：答案字母规范化后比对。
pub fn grade_choice(question: &QuizQuestion, answer: &str) -> QuestionGrade {
    let user_letter = normalize_choice_letter(answer);
    let correct = user_letter.as_deref() == Some(question.answer.as_str());
    QuestionGrade {
        question_id: question.id,
        correct: Some(correct),
        score: if correct { QUESTION_MAX_SCORE } else { 0.0 },
        max_score: QUESTION_MAX_SCORE,
        feedback: if correct {
            String::new()
        } else {
            question.explanation.clone()
        },
        gaps: Vec::new(),
    }
}

/// LLM 批改的原始 JSON（单题与整卷共用元素结构）。
#[derive(Debug, Deserialize)]
struct RawGrade {
    question_id: Option<usize>,
    #[serde(default)]
    score: f64,
    #[serde(default)]
    feedback: String,
    #[serde(default)]
    gaps: Vec<String>,
}

fn raw_grade_to_question_grade(question_id: usize, r: RawGrade) -> QuestionGrade {
    QuestionGrade {
        question_id,
        correct: None,
        score: r.score.clamp(0.0, QUESTION_MAX_SCORE),
        max_score: QUESTION_MAX_SCORE,
        feedback: r.feedback.trim().chars().take(FIELD_MAX_CHARS).collect(),
        gaps: r
            .gaps
            .into_iter()
            .map(|g| g.trim().chars().take(GAP_MAX_CHARS).collect::<String>())
            .filter(|g| !g.is_empty())
            .take(5)
            .collect(),
    }
}

/// 解析练习模式单题批改结果；失败返回 None。
pub fn parse_judge_one(raw: &str, question_id: usize) -> Option<QuestionGrade> {
    let r = extract_json_object::<RawGrade>(raw)?;
    Some(raw_grade_to_question_grade(question_id, r))
}

/// 整卷批改的原始 JSON：grades 数组 + report Markdown。
#[derive(Debug, Deserialize)]
struct RawGradeAll {
    #[serde(default)]
    grades: Vec<RawGrade>,
    #[serde(default)]
    report: String,
}

/// 解析考试模式整卷批改结果：(逐题批改, 总评报告)；失败返回 None。
pub fn parse_grade_all(raw: &str) -> Option<(Vec<QuestionGrade>, String)> {
    let r = extract_json_object::<RawGradeAll>(raw)?;
    let grades = r
        .grades
        .into_iter()
        .filter_map(|g| g.question_id.map(|id| raw_grade_to_question_grade(id, g)))
        .collect::<Vec<_>>();
    if grades.is_empty() {
        return None;
    }
    Some((grades, r.report.trim().to_string()))
}

/// 计算总分（百分制）：得分合计 / 满分合计 × 100。
pub fn compute_score(grading: &[QuestionGrade]) -> Option<f64> {
    if grading.is_empty() {
        return None;
    }
    let earned: f64 = grading.iter().map(|g| g.score).sum();
    let max: f64 = grading.iter().map(|g| g.max_score).sum();
    if max <= 0.0 {
        return None;
    }
    Some((earned / max * 100.0 * 10.0).round() / 10.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_questions_direct_json() {
        let raw = r#"[
            {"type":"choice","question":"本文提出的方法叫什么？","options":["甲","乙","丙","丁"],"answer":"B","explanation":"见第 3 节","section":"方法"},
            {"type":"subjective","question":"为什么作者采用 X？","answer":"因为……","explanation":"要点：……","section":"方法"}
        ]"#;
        let qs = parse_questions(raw).unwrap();
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[0].id, 1);
        assert_eq!(qs[0].qtype, QuestionType::Choice);
        assert_eq!(qs[0].options.as_ref().unwrap().len(), 4);
        assert_eq!(qs[0].answer, "B");
        assert_eq!(qs[1].qtype, QuestionType::Subjective);
    }

    #[test]
    fn parse_questions_tolerates_fence_and_prose() {
        let raw = "好的，以下是题目：\n```json\n[{\"type\":\"choice\",\"question\":\"Q\",\"options\":[\"a\",\"b\",\"c\",\"d\"],\"answer\":\"c\"}]\n```\n希望对你有帮助";
        let qs = parse_questions(raw).unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].answer, "C");
    }

    #[test]
    fn normalize_drops_invalid_questions() {
        let raw = vec![
            // 空题干 → 丢弃
            RawQuestion {
                qtype: "choice".into(),
                question: "  ".into(),
                options: Some(vec!["a".into(), "b".into()]),
                answer: "A".into(),
                explanation: String::new(),
                section: String::new(),
            },
            // 选项不足 2 → 丢弃
            RawQuestion {
                qtype: "choice".into(),
                question: "Q".into(),
                options: Some(vec!["a".into()]),
                answer: "A".into(),
                explanation: String::new(),
                section: String::new(),
            },
            // 答案字母超出选项范围 → 丢弃
            RawQuestion {
                qtype: "choice".into(),
                question: "Q".into(),
                options: Some(vec!["a".into(), "b".into()]),
                answer: "D".into(),
                explanation: String::new(),
                section: String::new(),
            },
            // 主观题空答案 → 丢弃
            RawQuestion {
                qtype: "subjective".into(),
                question: "Q".into(),
                options: None,
                answer: " ".into(),
                explanation: String::new(),
                section: String::new(),
            },
            // 未知题型 → 丢弃
            RawQuestion {
                qtype: "fill".into(),
                question: "Q".into(),
                options: None,
                answer: "A".into(),
                explanation: String::new(),
                section: String::new(),
            },
        ];
        assert!(normalize_questions(raw).is_empty());
    }

    #[test]
    fn normalize_reids_sequentially_and_caps() {
        let raw: Vec<RawQuestion> = (0..20)
            .map(|_| RawQuestion {
                qtype: "subjective".into(),
                question: "Q".into(),
                options: None,
                answer: "A".into(),
                explanation: String::new(),
                section: String::new(),
            })
            .collect();
        let qs = normalize_questions(raw);
        assert_eq!(qs.len(), MAX_QUESTIONS);
        assert_eq!(qs[0].id, 1);
        assert_eq!(qs.last().unwrap().id, MAX_QUESTIONS);
    }

    #[test]
    fn grade_choice_normalizes_letters() {
        let q = QuizQuestion {
            id: 1,
            qtype: QuestionType::Choice,
            question: "Q".into(),
            options: Some(vec!["a".into(), "b".into(), "c".into(), "d".into()]),
            answer: "B".into(),
            explanation: "因为……".into(),
            section: String::new(),
        };
        let g = grade_choice(&q, "b");
        assert_eq!(g.correct, Some(true));
        assert_eq!(g.score, QUESTION_MAX_SCORE);
        assert!(g.feedback.is_empty());
        let g = grade_choice(&q, "A. 甲");
        assert_eq!(g.correct, Some(false));
        assert_eq!(g.score, 0.0);
        assert_eq!(g.feedback, "因为……");
    }

    #[test]
    fn parse_judge_one_tolerates_fence() {
        let raw = "```json\n{\"score\":8,\"feedback\":\"答得不错\",\"gaps\":[\"缺口\"]}\n```";
        let g = parse_judge_one(raw, 3).unwrap();
        assert_eq!(g.question_id, 3);
        assert_eq!(g.score, 8.0);
        assert_eq!(g.gaps, vec!["缺口"]);
    }

    #[test]
    fn parse_grade_all_extracts_grades_and_report() {
        let raw = r#"{"grades":[{"question_id":2,"score":25,"feedback":"好","gaps":[]}],"report":"总评：不错"}"#;
        let (grades, report) = parse_grade_all(raw).unwrap();
        assert_eq!(grades.len(), 1);
        // 分数截断到满分
        assert_eq!(grades[0].score, QUESTION_MAX_SCORE);
        assert!(report.contains("总评"));
    }

    #[test]
    fn compute_score_percentage() {
        let grading = vec![
            QuestionGrade {
                question_id: 1,
                correct: Some(true),
                score: 10.0,
                max_score: 10.0,
                feedback: String::new(),
                gaps: vec![],
            },
            QuestionGrade {
                question_id: 2,
                correct: None,
                score: 5.0,
                max_score: 10.0,
                feedback: String::new(),
                gaps: vec![],
            },
        ];
        assert_eq!(compute_score(&grading), Some(75.0));
        assert_eq!(compute_score(&[]), None);
    }
}
