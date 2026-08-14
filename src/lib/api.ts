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
