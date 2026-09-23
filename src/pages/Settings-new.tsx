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
import { Switch } from "@/components/ui/switch";

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState<string | null>(null);

  // Provider 管理状态
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

  async function handleToggleEnabled(provider: ProviderConfig) {
    const updated = { ...provider, enabled: !provider.enabled };
    try {
      const newSettings = await updateProvider(provider.id, updated);
      setSettings(newSettings);
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

      {/* AI Provider 配置 */}
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
                onToggleEnabled={() => handleToggleEnabled(provider)}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* PLACEHOLDER_FOR_REST */}

      {/* 添加 Provider 对话框 */}
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

      {/* 编辑 Provider 对话框 */}
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

/* PLACEHOLDER_FOR_COMPONENTS */
