import { invoke } from "@tauri-apps/api/core";

export interface ApiKeys {
  mineru: string;
  openai: string;
  anthropic: string;
  gemini: string;
  deepseek: string;
}

export interface Settings {
  api_keys: ApiKeys;
  paper_library_path: string | null;
  embedding_model: string;
  llm_provider: string;
  llm_model: string;
  /** 联网搜索 provider：none / auto / deepseek / anthropic（复用对应 API Key） */
  web_search_provider: string;
  /** 原生搜索用模型名；null = 用 provider 默认 */
  web_search_model: string | null;
}

export interface Paper {
  id: string;
  title: string;
  authors: string | null;
  abstract: string | null;
  pdf_path: string;
  md_path: string;
  blog_md_path: string | null;
  created_at: number;
  last_read_at: number | null;
  reading_status: string;
  /** unparsed / parsing / ready / failed */
  parse_status: string;
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
}

/** agent 深度模式的一步工具调用轨迹（前端展示用） */
export interface ToolStep {
  name: string;
  args: unknown;
  summary: string;
  error?: string | null;
}

export interface Answer {
  conversation_id: string;
  answer: string;
  citations: Citation[];
  /** agent 深度模式的工具调用轨迹；快速模式为空数组 */
  trace: ToolStep[];
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
}

export const getSettings = () => invoke<Settings>("get_settings");
export const generateBlog = (paperId: string) =>
  invoke<string>("generate_blog", { paperId });
export const updateSettings = (newSettings: Settings) =>
  invoke<Settings>("update_settings", { newSettings });

export const listPapers = () => invoke<Paper[]>("list_papers");
export const getPaper = (paperId: string) => invoke<Paper>("get_paper", { paperId });
export const getPaperMd = (paperId: string) => invoke<string>("get_paper_md", { paperId });
export const importPdf = (sourcePath: string) =>
  invoke<Paper>("import_pdf", { sourcePath });
export const parsePdf = (paperId: string) => invoke<Paper>("parse_pdf", { paperId });
export const deletePaper = (paperId: string) => invoke<void>("delete_paper", { paperId });

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

export const indexPaper = (paperId: string) => invoke<number>("index_paper", { paperId });

export const search = (query: string, topK: number, paperId?: string | null) =>
  invoke<SearchHit[]>("search", { query, topK, paperId: paperId ?? null });

export const askQuestion = (
  question: string,
  opts?: {
    paperId?: string | null;
    conversationId?: string | null;
    topK?: number;
    /** 阅读页选中的段落列表（就地提问的上下文引用，可多条，编号 [1..k] 注入） */
    selections?: { text: string; pageIdx: number }[] | null;
    /** 问答模式：quick = 单轮 RAG；agent = 深度研究（多步工具循环，默认） */
    mode?: "quick" | "agent";
  },
) =>
  invoke<Answer>("ask_question", {
    question,
    paperId: opts?.paperId ?? null,
    conversationId: opts?.conversationId ?? null,
    topK: opts?.topK,
    selections: opts?.selections ?? null,
    mode: opts?.mode ?? "agent",
  });

export const listConversations = () =>
  invoke<Conversation[]>("list_conversations");

export const getConversation = (conversationId: string) =>
  invoke<Conversation>("get_conversation", { conversationId });

export const feynmanStart = (paperId: string) =>
  invoke<FeynmanTurn>("feynman_start", { paperId });

export const feynmanConfirmPlan = (conversationId: string, plan: PlanItem[]) =>
  invoke<FeynmanTurn>("feynman_confirm_plan", { conversationId, plan });

export const feynmanTurn = (
  message: string,
  paperId: string,
  conversationId?: string | null,
) =>
  invoke<FeynmanTurn>("feynman_turn", {
    message,
    paperId,
    conversationId: conversationId ?? null,
  });

/** 对当前概念出测验题（状态置为 quiz） */
export const feynmanQuiz = (conversationId: string) =>
  invoke<FeynmanTurn>("feynman_quiz", { conversationId });

/** 交卷判定：收集出题之后的作答，判定 通过/需补讲 */
export const feynmanJudge = (conversationId: string) =>
  invoke<FeynmanTurn>("feynman_judge", { conversationId });

/** 进入下一概念 */
export const feynmanNext = (conversationId: string) =>
  invoke<FeynmanTurn>("feynman_next", { conversationId });

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

/** 读取论文的阅读标注（annotations.json），无标注返回 null */
export const getAnnotations = (paperId: string) =>
  invoke<string | null>("get_annotations", { paperId });

/** 把阅读标注 JSON 落盘为论文目录下的 annotations.json */
export const saveAnnotations = (paperId: string, data: string) =>
  invoke<void>("save_annotations", { paperId, data });
