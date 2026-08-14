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
import { listPapers, search, type Paper, type SearchHit } from "@/lib/api";
import { Loader2, Search as SearchIcon } from "lucide-react";

const ALL_PAPERS = "__all__";

interface Props {
  onOpenPaper: (paperId: string) => void;
}

export function SearchPage({ onOpenPaper }: Props) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string>(ALL_PAPERS);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPapers()
      .then((ps) => setPapers(ps.filter((p) => p.parse_status === "ready")))
      .catch(() => {});
  }, []);

  async function handleSearch() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      setHits(await search(q, 10, scope === ALL_PAPERS ? null : scope));
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">语义搜索</h1>
        <p className="text-sm text-muted-foreground">按语义检索论文段落，支持中英文</p>
      </div>

      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void handleSearch();
          }}
          placeholder="输入检索内容，回车搜索…"
          className="flex-1"
        />
        <Select
          value={scope}
          onValueChange={(v) => setScope(v ?? ALL_PAPERS)}
          items={[
            { value: ALL_PAPERS, label: "全部论文" },
            ...papers.map((p) => ({ value: p.id, label: p.title })),
          ]}
        >
          <SelectTrigger className="w-44">
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

      {hits && hits.length > 0 && (
        <div className="flex flex-col gap-3">
          {hits.map((hit, i) => (
            <motion.div
              key={hit.chunk_id}
              initial={{ opacity: 0, transform: "translateY(8px)" }}
              animate={{ opacity: 1, transform: "translateY(0)" }}
              transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1], delay: Math.min(i * 0.05, 0.3) }}
            >
              <Card
                className="pressable cursor-pointer transition-colors hover:border-primary/40"
                onClick={() => onOpenPaper(hit.paper_id)}
              >
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="max-w-64 truncate">
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
