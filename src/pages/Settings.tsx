import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Check, Loader2, Plus, Save, Edit2, Trash2 } from "lucide-react";
import {
  getSettings,
  reindexAllPapers,
  updateSettings,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  type Settings,
  type ProviderConfig,
} from "@/lib/api";
import { PROVIDER_TEMPLATES, createProviderFromTemplate, type ProviderTemplate } from "@/lib/providerTemplates";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState<string | null>(null);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<ProviderTemplate | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const s = await getSettings();
      setSettings(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

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

  const current = settings;

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updateSettings(current);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
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

  async function handleReindex() {
    setReindexing(true);
    setReindexResult(null);
    setError(null);
    try {
      const [ok, failed] = await reindexAllPapers();
      setReindexResult(
        failed > 0 ? `重建完成：成功 ${ok} 篇，失败 ${failed} 篇` : `重建完成：共 ${ok} 篇`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setReindexing(false);
    }
  }

  async function handleAddProvider(template: ProviderTemplate, apiKey: string, customBaseUrl?: string, customModel?: string) {
    try {
      let id = template.id;
      if (template.id === "custom" || current.providers.some(p => p.id === template.id)) {
        id = `${template.id}-${Date.now()}`;
      }

      const config = createProviderFromTemplate(template, apiKey, id);
      if (customBaseUrl) config.base_url = customBaseUrl;
      if (customModel) config.default_model = customModel;

      const updated = await addProvider(config);
      setSettings(updated);
      setShowAddDialog(false);
      setSelectedTemplate(null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleUpdateProvider(id: string, config: ProviderConfig) {
    try {
      const updated = await updateProvider(id, config);
      setSettings(updated);
      setShowEditDialog(false);
      setEditingProvider(null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDeleteProvider(id: string) {
    if (!confirm(`确定要删除 provider "${current.providers.find(p => p.id === id)?.name}"？`)) {
      return;
    }
    try {
      const updated = await deleteProvider(id);
      setSettings(updated);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleSetActive(id: string) {
    try {
      const updated = await setActiveProvider(id);
      setSettings(updated);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="mx-auto min-h-0 w-full max-w-4xl flex-1 space-y-4 overflow-y-auto p-6">
      <div>
        <h1 className="text-2xl font-bold">设置</h1>
        <p className="text-sm text-muted-foreground">配置 AI Provider、论文库和其他选项</p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="text-base">AI Provider</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">管理 LLM API 配置</p>
          </div>
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            添加 Provider
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {current.providers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>尚未配置任何 Provider</p>
              <p className="text-sm mt-1">点击"添加 Provider"开始配置</p>
            </div>
          ) : (
            current.providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                isActive={provider.id === current.active_provider_id}
                onSetActive={() => handleSetActive(provider.id)}
                onEdit={() => {
                  setEditingProvider(provider);
                  setShowEditDialog(true);
                }}
                onDelete={() => handleDeleteProvider(provider.id)}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">PDF 解析服务</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="mineru">MinerU API Key</Label>
            <Input
              id="mineru"
              type="password"
              placeholder="PDF 解析（mineru.net，免费额度）"
              value={current.mineru_api_key}
              onChange={(e) => setSettings({ ...current, mineru_api_key: e.target.value })}
            />
          </div>
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
          <div className="grid gap-1.5">
            <Label>向量索引</Label>
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={handleReindex} disabled={reindexing}>
                {reindexing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                重建全部索引
              </Button>
              {reindexResult && (
                <span className="text-sm text-muted-foreground">{reindexResult}</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              对已解析的论文重新分块并生成向量。升级后若 AI 问答缺少公式等内容，可点此重建（耗时取决于论文数量）。
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">联网搜索</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="web-search-provider">搜索 Provider</Label>
            <Select
              value={settings.web_search_provider}
              onValueChange={(v) =>
                setSettings({ ...current, web_search_provider: v ?? current.web_search_provider })
              }
            >
              <SelectTrigger id="web-search-provider" className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">关闭</SelectItem>
                <SelectItem value="auto">自动（优先 DeepSeek，其次 Anthropic）</SelectItem>
                <SelectItem value="deepseek">DeepSeek 原生搜索</SelectItem>
                <SelectItem value="anthropic">Anthropic 原生搜索</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              复用上方 DeepSeek / Anthropic Provider 的 API Key，无需新增密钥
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="web-search-model">搜索模型名（可选）</Label>
            <Input
              id="web-search-model"
              value={settings.web_search_model ?? ""}
              onChange={(e) =>
                setSettings({ ...settings, web_search_model: e.target.value || null })
              }
              placeholder="默认：deepseek-v4-flash（DeepSeek）/ 当前模型（Anthropic）"
            />
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex items-center gap-3 pb-4">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          保存设置
        </Button>
        {saved && (
          <span className="flex items-center gap-1 text-sm text-green-600">
            <Check className="h-4 w-4" />
            已保存
          </span>
        )}
      </div>

      <AddProviderDialog
        open={showAddDialog}
        onClose={() => {
          setShowAddDialog(false);
          setSelectedTemplate(null);
        }}
        onAdd={handleAddProvider}
        selectedTemplate={selectedTemplate}
        onSelectTemplate={setSelectedTemplate}
      />

      {editingProvider && (
        <EditProviderDialog
          open={showEditDialog}
          provider={editingProvider}
          onClose={() => {
            setShowEditDialog(false);
            setEditingProvider(null);
          }}
          onSave={handleUpdateProvider}
        />
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  isActive,
  onSetActive,
  onEdit,
  onDelete,
}: {
  provider: ProviderConfig;
  isActive: boolean;
  onSetActive: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`rounded-lg border p-4 ${isActive ? 'border-primary bg-primary/5' : ''}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="font-medium">{provider.name}</h3>
            {isActive && (
              <Badge variant="default" className="text-xs">
                <Check className="mr-1 h-3 w-3" />
                当前使用
              </Badge>
            )}
            <Badge variant="outline" className="text-xs">
              {provider.provider_type === "anthropic" ? "Anthropic" : "OpenAI 兼容"}
            </Badge>
          </div>
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>模型：{provider.default_model}</p>
            {provider.base_url && <p>端点：{provider.base_url}</p>}
            <p>API Key：{provider.api_key ? '••••••••' : '未配置'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isActive && (
            <Button size="sm" variant="outline" onClick={onSetActive}>
              切换使用
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Edit2 className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            disabled={isActive}
            title={isActive ? '无法删除当前使用的 provider' : '删除'}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function AddProviderDialog({
  open,
  onClose,
  onAdd,
  selectedTemplate,
  onSelectTemplate,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (template: ProviderTemplate, apiKey: string, customBaseUrl?: string, customModel?: string) => void;
  selectedTemplate: ProviderTemplate | null;
  onSelectTemplate: (template: ProviderTemplate | null) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customModel, setCustomModel] = useState("");

  const handleAdd = () => {
    if (!selectedTemplate || !apiKey) return;
    onAdd(selectedTemplate, apiKey, customBaseUrl || undefined, customModel || undefined);
    setApiKey("");
    setCustomBaseUrl("");
    setCustomModel("");
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>添加 AI Provider</DialogTitle>
          <DialogDescription>
            从模板选择或自定义配置
          </DialogDescription>
        </DialogHeader>

        {!selectedTemplate ? (
          <div className="grid grid-cols-2 gap-3">
            {PROVIDER_TEMPLATES.map((template) => (
              <button
                key={template.id}
                onClick={() => {
                  onSelectTemplate(template);
                  if (template.base_url) setCustomBaseUrl(template.base_url);
                  if (template.default_model) setCustomModel(template.default_model);
                }}
                className="flex flex-col items-start gap-2 rounded-lg border p-4 text-left hover:bg-accent transition-colors"
              >
                <div className="font-medium">{template.name}</div>
                <div className="text-sm text-muted-foreground">{template.description}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => onSelectTemplate(null)}>
                ← 返回
              </Button>
              <span className="font-medium">{selectedTemplate.name}</span>
            </div>

            <div className="space-y-3">
              <div className="grid gap-1.5">
                <Label htmlFor="add-api-key">API Key *</Label>
                <Input
                  id="add-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="输入 API Key"
                />
              </div>

              {selectedTemplate.provider_type === "openai-compat" && (
                <div className="grid gap-1.5">
                  <Label htmlFor="add-base-url">Base URL *</Label>
                  <Input
                    id="add-base-url"
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                  />
                </div>
              )}

              <div className="grid gap-1.5">
                <Label htmlFor="add-model">默认模型 *</Label>
                {selectedTemplate.models.length > 0 ? (
                  <Select value={customModel} onValueChange={setCustomModel}>
                    <SelectTrigger id="add-model">
                      <SelectValue placeholder="选择模型" />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedTemplate.models.map((model) => (
                        <SelectItem key={model} value={model}>
                          {model}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="add-model"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="输入模型名称"
                  />
                )}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button onClick={handleAdd} disabled={!apiKey || (selectedTemplate.provider_type === "openai-compat" && !customBaseUrl) || !customModel}>
                添加
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditProviderDialog({
  open,
  provider,
  onClose,
  onSave,
}: {
  open: boolean;
  provider: ProviderConfig;
  onClose: () => void;
  onSave: (id: string, config: ProviderConfig) => void;
}) {
  const [config, setConfig] = useState<ProviderConfig>(provider);

  useEffect(() => {
    setConfig(provider);
  }, [provider]);

  const handleSave = () => {
    onSave(provider.id, config);
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>编辑 Provider</DialogTitle>
          <DialogDescription>{provider.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="edit-name">名称</Label>
            <Input
              id="edit-name"
              value={config.name}
              onChange={(e) => setConfig({ ...config, name: e.target.value })}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="edit-api-key">API Key</Label>
            <Input
              id="edit-api-key"
              type="password"
              value={config.api_key}
              onChange={(e) => setConfig({ ...config, api_key: e.target.value })}
            />
          </div>

          {config.provider_type === "openai-compat" && (
            <div className="grid gap-1.5">
              <Label htmlFor="edit-base-url">Base URL</Label>
              <Input
                id="edit-base-url"
                value={config.base_url || ""}
                onChange={(e) => setConfig({ ...config, base_url: e.target.value || null })}
              />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="edit-model">默认模型</Label>
            {config.models.length > 0 ? (
              <Select
                value={config.default_model}
                onValueChange={(v) => setConfig({ ...config, default_model: v })}
              >
                <SelectTrigger id="edit-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {config.models.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="edit-model"
                value={config.default_model}
                onChange={(e) => setConfig({ ...config, default_model: e.target.value })}
              />
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSave}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
