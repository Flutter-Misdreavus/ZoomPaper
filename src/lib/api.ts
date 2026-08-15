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
}

export interface Answer {
  conversation_id: string;
  answer: string;
  citations: Citation[];
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
}

export interface FeynmanMessage {
  role: "user" | "assistant";
  content: string;
}

export interface FeynmanTurn {
  conversation_id: string;
  reply: string;
}

export type BlogLevel = "popular" | "intro" | "expert";

export const getSettings = () => invoke<Settings>("get_settings");
export const updateSettings = (newSettings: Settings) =>
  invoke<Settings>("update_settings", { newSettings });

export const listPapers = () => invoke<Paper[]>("list_papers");
export const getPaper = (paperId: string) => invoke<Paper>("get_paper", { paperId });
export const getPaperMd = (paperId: string) => invoke<string>("get_paper_md", { paperId });
export const importPdf = (sourcePath: string) =>
  invoke<Paper>("import_pdf", { sourcePath });
export const parsePdf = (paperId: string) => invoke<Paper>("parse_pdf", { paperId });
export const deletePaper = (paperId: string) => invoke<void>("delete_paper", { paperId });

export const indexPaper = (paperId: string) => invoke<number>("index_paper", { paperId });

export const search = (query: string, topK: number, paperId?: string | null) =>
  invoke<SearchHit[]>("search", { query, topK, paperId: paperId ?? null });

export const generateBlog = (paperId: string, level: BlogLevel) =>
  invoke<string>("generate_blog", { paperId, level });

export const askQuestion = (
  question: string,
  opts?: { paperId?: string | null; conversationId?: string | null; topK?: number },
) =>
  invoke<Answer>("ask_question", {
    question,
    paperId: opts?.paperId ?? null,
    conversationId: opts?.conversationId ?? null,
    topK: opts?.topK,
  });

export const listConversations = () =>
  invoke<Conversation[]>("list_conversations");

export const getConversation = (conversationId: string) =>
  invoke<Conversation>("get_conversation", { conversationId });

export const feynmanStart = (paperId: string) =>
  invoke<FeynmanTurn>("feynman_start", { paperId });

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
