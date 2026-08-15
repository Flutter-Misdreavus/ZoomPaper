import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Loader2, Save } from "lucide-react";
import { getSettings, updateSettings, type Settings } from "@/lib/api";

const API_KEY_FIELDS: { key: keyof Settings["api_keys"]; label: string; hint: string }[] = [
  { key: "mineru", label: "MinerU", hint: "PDF 解析（mineru.net，免费额度）" },
  { key: "openai", label: "OpenAI", hint: "对话 + 模型（默认）" },
  { key: "anthropic", label: "Anthropic", hint: "Claude 对话" },
  { key: "gemini", label: "Gemini", hint: "Google Gemini 对话" },
  { key: "deepseek", label: "DeepSeek", hint: "DeepSeek 对话" },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);

  if (!settings) {
    return error ? (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    ) : (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载设置…
      </div>
    );
  }

  // 守卫后 settings 收窄为非空；闭包里 TS 不再收窄，用 const 固定
  const current = settings;

  function setApiKey(key: keyof Settings["api_keys"], value: string) {
    setSettings({ ...current, api_keys: { ...current.api_keys, [key]: value } });
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updateSettings(current);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function pickLibraryPath() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      setSettings({ ...current, paper_library_path: dir });
    }
  }

  return (
    <div className="mx-auto min-h-0 w-full max-w-2xl flex-1 space-y-4 overflow-y-auto">
      <div>
        <h1 className="text-2xl font-bold">设置</h1>
        <p className="text-sm text-muted-foreground">所有 API 信息都在这里配置，数据仅存本机。</p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">API Key</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {API_KEY_FIELDS.map((field) => (
            <div key={field.key} className="grid gap-1.5">
              <Label htmlFor={field.key}>{field.label}</Label>
              <Input
                id={field.key}
                type="password"
                placeholder={field.hint}
                value={settings.api_keys[field.key]}
                onChange={(e) => setApiKey(field.key, e.target.value)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">论文库</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="library-path">论文库路径</Label>
            <div className="flex gap-2">
              <Input
                id="library-path"
                value={settings.paper_library_path ?? "默认位置（应用数据目录）"}
                readOnly
                className="text-muted-foreground"
              />
              <Button variant="outline" onClick={pickLibraryPath}>
                选择…
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI 对话</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="llm-provider">默认 Provider</Label>
            <Select
              value={settings.llm_provider}
              onValueChange={(v) =>
                setSettings({ ...current, llm_provider: v ?? current.llm_provider })
              }
            >
              <SelectTrigger id="llm-provider" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="gemini">Gemini</SelectItem>
                <SelectItem value="deepseek">DeepSeek</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="llm-model">默认模型名</Label>
            <Input
              id="llm-model"
              value={settings.llm_model}
              onChange={(e) => setSettings({ ...settings, llm_model: e.target.value })}
              placeholder="gpt-4o-mini"
            />
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          保存设置
        </Button>
        {saved && <span className="text-sm text-green-600">已保存</span>}
      </div>
    </div>
  );
}
