import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listPapers, search, keywordSearch, type Paper, type SearchHit } from "@/lib/api";
import { Loader2, Search as SearchIcon } from "lucide-react";

const ALL_PAPERS = "__all__";

interface Props {
  onOpenPaper: (paperId: string, pageIdx?: number) => void;
}

export function SearchPage({ onOpenPaper }: Props) {
  const [method, setMethod] = useState("keyword");
  const [papers, setPapers] = useState<Paper[]>([]);
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string>(ALL_PAPERS);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPapers()
      .then((ps) => setPapers(ps.filter((p) => p.deleted_at == null && p.parse_status === "ready")))
      .catch((e) => setError(`读取论文列表失败：${e}`));
  }, []);

  async function handleSearch() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      setHits(await (method === "keyword" ? keywordSearch(q, scope === ALL_PAPERS ? null : scope) : search(q, 10, scope === ALL_PAPERS ? null : scope)));
      setSubmittedQuery(q);
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">搜索论文</h1>
      </div>

      <div className="flex gap-2" role="group" aria-label="检索方式">{[["keyword", "关键词"], ["semantic", "语义"]].map(([value, label]) => <button key={value} disabled={searching} aria-pressed={method === value} onClick={() => { setMethod(value); setHits(null); }} className={`rounded-lg px-3 py-1.5 text-sm ${method === value ? "bg-accent text-primary" : "text-muted-foreground"}`}>{label}</button>)}</div>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="搜索论文内容"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void handleSearch();
          }}
          placeholder=""
          className="flex-1"
        />
        <Select
          disabled={searching}
          value={scope}
          onValueChange={(v) => { setScope(v ?? ALL_PAPERS); setHits(null); }}
          items={[
            { value: ALL_PAPERS, label: "全部论文" },
            ...papers.map((p) => ({ value: p.id, label: p.title })),
          ]}
        >
          <SelectTrigger className="w-44" aria-label="搜索范围">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PAPERS}>全部论文</SelectItem>
            {papers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => void handleSearch()} disabled={searching || !query.trim()}>
          {searching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <SearchIcon className="mr-2 h-4 w-4" />
          )}
          搜索
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {hits !== null && hits.length === 0 && !error && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-muted-foreground">
          <SearchIcon className="h-10 w-10" />
          <p className="text-sm">没有命中结果，换个说法试试</p>
        </div>
      )}

      {hits && hits.length > 0 && <p className="text-xs text-muted-foreground">「{submittedQuery}」· 找到 {hits.length} 个相关段落</p>}
      {hits && hits.length > 0 && (
        <div className="flex flex-col gap-3">
          {hits.map((hit, i) => (
            <motion.div
              key={`${hit.paper_id}:${hit.chunk_id}`}
              initial={{ opacity: 0, transform: "translateY(8px)" }}
              animate={{ opacity: 1, transform: "translateY(0)" }}
              transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1], delay: Math.min(i * 0.05, 0.3) }}
            >
              <Card
                className="pressable cursor-pointer transition-colors hover:border-primary/40"
                role="button" tabIndex={0} aria-label={`打开 ${hit.paper_title} 的搜索结果`}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenPaper(hit.paper_id, hit.page_idx ?? undefined); } }}
                onClick={() => onOpenPaper(hit.paper_id, hit.page_idx ?? undefined)}
              >
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex min-w-0 flex-col items-start gap-1">
                    <Badge variant="secondary" className="block max-w-full truncate" title={hit.paper_title}>
                      {hit.paper_title}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {hit.section}
                      {hit.page_idx != null && ` · 第 ${hit.page_idx + 1} 页`}
                    </span>
                  </div>
                  <p className="line-clamp-3 text-sm text-muted-foreground">{hit.content}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
