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

export const getSettings = () => invoke<Settings>("get_settings");
export const updateSettings = (newSettings: Settings) =>
  invoke<Settings>("update_settings", { newSettings });

export const listPapers = () => invoke<Paper[]>("list_papers");
export const getPaper = (paperId: string) => invoke<Paper>("get_paper", { paperId });
export const getPaperMd = (paperId: string) => invoke<string>("get_paper_md", { paperId });
export const importPdf = (sourcePath: string) =>
  invoke<Paper>("import_pdf", { sourcePath });
export const parsePdf = (paperId: string) => invoke<Paper>("parse_pdf", { paperId });
