import { useMemo, useState } from "react";
import {
  ArrowUp, BookCheck, BookOpen, Bot, Brain, CalendarDays, CircleDot,
  ClipboardCheck, Database, Download, ExternalLink, FileText, FolderPlus, Globe2,
  HelpCircle, Highlighter, History, KeyRound, Languages, LayoutGrid, Library,
  ListChecks, ListPlus, Loader2, MessageSquare, MonitorDown, Newspaper, Pencil, RefreshCw,
  Search, Settings2, SlidersHorizontal, Sparkles, Square, Star, StickyNote,
  TableOfContents, Trash2, Upload, ZoomIn, type LucideIcon,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { askAppHelp } from "@/lib/api";
import { cn } from "@/lib/utils";

interface GuideItem {
  id: string;
  title: string;
  summary: string;
  icon: LucideIcon;
  steps: string[];
}

interface GuideSection {
  id: string;
  title: string;
  icon: LucideIcon;
  items: GuideItem[];
}

const guideSections: GuideSection[] = [
  {
    id: "library", title: "论文库", icon: Library,
    items: [
      { id: "import", title: "导入论文", icon: Upload, summary: "从本机加入一个或多个 PDF。", steps: ["点击论文库右上角的上传图标。", "选择一个或多个 PDF。", "导入后等待解析完成。"] },
      { id: "open", title: "打开论文", icon: BookOpen, summary: "进入论文阅读工作区。", steps: ["双击论文行或卡片。", "也可以右键论文，选择打开。"] },
      { id: "star", title: "收藏", icon: Star, summary: "把常用论文集中到左侧收藏。", steps: ["选中一篇论文。", "点击右侧信息栏中的星标图标。", "再次点击可取消收藏。"] },
      { id: "folder", title: "添加到文件夹", icon: FolderPlus, summary: "一篇论文可以属于多个文件夹。", steps: ["右键论文，或长按论文进入多选。", "点击文件夹图标。", "勾选目标文件夹。", "点击“完成”应用更改。"] },
      { id: "status", title: "阅读状态", icon: CircleDot, summary: "标记未读、在读或已读。", steps: ["右键论文，或在多选工具栏点击状态图标。", "选择未读、在读或已读。", "可用论文库顶部筛选器查看对应状态。"] },
      { id: "plan", title: "加入阅读计划", icon: ListPlus, summary: "为论文安排阅读日期。", steps: ["右键论文并打开阅读计划菜单。", "选择计划或新建计划。", "选择今天、明天或自定义日期。"] },
      { id: "multi", title: "快速多选", icon: ListChecks, summary: "批量整理多篇论文。", steps: ["长按任意论文，保持按住并向上或向下滑动，即可连续选择。", "也可以进入多选后按住复选框拖动。", "执行操作后自动退出；点击空白处或按 Esc 也可退出。"] },
      { id: "rename", title: "重命名", icon: Pencil, summary: "修改论文在库中的标题。", steps: ["右键论文。", "点击重命名。", "输入标题并确认。"] },
      { id: "notes", title: "导出笔记", icon: Download, summary: "导出论文的高亮和批注。", steps: ["右键论文或选中多篇论文。", "点击下载图标。", "选择保存位置。"] },
      { id: "delete", title: "删除与恢复", icon: Trash2, summary: "删除的论文先进入回收站。", steps: ["右键论文并点击删除。", "在左侧打开回收站可恢复或永久删除。", "点击回收站顶部按钮可清空回收站。"] },
      { id: "organize", title: "搜索、筛选与布局", icon: SlidersHorizontal, summary: "快速缩小列表范围并调整视图。", steps: ["在顶部搜索标题、作者、摘要或期刊会议。", "用状态筛选器和排序菜单调整结果。", "点击列表或网格图标切换布局。"] },
      { id: "folders", title: "管理文件夹", icon: LayoutGrid, summary: "创建分层文件夹并设置颜色。", steps: ["点击侧栏底部加号，或右键“全部论文”“收藏”。", "输入名称并选择颜色。", "右键已有文件夹可新建子文件夹、重命名或删除。"] },
    ],
  },
  {
    id: "reader", title: "论文阅读", icon: BookOpen,
    items: [
      { id: "pdf", title: "PDF 阅读", icon: FileText, summary: "阅读原始 PDF 并记录进度。", steps: ["从论文库打开论文。", "使用滚轮阅读，阅读时长和最后位置会自动记录。"] },
      { id: "toc", title: "目录与跳页", icon: TableOfContents, summary: "按章节或页码定位内容。", steps: ["点击阅读器中的目录图标。", "选择章节，或输入页码跳转。"] },
      { id: "zoom", title: "缩放页面", icon: ZoomIn, summary: "调整 PDF 显示大小。", steps: ["点击阅读器的缩放按钮。", "选择放大、缩小或适合页面。"] },
      { id: "highlight", title: "高亮", icon: Highlighter, summary: "保存重要原文。", steps: ["在 PDF、译文或博客中选中文字。", "点击高亮图标。", "可在笔记列表中跳回原位置。"] },
      { id: "annotation", title: "批注", icon: StickyNote, summary: "为选中的内容补充笔记。", steps: ["选中文字。", "点击批注图标并输入内容。", "在笔记列表查看、定位或删除。"] },
      { id: "selection-translate", title: "划词翻译", icon: Languages, summary: "翻译单词、术语或短句。", steps: ["在正文中选中文字。", "点击翻译图标。", "译文会直接显示在选区旁。"] },
      { id: "selection-ask", title: "针对选文提问", icon: MessageSquare, summary: "把选中原文作为问题上下文。", steps: ["选中文字。", "点击提问图标。", "在右侧 AI 助手继续追问。"] },
      { id: "source", title: "论文与项目链接", icon: ExternalLink, summary: "打开论文来源页或关联 GitHub 项目。", steps: ["打开论文阅读页。", "点击右上角的外部链接或 GitHub 图标。", "链接会在浏览器中打开。"] },
    ],
  },
  {
    id: "ai", title: "AI 助手", icon: Bot,
    items: [
      { id: "paper-qa", title: "单篇论文问答", icon: MessageSquare, summary: "围绕当前论文提问。", steps: ["打开论文右侧的 AI 助手。", "输入问题并发送。", "点击回答中的引用可回到原文位置。"] },
      { id: "quick", title: "快速模式", icon: Sparkles, summary: "适合定义、概括和直接问题。", steps: ["点击输入框下方的模式按钮。", "选择快速。", "输入问题并发送。"] },
      { id: "deep", title: "深度模式", icon: Brain, summary: "适合需要多步检索和分析的问题。", steps: ["点击模式按钮并选择深度。", "输入复杂问题。", "可展开查看检索与思考过程。"] },
      { id: "web", title: "联网检索", icon: Globe2, summary: "在论文之外补充最新资料。", steps: ["在 AI 输入框下方打开联网开关。", "发送问题。", "回答会区分论文引用与网页来源。"] },
      { id: "history", title: "会话历史", icon: History, summary: "恢复当前论文的历史对话。", steps: ["点击 AI 面板右上角的历史图标。", "选择一个会话继续。", "点击加号可开始新会话。"] },
      { id: "stop", title: "停止生成", icon: Square, summary: "中止当前回答。", steps: ["在回答生成时点击停止图标。", "已生成的内容会保留。"] },
      { id: "library-qa", title: "知识库问答", icon: Database, summary: "跨多篇论文检索并回答。", steps: ["点击左侧知识库问答图标。", "输入研究问题。", "点击引用可打开对应论文。"] },
    ],
  },
  {
    id: "study", title: "翻译与学习", icon: BookCheck,
    items: [
      { id: "full-translate", title: "AI 全文翻译", icon: Languages, summary: "生成中文译文并支持对照阅读。", steps: ["打开论文并切换到“AI 翻译”。", "点击开始翻译。", "完成后切换中文或中英对照视图。"] },
      { id: "blog", title: "AI 博客", icon: Newspaper, summary: "把论文整理为更易读的讲解。", steps: ["打开论文并切换到博客。", "点击生成博客。", "生成期间可以切换论文，返回后继续查看进度。"] },
      { id: "feynman", title: "费曼学习", icon: Brain, summary: "按概念讲解、追问和复盘。", steps: ["打开论文并进入费曼学习。", "生成并确认概念计划。", "逐个概念讲给 AI 学生，回答追问并完成测验。"] },
      { id: "quiz", title: "论文测验", icon: ClipboardCheck, summary: "用题目检查对论文的理解。", steps: ["打开论文并切换到测验。", "点击新建测验。", "作答并提交，查看答案与解析。"] },
    ],
  },
  {
    id: "discover", title: "检索与计划", icon: Search,
    items: [
      { id: "keyword-search", title: "关键词搜索", icon: Search, summary: "按文字匹配检索论文内容。", steps: ["打开左侧搜索页面。", "选择关键词。", "输入词语并按回车。"] },
      { id: "semantic-search", title: "语义搜索", icon: Sparkles, summary: "按含义查找相关段落。", steps: ["打开搜索页面并选择语义。", "输入研究概念或问题。", "点击结果回到论文原文。"] },
      { id: "timeline", title: "阅读时间线", icon: CalendarDays, summary: "查看阅读活动和每日进度。", steps: ["点击左侧日历图标。", "查看阅读热力图和当天记录。", "点击日期查看对应活动。"] },
      { id: "reading-plan", title: "阅读计划", icon: ListPlus, summary: "建立计划并安排论文。", steps: ["在时间线页面新建阅读计划。", "从论文右键菜单把论文加入计划。", "设置日期后按计划阅读。"] },
    ],
  },
  {
    id: "system", title: "设置与扩展", icon: Settings2,
    items: [
      { id: "model", title: "配置 AI", icon: KeyRound, summary: "连接翻译、问答和生成功能所需的模型。", steps: ["打开设置。", "选择服务商并填写 API 地址、密钥和模型。", "保存后使用测试功能检查连接。"] },
      { id: "parser", title: "配置解析", icon: FileText, summary: "连接 MinerU 解析 PDF 正文。", steps: ["打开设置中的解析配置。", "填写 MinerU 信息并保存。", "回到论文库解析论文。"] },
      { id: "browser", title: "浏览器扩展", icon: MonitorDown, summary: "从论文网页直接加入 ZoomPaper。", steps: ["在 Chrome 或 Edge 的扩展管理页加载解压后的扩展。", "打开受支持的论文页面。", "右键页面或点击扩展按钮，选择加入 ZoomPaper。"] },
      { id: "reparse", title: "重新解析", icon: RefreshCw, summary: "在元数据或正文不完整时重新处理论文。", steps: ["在论文库右键论文。", "点击解析或重新解析。", "等待状态变为已解析。"] },
      { id: "help-ai", title: "询问软件用法", icon: HelpCircle, summary: "让 AI 根据完整功能手册回答操作问题。", steps: ["打开帮助页面。", "在“问 AI”输入功能或操作问题。", "发送后按回答中的步骤操作。"] },
    ],
  },
];

export function HelpPage() {
  const [sectionId, setSectionId] = useState(guideSections[0].id);
  const section = guideSections.find((item) => item.id === sectionId) ?? guideSections[0];
  const [featureId, setFeatureId] = useState(section.items[0].id);
  const selected = useMemo(() => section.items.find((item) => item.id === featureId) ?? section.items[0], [featureId, section]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectSection = (next: GuideSection) => {
    setSectionId(next.id);
    setFeatureId(next.items[0].id);
  };

  async function ask() {
    const value = question.trim();
    if (!value || loading) return;
    setLoading(true);
    setError(null);
    try { setAnswer(await askAppHelp(value)); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }

  const SelectedIcon = selected.icon;

  return (
    <section className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-y-auto px-8 py-7">
      <header><h1 className="text-xl font-semibold text-zp-primary">帮助</h1></header>

      <div className="mt-5 grid min-h-[520px] grid-cols-[168px_260px_minmax(0,1fr)] overflow-hidden rounded-xl border border-zp-border bg-white dark:bg-zp-surface">
        <nav className="border-r border-zp-border bg-zp-surface/70 p-2.5" aria-label="帮助分类">
          {guideSections.map((item) => {
            const Icon = item.icon;
            const active = item.id === section.id;
            return <button key={item.id} type="button" onClick={() => selectSection(item)} className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors", active ? "bg-white font-medium text-zp-primary shadow-sm dark:bg-zp-surface-hover" : "text-zp-secondary hover:bg-zp-surface-hover hover:text-zp-primary")}><Icon className="h-4 w-4 shrink-0" />{item.title}</button>;
          })}
        </nav>

        <div className="overflow-y-auto border-r border-zp-border p-3">
          <h2 className="px-2 pb-2 text-xs font-medium text-zp-quaternary">{section.title}</h2>
          <div className="space-y-0.5">
            {section.items.map((item) => {
              const Icon = item.icon;
              const active = item.id === selected.id;
              return <button key={item.id} type="button" onClick={() => setFeatureId(item.id)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors", active ? "bg-zp-surface-hover font-medium text-zp-primary" : "text-zp-secondary hover:bg-zp-surface-hover/70 hover:text-zp-primary")}><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zp-border bg-white dark:bg-zp-surface"><Icon className="h-4 w-4" /></span>{item.title}</button>;
            })}
          </div>
        </div>

        <article className="overflow-y-auto p-7">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-zp-surface text-zp-primary"><SelectedIcon className="h-5 w-5" /></div>
          <h2 className="mt-4 text-lg font-semibold text-zp-primary">{selected.title}</h2>
          <p className="mt-1 text-sm text-zp-secondary">{selected.summary}</p>
          <ol className="mt-6 space-y-4">
            {selected.steps.map((step, index) => <li key={step} className="flex gap-3 text-sm leading-6 text-zp-secondary"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zp-surface text-xs font-medium tabular-nums text-zp-primary">{index + 1}</span><span>{step}</span></li>)}
          </ol>
        </article>
      </div>

      <div className="mt-5 rounded-xl border border-zp-border bg-white p-4 dark:bg-zp-surface">
        <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-zp-tertiary" /><h2 className="text-sm font-medium">问 AI</h2></div>
        {answer && <div className="prose prose-sm mt-4 max-w-none text-zp-secondary dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown></div>}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex items-center rounded-xl border border-zp-border bg-zp-surface px-3 py-2">
          <input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void ask(); }} aria-label="询问软件功能" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
          <button type="button" onClick={() => void ask()} disabled={!question.trim() || loading} aria-label="发送" className="flex h-8 w-8 items-center justify-center rounded-full bg-zp-primary text-white disabled:opacity-40">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}</button>
        </div>
      </div>
    </section>
  );
}
