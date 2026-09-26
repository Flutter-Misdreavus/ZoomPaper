import { Channel, invoke } from "@tauri-apps/api/core";

export interface ApiKeys {
  mineru: string;
  openai: string;
  anthropic: string;
  gemini: string;
  deepseek: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  provider_type: string;
  api_key: string;
  base_url?: string | null;
  default_model: string;
  models: string[];
  enabled: boolean;
}

export interface Settings {
  providers: ProviderConfig[];
  active_provider_id: string;
  mineru_api_key: string;
  api_keys?: ApiKeys | null;
  paper_library_path: string | null;
  embedding_model: string;
  llm_provider?: string | null;
  llm_model?: string | null;
  /** 联网搜索 provider：none / auto / deepseek / anthropic（复用对应 API Key） */
  web_search_provider: string;
  /** 原生搜索用模型名；null = 用 provider 默认 */
  web_search_model: string | null;
}

export interface Paper {
  id: string;
  title: string;
  title_zh: string | null;
  authors: string | null;
  abstract: string | null;
  abstract_zh: string | null;
  pdf_path: string;
  md_path: string;
  blog_md_path: string | null;
  created_at: number;
  last_read_at: number | null;
  reading_status: string;
  /** unparsed / parsing / ready / failed */
  parse_status: string;
  /** 星标 */
  starred: boolean;
  /** 最近一次标记已读时间（epoch 秒）；null = 未读完/已取消 */
  finished_at: number | null;
  /** 浏览器导入时的论文来源页 */
  source_url: string | null;
  /** 论文关联的 GitHub 仓库 */
  github_url: string | null;
  /** 发表期刊或会议 */
  venue: string | null;
  /** 删除时间；非空表示位于回收站 */
  deleted_at: number | null;
  /** 来源网站图标 */
  source_icon_url: string | null;
  /** 累计阅读时长（秒），由阅读会话聚合 */
  total_read_seconds: number;
  /** 所属文件夹 id 列表（多归属；空数组 = 未分类） */
  folder_ids: string[];
}

/** 虚拟文件夹（多归属集合式整理容器；不对应磁盘目录） */
export interface Folder {
  id: string;
  name: string;
  /** 父文件夹 id；null = 顶级 */
  parent_id: string | null;
  /** 色板 key（见 folderColors） */
  color: string;
  /** 自由文本标签列表 */
  tags: string[];
  created_at: number;
}

export interface SearchHit {
  chunk_id: number;
  paper_id: string;
  paper_title: string;
  section: string;
  content: string;
  /** 0-based */
  page_idx: number | null;
  /** 向量距离，越小越相关 */
  distance: number;
}

export interface Citation {
  /** 对应回答正文中的 [n]，从 1 开始 */
  index: number;
  chunk_id: number;
  paper_id: string;
  paper_title: string;
  section: string;
  page_idx: number | null;
  snippet: string;
}

export interface QaMessage {
  role: "user" | "assistant";
  content: string;
  /** 仅 assistant 消息携带 */
  citations?: Citation[] | null;
  /** agent 深度模式的工具调用轨迹（仅 assistant 消息携带；旧数据为 null） */
  trace?: ToolStep[] | null;
  /** AI 耗时记录（仅 assistant 消息携带；旧数据为 null） */
  timing?: Timing | null;
  selections?: { text: string; pageIdx: number | null; location?: string }[] | null;
}

/** agent 深度模式的一步工具调用轨迹（前端展示用） */
export interface ToolStep {
  name: string;
  args: unknown;
  summary: string;
  error?: string | null;
}

/** 实时事件流（Tauri Channel 载荷）：思考/正文增量 + 工具状态 */
export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "content"; text: string }
  | { type: "tool_start"; name: string; args: unknown }
  | {
      type: "tool_end";
      name: string;
      summary: string;
      error?: string | null;
      elapsed_ms: number;
    };

/** AI 耗时记录：model_ms = 模型调用合计（思考+决策+生成）；tool_ms = 工具执行合计 */
export interface Timing {
  model_ms: number;
  tool_ms: number;
}

/** AI 的澄清请求（模型调用 ask_user 工具中断循环后返回） */
export interface PendingAsk {
  question: string;
  options?: string[] | null;
  free_text: boolean;
}

export interface Answer {
  conversation_id: string;
  answer: string;
  citations: Citation[];
  /** agent 深度模式的工具调用轨迹；快速模式为空数组 */
  trace: ToolStep[];
  /** AI 耗时记录（快速模式为零值） */
  timing: Timing;
  /** 模型请求澄清（answer 为空时携带）；无澄清为 null/缺省 */
  pending?: PendingAsk | null;
  /** 用户点击「暂停」：answer 为已生成的部分内容（可能为空） */
  cancelled?: boolean;
}

export interface Conversation {
  id: string;
  paper_id: string | null;
  type: string;
  title: string;
  /** JSON 字符串，parse 后为 QaMessage[] */
  messages: string;
  created_at: number;
  updated_at: number;
  /** 遗留：旧版费曼要点笔记，已弃用 */
  notes?: string | null;
  /** 费曼会话滚动「教学进展」摘要（长对话控 token；qa 会话为 null） */
  summary?: string | null;
  /** 费曼闯关状态 JSON（概念计划 / 当前关卡 / 各概念状态）；null = 旧版自由聊天会话 */
  feynman_state?: string | null;
  /** 费曼「概念级独立会话」标记：null = 主行（或 qa / 旧版单会话）；N = 概念 N 的会话行 */
  concept_index?: number | null;
}

export interface FeynmanMessage {
  role: "user" | "assistant";
  content: string;
  /** 学生研读论文的工具调用轨迹（仅 assistant 消息携带；旧数据为 null） */
  trace?: ToolStep[] | null;
  /** 学生研读耗时（仅 assistant 消息携带；旧数据为 null） */
  timing?: Timing | null;
}

/** 教学计划中的一项（一个概念 + 教学目标） */
export interface PlanItem {
  name: string;
  objective: string;
}

export type ConceptStatus = "pending" | "teaching" | "quiz" | "passed" | "weak";

export type StageStatus = "planning" | "teaching" | "quiz" | "done";

/** 单个概念的状态记录 */
export interface ConceptState {
  name: string;
  status: ConceptStatus;
  /** 上次测验未通过时记录的缺口描述 */
  weak_points: string[];
  quiz_attempts: number;
  /** 通过测验的时间戳（unix 秒） */
  taught_at: number | null;
  /** 该概念独立会话行的 conversation id（概念级会话机制；旧结构为 null） */
  session_id?: string | null;
  /** 概念完成摘要（测验通过后生成，供后续概念参考；未通过为 null） */
  summary?: string | null;
}

/** 会话级闯关状态（持久化于 conversations.feynman_state JSON） */
export interface FeynmanState {
  plan: PlanItem[];
  current_index: number;
  status: StageStatus;
  concepts: ConceptState[];
}

export interface FeynmanTurn {
  conversation_id: string;
  reply: string;
  /** 闯关状态；旧会话为 null */
  state?: FeynmanState | null;
  /** 概念级会话机制下，新建/激活的概念会话行 id（教学轮为 null） */
  concept_session_id?: string | null;
  /** 本轮学生思考内容（非流式返回；仅实时展示，不持久化） */
  thinking?: string | null;
  /** 本轮工具调用轨迹（与消息持久化的 trace 一致） */
  trace?: ToolStep[];
  /** 本轮研读耗时 */
  timing?: Timing;
  /** 用户点击「暂停」：reply 为已生成的部分内容（可能为空） */
  cancelled?: boolean;
}

export const getSettings = () => invoke<Settings>("get_settings");

/** 判断联网搜索是否已配置可用：provider 非 none 且对应 API Key 非空（auto 时任一 Key） */
export function isWebSearchConfigured(s: Settings): boolean {
  const p = (s.web_search_provider ?? "").toLowerCase();
  const has = (id: string) => s.providers.some((provider) => provider.id === id && provider.enabled && !!provider.api_key);
  if (p === "deepseek" || p === "anthropic") return has(p);
  return p === "auto" && (has("deepseek") || has("anthropic"));
}
export const generateBlog = (paperId: string) =>
  invoke<string>("generate_blog", { paperId });
export const updateSettings = (newSettings: Settings) =>
  invoke<Settings>("update_settings", { newSettings });

export const listPapers = () => invoke<Paper[]>("list_papers");
export const getPaper = (paperId: string) => invoke<Paper>("get_paper", { paperId });
export const getPaperMd = (paperId: string) => invoke<string>("get_paper_md", { paperId });
export const importPdf = (sourcePath: string) =>
  invoke<Paper>("import_pdf", { sourcePath });
export const importPdfUrl = (
  url: string,
  suggestedTitle?: string | null,
  sourceUrl?: string | null,
  githubUrl?: string | null,
  venue?: string | null,
  sourceIconUrl?: string | null,
) => invoke<Paper>("import_pdf_url", {
  url,
  suggestedTitle: suggestedTitle ?? null,
  sourceUrl: sourceUrl ?? null,
  githubUrl: githubUrl ?? null,
  venue: venue ?? null,
  sourceIconUrl: sourceIconUrl ?? null,
});
export const importBrowserDownload = (
  sourcePath: string,
  suggestedTitle?: string | null,
  sourceUrl?: string | null,
  githubUrl?: string | null,
  venue?: string | null,
  sourceIconUrl?: string | null,
) => invoke<Paper>("import_browser_download", {
  sourcePath,
  suggestedTitle: suggestedTitle ?? null,
  sourceUrl: sourceUrl ?? null,
  githubUrl: githubUrl ?? null,
  venue: venue ?? null,
  sourceIconUrl: sourceIconUrl ?? null,
});
export interface ParseProgress {
  /** uploading / pending / converting / running / downloading / indexing */
  stage: string;
  /** 仅 stage=running 且 MinerU 返回了页数进度时有值 */
  extracted_pages: number | null;
  total_pages: number | null;
}

export const parsePdf = (
  paperId: string,
  onProgress?: (p: ParseProgress) => void,
) => {
  // 后端 Channel 参数必填，缺省时创建空通道
  const ch = new Channel<ParseProgress>();
  ch.onmessage = (p) => onProgress?.(p);
  return invoke<Paper>("parse_pdf", { paperId, onProgress: ch });
};

/** Translate and cache the paper title and abstract for the library preview. */
export const translatePaperMetadata = (paperId: string) =>
  invoke<Paper>("translate_paper_metadata", { paperId });

export const deletePaper = (paperId: string) => invoke<void>("delete_paper", { paperId });
export const restorePaper = (paperId: string) => invoke<void>("restore_paper", { paperId });
export const permanentlyDeletePaper = (paperId: string) => invoke<void>("permanently_delete_paper", { paperId });
export const emptyTrash = () => invoke<number>("empty_trash");
export const askAppHelp = (question: string) => invoke<string>("ask_app_help", { question });

// ---------- 论文整理（虚拟文件夹） ----------

export const listFolders = () => invoke<Folder[]>("list_folders");
export const createFolder = (
  name: string,
  opts?: { parentId?: string | null; color?: string; tags?: string[] },
) =>
  invoke<Folder>("create_folder", {
    name,
    parentId: opts?.parentId ?? null,
    color: opts?.color ?? null,
    tags: opts?.tags ?? null,
  });
export const updateFolder = (
  folderId: string,
  opts?: { name?: string | null; color?: string | null; tags?: string[] | null },
) =>
  invoke<Folder>("update_folder", {
    folderId,
    name: opts?.name ?? null,
    color: opts?.color ?? null,
    tags: opts?.tags ?? null,
  });
export const deleteFolder = (folderId: string) =>
  invoke<void>("delete_folder", { folderId });
export const addPapersToFolder = (paperIds: string[], folderId: string) =>
  invoke<number>("add_papers_to_folder", { paperIds, folderId });
export const removePapersFromFolder = (paperIds: string[], folderId: string) =>
  invoke<number>("remove_papers_from_folder", { paperIds, folderId });
export const renamePaper = (paperId: string, newTitle: string) =>
  invoke<Paper>("rename_paper", { paperId, newTitle });

// ---------- 阅读状态 / 星标（论文库工作台） ----------

export type ReadingStatus = "unread" | "reading" | "read";

/** 更新论文阅读状态，返回更新后的论文 */
export const setPaperStatus = (paperId: string, status: ReadingStatus) =>
  invoke<Paper>("set_paper_status", { paperId, status });

/** 设置论文星标，返回更新后的论文 */
export const setPaperStarred = (paperId: string, starred: boolean) =>
  invoke<Paper>("set_paper_starred", { paperId, starred });

// ---------- 阅读时间线 ----------

/** 阅读计划条目：指派清单中的一篇论文，带条目级截止日期 */
export interface ReadingPlanItem {
  paper_id: string;
  /** 条目级截止（epoch 秒）；null = 无日期 */
  due_date: number | null;
}

/** 阅读计划：daily = 每天读完 N 篇的持续性目标；papers = 指派论文清单（条目各自带截止日期） */
export interface ReadingPlan {
  id: string;
  type: "daily" | "papers";
  target_count: number | null;
  items: ReadingPlanItem[];
  /** 遗留：v10 及以前的计划级截止日期（新 papers 计划恒为 null） */
  deadline: number | null;
  created_at: number;
  active: boolean;
}

/** 时间线某天的论文明细条目 */
export interface TimelineDayPaper {
  paper_id: string;
  title: string;
  seconds: number;
  reading_status: string;
}

/** 时间线一天的记录（无记录的天不返回） */
export interface TimelineDay {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  /** 当天阅读总时长（秒） */
  seconds: number;
  /** 当天读过的论文数 */
  paper_count: number;
  /** 当天标记已读的篇数 */
  finished_count: number;
  papers: TimelineDayPaper[];
}

export interface TimelineStats {
  days: TimelineDay[];
  /** 连续有阅读记录的天数（今天未读则从前一天起算） */
  streak: number;
}

/** 上报一段阅读时长（秒）；同时刷新 last_read_at */
export const addReadingTime = (paperId: string, seconds: number) =>
  invoke<void>("add_reading_time", { paperId, seconds });

/** 标记/取消「已读」（同步维护 finished_at），返回更新后的论文 */
export const markPaperRead = (paperId: string, read: boolean) =>
  invoke<Paper>("mark_paper_read", { paperId, read });

export const createReadingPlan = (
  type: "daily" | "papers",
  opts?: { targetCount?: number; paperIds?: string[]; deadline?: number },
) =>
  invoke<ReadingPlan>("create_reading_plan", {
    planType: type,
    targetCount: opts?.targetCount ?? null,
    paperIds: opts?.paperIds ?? null,
    deadline: opts?.deadline ?? null,
  });

export const listReadingPlans = () =>
  invoke<ReadingPlan[]>("list_reading_plans");

/** 仅更新传入的字段 */
export const updateReadingPlan = (
  planId: string,
  opts: {
    targetCount?: number;
    paperIds?: string[];
    deadline?: number;
    active?: boolean;
  },
) =>
  invoke<ReadingPlan>("update_reading_plan", {
    planId,
    targetCount: opts.targetCount ?? null,
    paperIds: opts.paperIds ?? null,
    deadline: opts.deadline ?? null,
    active: opts.active ?? null,
  });

export const deleteReadingPlan = (planId: string) =>
  invoke<void>("delete_reading_plan", { planId });

/** 把论文加入指派计划（已存在则更新其 due），返回更新后的计划 */
export const addPaperToPlan = (
  planId: string,
  paperId: string,
  dueDate?: number | null,
) => invoke<ReadingPlan>("add_paper_to_plan", { planId, paperId, dueDate: dueDate ?? null });

/** 从指派计划移除论文，返回更新后的计划 */
export const removePaperFromPlan = (planId: string, paperId: string) =>
  invoke<ReadingPlan>("remove_paper_from_plan", { planId, paperId });

/** 设置/清除计划条目的截止日期（null = 无日期），返回更新后的计划 */
export const setPlanItemDue = (
  planId: string,
  paperId: string,
  dueDate: number | null,
) => invoke<ReadingPlan>("set_plan_item_due", { planId, paperId, dueDate });

/** 最近 N 天的阅读统计 + 当前连续天数 */
export const timelineStats = (days: number) =>
  invoke<TimelineStats>("timeline_stats", { days });

export const indexPaper = (paperId: string) => invoke<number>("index_paper", { paperId });

export const search = (query: string, topK: number, paperId?: string | null) =>
  invoke<SearchHit[]>("search", { query, topK, paperId: paperId ?? null });

export const askQuestion = (
  question: string,
  opts?: {
    paperId?: string | null;
    conversationId?: string | null;
    topK?: number;
    /** 阅读页选中的段落列表（就地提问的上下文引用，可多条，编号 [1..k] 注入；
     * pageIdx 为 0-based 页码（博客/译文划选为 null）；location 为人类可读来源位置，
     * 如「博客·洞见」「译文·第 5 段」，PDF 选中不传） */
    selections?: { text: string; pageIdx: number | null; location?: string }[] | null;
    /** 问答模式：quick = 单轮 RAG；agent = 深度研究（多步工具循环，默认） */
    mode?: "quick" | "agent";
    /** 联网搜索开关（缺省开） */
    webSearch?: boolean;
    /** 本次发送生成的取消令牌：「暂停」按钮据此中止生成 */
    cancelToken?: string | null;
    /** 实时事件流（思考/正文/工具状态） */
    onEvent?: Channel<AgentEvent>;
  },
) =>
  invoke<Answer>("ask_question", {
    question,
    paperId: opts?.paperId ?? null,
    conversationId: opts?.conversationId ?? null,
    topK: opts?.topK,
    selections: opts?.selections ?? null,
    mode: opts?.mode ?? "agent",
    webSearch: opts?.webSearch ?? true,
    cancelToken: opts?.cancelToken ?? null,
    // 后端 Channel 参数必填（null 会导致参数反序列化失败），缺省时创建空通道
    onEvent: opts?.onEvent ?? new Channel<AgentEvent>(),
  });

/** 回答 AI 的澄清问题：续跑被 ask_user 中断的深度研究 */
export const askQuestionReply = (
  conversationId: string,
  reply: string,
  webSearch?: boolean,
  cancelToken?: string | null,
  onEvent?: Channel<AgentEvent>,
) =>
  invoke<Answer>("ask_question_reply", {
    conversationId,
    reply,
    webSearch: webSearch ?? true,
    cancelToken: cancelToken ?? null,
    onEvent: onEvent ?? new Channel<AgentEvent>(),
  });

/** 「暂停」：中止指定 cancelToken 对应的生成（幂等） */
export const cancelGeneration = (cancelToken: string) =>
  invoke<void>("cancel_generation", { cancelToken });

export const listConversations = () =>
  invoke<Conversation[]>("list_conversations");

export const getConversation = (conversationId: string) =>
  invoke<Conversation>("get_conversation", { conversationId });

/** 删除单个问答会话（含其全部消息） */
export const deleteConversation = (conversationId: string) =>
  invoke<void>("delete_conversation", { conversationId });

export const feynmanStart = (paperId: string) =>
  invoke<FeynmanTurn>("feynman_start", { paperId });

export const feynmanConfirmPlan = (
  conversationId: string,
  plan: PlanItem[],
  webSearch?: boolean,
  cancelToken?: string | null,
  onEvent?: Channel<AgentEvent>,
) =>
  invoke<FeynmanTurn>("feynman_confirm_plan", {
    conversationId,
    plan,
    webSearch: webSearch ?? true,
    cancelToken: cancelToken ?? null,
    onEvent: onEvent ?? new Channel<AgentEvent>(),
  });

export const feynmanTurn = (
  message: string,
  paperId: string,
  conversationId?: string | null,
  webSearch?: boolean,
  cancelToken?: string | null,
  onEvent?: Channel<AgentEvent>,
) =>
  invoke<FeynmanTurn>("feynman_turn", {
    message,
    paperId,
    conversationId: conversationId ?? null,
    webSearch: webSearch ?? true,
    cancelToken: cancelToken ?? null,
    onEvent: onEvent ?? new Channel<AgentEvent>(),
  });

/** 对当前概念出测验题（状态置为 quiz） */
export const feynmanQuiz = (
  conversationId: string,
  webSearch?: boolean,
  cancelToken?: string | null,
  onEvent?: Channel<AgentEvent>,
) =>
  invoke<FeynmanTurn>("feynman_quiz", {
    conversationId,
    webSearch: webSearch ?? true,
    cancelToken: cancelToken ?? null,
    onEvent: onEvent ?? new Channel<AgentEvent>(),
  });

/** 交卷判定：收集出题之后的作答，判定 通过/需补讲 */
export const feynmanJudge = (
  conversationId: string,
  webSearch?: boolean,
  cancelToken?: string | null,
  onEvent?: Channel<AgentEvent>,
) =>
  invoke<FeynmanTurn>("feynman_judge", {
    conversationId,
    webSearch: webSearch ?? true,
    cancelToken: cancelToken ?? null,
    onEvent: onEvent ?? new Channel<AgentEvent>(),
  });

/** 进入下一概念 */
export const feynmanNext = (
  conversationId: string,
  webSearch?: boolean,
  cancelToken?: string | null,
  onEvent?: Channel<AgentEvent>,
) =>
  invoke<FeynmanTurn>("feynman_next", {
    conversationId,
    webSearch: webSearch ?? true,
    cancelToken: cancelToken ?? null,
    onEvent: onEvent ?? new Channel<AgentEvent>(),
  });

export const feynmanReview = (conversationId: string) =>
  invoke<string>("feynman_review", { conversationId });

export const getFeynmanConversation = (paperId: string) =>
  invoke<Conversation | null>("get_feynman_conversation", { paperId });

/** AI 翻译：一个分块对（en 为原文块，zh 为对应中文块） */
export interface TranslationChunk {
  en: string;
  zh: string;
}

/** 读取论文的翻译缓存（translation.json），无缓存返回 null */
export const getTranslation = (paperId: string) =>
  invoke<TranslationChunk[] | null>("get_translation", { paperId });

/** 翻译单个英文块为中文 */
export const translateChunk = (text: string) =>
  invoke<string>("translate_chunk", { text });

/** 把分块对落盘为论文目录下的 translation.json */
export const saveTranslation = (paperId: string, chunks: TranslationChunk[]) =>
  invoke<void>("save_translation", { paperId, chunks });

// ---------- 阅读标注（高亮 / 笔记） ----------

/** 高亮矩形，坐标为相对页面宽高的归一化值（0..1），随缩放自动缩放 */
export interface AnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一条高亮标注；note 为空表示纯高亮 */
export interface PdfAnnotation {
  id: string;
  /** 0-based 页码 */
  page_idx: number;
  rects: AnnotationRect[];
  /** CSS 颜色（rgba 字符串） */
  color: string;
  /** 选中时的原文文本 */
  text: string;
  note: { text: string; updated_at: number } | null;
  created_at: number;
}

export interface AnnotationsFile {
  version: number;
  highlights: PdfAnnotation[];
}

/** 读取论文的阅读标注（annotations.json / blog_annotations.json / translation_annotations.json，
 * 由 kind 指定：缺省 = PDF 原文标注），无标注返回 null */
export const getAnnotations = (paperId: string, kind?: string) =>
  invoke<string | null>("get_annotations", { paperId, kind: kind ?? null });

/** 把阅读标注 JSON 落盘为论文目录对应文件（kind 同上） */
const annotationWrites = new Map<string, Promise<void>>();
export const saveAnnotations = (paperId: string, data: string, kind?: string) => {
  const key = `${paperId}:${kind ?? "annotations"}`;
  const previous = annotationWrites.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => invoke<void>("save_annotations", { paperId, data, kind: kind ?? null }));
  annotationWrites.set(key, next);
  void next.finally(() => { if (annotationWrites.get(key) === next) annotationWrites.delete(key); }).catch(() => {});
  return next;
};

export const translateSelection = (text: string, context = "") =>
  invoke<string>("translate_selection", { text, context });

export const openPaperForReading = (paperId: string) => invoke<Paper>("open_paper", { paperId });

export const setReadingStatus = (paperIds: string[], status: string) => invoke<void>("set_reading_status", { paperIds, status });
export const exportNotes = (paperId: string, destination: string) => invoke<void>("export_notes", { paperId, destination });

export const keywordSearch = (query: string, paperId: string | null) => invoke<SearchHit[]>("keyword_search", { query, paperId });

export const addProvider = (config: ProviderConfig) =>
  invoke<Settings>("add_provider", { config });

export const updateProvider = (id: string, config: ProviderConfig) =>
  invoke<Settings>("update_provider", { id, config });

export const deleteProvider = (id: string) =>
  invoke<Settings>("delete_provider", { id });

export const setActiveProvider = (id: string) =>
  invoke<Settings>("set_active_provider", { id });


export interface QuizConfig {
  /** 选择题数量（0-10） */
  choice_count: number;
  /** 主观题数量（0-5） */
  subjective_count: number;
  /** 难度：基础 / 进阶 / 挑战 */
  difficulty: string;
  /** 侧重点：全面 / 方法 / 实验 / 结论 */
  focus: string;
  /** 出题章节（原样章节名）；空数组 = 全文 */
  sections: string[];
}

export type QuizQuestionType = "choice" | "subjective";

/** 一道测验题（含答案与解析） */
export interface QuizQuestion {
  id: number;
  qtype: QuizQuestionType;
  question: string;
  /** 选择题选项（不含字母前缀）；主观题为 null/缺省 */
  options?: string[] | null;
  /** 选择题：正确选项字母（"A"）；主观题：参考答案 */
  answer: string;
  /** 选择题：解析；主观题：评分要点 */
  explanation: string;
  /** 出处章节名（可能为空串） */
  section: string;
}

/** 用户对一道题的作答 */
export interface UserAnswer {
  question_id: number;
  /** 选择题：选项字母；主观题：自由文本 */
  answer: string;
}

/** 一道题的批改结果 */
export interface QuestionGrade {
  question_id: number;
  /** 选择题：本地判定的对错；主观题缺省 */
  correct?: boolean | null;
  score: number;
  max_score: number;
  feedback: string;
  /** 未掌握的具体知识点 */
  gaps: string[];
}

/** 完整测验记录 */
export interface Quiz {
  id: string;
  paper_id: string;
  /** exam / practice */
  mode: string;
  config: QuizConfig;
  questions: QuizQuestion[];
  answers: UserAnswer[];
  grading: QuestionGrade[];
  report?: string | null;
  /** 总得分（百分制），批改完成后有值 */
  score?: number | null;
  /** answering / done */
  status: string;
  created_at: number;
  updated_at: number;
}

/** 历史列表条目（不含题目与批改详情） */
export interface QuizSummary {
  id: string;
  mode: string;
  difficulty: string;
  focus: string;
  question_count: number;
  score?: number | null;
  status: string;
  created_at: number;
  updated_at: number;
}

/** 论文的章节列表（出题配置的章节多选数据源） */
export const quizSections = (paperId: string) =>
  invoke<string[]>("quiz_sections", { paperId });

/** 出题：mode 为 "exam" / "practice"；返回新建的测验（status=answering） */
export const quizGenerate = (paperId: string, mode: string, config: QuizConfig) =>
  invoke<Quiz>("quiz_generate", { paperId, mode, config });

/** 练习模式：提交一道题的作答并即时批改，返回该题批改结果 */
export const quizSubmitAnswer = (quizId: string, questionId: number, answer: string) =>
  invoke<QuestionGrade>("quiz_submit_answer", { quizId, questionId, answer });

/** 考试模式：整卷交卷，返回批改完成的完整测验（含总评报告与总分） */
export const quizGradeAll = (quizId: string, answers: UserAnswer[]) =>
  invoke<Quiz>("quiz_grade_all", { quizId, answers });

/** 某篇论文的测验历史列表（新的在前） */
export const quizList = (paperId: string) =>
  invoke<QuizSummary[]>("quiz_list", { paperId });

/** 取一份测验的完整内容 */
export const quizGet = (quizId: string) => invoke<Quiz>("quiz_get", { quizId });

/** 删除一份测验记录 */
export const quizDelete = (quizId: string) =>
  invoke<void>("quiz_delete", { quizId });

export const reindexAllPapers = () => invoke<[number, number]>("reindex_all_papers");
