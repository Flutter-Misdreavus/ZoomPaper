import { getTheme, setTheme, getCustomTheme, setCustomTheme, type CustomTheme, THEME_PRESETS, THEME_CHANGED_EVENT } from "@/lib/theme";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { usePreferences, setPreferences, exportViewPreferences, missingMetadata, type Preferences } from "@/lib/preferences";
import { blogJobs } from "@/lib/blogJobs";
import { translationJobs } from "@/lib/translationJobs";
import { companionEnabled, setCompanionEnabled } from "@/lib/companionPreferences";
import { Switch } from "@/components/ui/switch";
import { useEffect, useState, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Search, BookOpen, Bot, Database, Upload, Settings as SettingsIcon, MessageSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Check, Loader2, Plus, Edit2, Trash2 } from "lucide-react";
import { getSettings, getThemesDir, listCustomThemes, listPapers, listJobs, emptyTrash, enqueueMetadataTranslations, DEFAULT_WORKFLOW, type Paper, type WorkflowSettings, reindexAllPapers, updateSettings, addProvider, updateProvider, deleteProvider, setActiveProvider, type Settings, type ProviderConfig, } from "@/lib/api";
import { PROVIDER_TEMPLATES, createProviderFromTemplate, type ProviderTemplate } from "@/lib/providerTemplates";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
type SettingsSection = 'general' | 'reader' | 'companion' | 'ai' | 'import' | 'data';
const SECTIONS = [{ id: 'general', name: '常规', icon: SettingsIcon }, { id: 'reader', name: '论文阅读', icon: BookOpen }, { id: 'companion', name: '阅读伙伴', icon: Bot }, { id: 'ai', name: 'AI 模型与 API', icon: MessageSquare }, { id: 'import', name: '导入与解析', icon: Upload }, { id: 'data', name: '数据与存储', icon: Database }] as const;
export function SettingsPage() {
    const prefs = usePreferences();
    const [customThemes, updateCustomThemes] = useState<CustomTheme[]>([]);
    const [customThemeName, updateCustomThemeName] = useState(() => getCustomTheme()?.name ?? '');
    const refreshThemes = async () => { try { const themes = await listCustomThemes(); updateCustomThemes(themes); const current=getCustomTheme(); if(current){const fresh=themes.find(t=>t.name===current.name);setCustomTheme(fresh??null);updateCustomThemeName(fresh?.name??'');} } catch(error){setError(String(error));} };

    const [theme, updateTheme] = useState(getTheme);
    useEffect(() => { const refresh = () => updateTheme(getTheme()); window.addEventListener(THEME_CHANGED_EVENT, refresh); window.addEventListener("storage", refresh); return () => { window.removeEventListener(THEME_CHANGED_EVENT, refresh); window.removeEventListener("storage", refresh); }; }, []);
    const [section, setSection] = useState<SettingsSection>('general');
    const [query, setQuery] = useState('');
    const [missing, setMissing] = useState<Paper[] | null>(null);
    const [actionStatus, setActionStatus] = useState('');
    const [operation, setOperation] = useState<string | null>(null);
    const [working, setWorking] = useState(false);
    const [extensionReady, setExtensionReady] = useState(false);
    useEffect(() => { void invoke<boolean>('browser_extension_status').then(setExtensionReady).catch(() => { }); }, []);
    const [extensionPath, setExtensionPath] = useState('');
    const [extensionInstall, setExtensionInstall] = useState(false);
    const [storagePath, setStoragePath] = useState('');
    const [pendingPath, setPendingPath] = useState('');
    async function chooseStorageFolder() {
        setError(null);
        try { const path = await open({directory:true,multiple:false}); if(typeof path === 'string')setPendingPath(path); }
        catch(error){setError(String(error));}
    }
    useEffect(() => { void invoke<string>('library_storage_path').then(setStoragePath).catch(() => {}); }, []);
    const [concurrency, setConcurrency] = useState('2');
    const settingsRef = useRef<Settings | null>(null);
    const saveQueue = useRef(Promise.resolve());
    const [petEnabled, setPetEnabled] = useState(companionEnabled);
    useEffect(() => { const update = () => setPetEnabled(companionEnabled()); window.addEventListener("companion-preference", update); return () => window.removeEventListener("companion-preference", update); }, []);
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
        void refreshThemes();
    }, []);
    async function loadSettings() {
        try {
            const s = await getSettings();
            setSettings(s);
            settingsRef.current = s;
            setConcurrency(String(s.workflow?.parseConcurrency ?? 2));
            setError(null);
        }
        catch (e) {
            setError(String(e));
        }
    }
    if (!settings) {
        return error ? (<div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {error}
      </div>) : (<div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin"/>
        加载设置…
      </div>);
    }
    const current = settings;
    settingsRef.current = settings;
    async function handleSave() {
        setSaving(true);
        setSaved(false);
        setError(null);
        try {
            await updateSettings(current);
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            setSaving(false);
        }
    }
    async function changeLanguage(key: keyof Preferences, value: string) {
        setPreferences({ [key]: value });
        setError(null);
        if (value === 'original' || value === 'inherit' && prefs.titleLanguage === 'original')
            return;
        try {
            const absent = missingMetadata(await listPapers());
            if (absent.length)
                setMissing(absent);
        }
        catch (e) {
            setError(String(e));
        }
    }
    function saveWorkflow(patch: Partial<WorkflowSettings>) {
        const next = { ...settingsRef.current!, workflow: { ...DEFAULT_WORKFLOW, ...settingsRef.current?.workflow, ...patch } };
        settingsRef.current = next;
        setSettings(next);
        setError(null);
        setSaving(true);
        saveQueue.current = saveQueue.current.catch(() => { }).then(async () => { try {
            await updateSettings(next);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            setSaving(false);
        } });
    }
    async function perform(name: string) {
        setWorking(true);
        setError(null);
        setActionStatus('');
        try {
            if (['backup', 'restore', 'path'].includes(name)) {
                if ([...blogJobs.getEntries(), ...translationJobs.getEntries()].some(([, job]) => job.status === 'running') || (await listJobs()).some(j => j.status === 'running' || j.status === 'canceling'))
                    throw new Error('请等待正在运行的任务完成后操作');
            }
            if (name === 'extension' || name === 'extensionDir') {
                const path = await invoke<string>('prepare_browser_extension');
                setExtensionPath(path);
                await revealItemInDir(path);
                if (name === 'extension')
                    setExtensionInstall(true);
            }
            else if (name === 'cache') {
                await invoke('clear_library_cache');
                setActionStatus('已清理缓存');
            }
            else if (name === 'trash') {
                const count = await emptyTrash();
                setActionStatus(`已永久删除 ${count} 篇论文`);
                window.dispatchEvent(new Event('zoompaper-library-changed'));
            }
            else if (name === 'reindex') {
                await handleReindex();
            }
            else {
                const path = name === 'path' ? pendingPath : await open({ directory: true, multiple: false });
                if (typeof path !== 'string' || !path)
                    return;
                if (name === 'backup') {
                    const values = exportViewPreferences();
                    const result = await invoke<string>('export_library_backup', { destination: path, preferences: values });
                    await revealItemInDir(result);
                    setActionStatus('备份已导出');
                }
                else if (name === 'restore') {
                    await invoke('stage_library_restore', { source: path, preferences: exportViewPreferences() });
                    setActionStatus('备份已校验，请完全退出并重新打开应用完成恢复。');
                }
                else if (name === 'path') {
                    const updated = await invoke<Settings>('relocate_library', { destination: path });
                    setSettings(updated);
                    setStoragePath(updated.paper_library_path ?? storagePath);
                    setPendingPath('');
                    settingsRef.current = updated;
                    window.dispatchEvent(new Event('zoompaper-library-changed'));
                    setActionStatus('论文库已迁移；旧目录仍保留。');
                }
            }
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            setWorking(false);
            setOperation(null);
        }
    }
    async function handleReindex() {
        setReindexing(true);
        setReindexResult(null);
        setError(null);
        try {
            const [ok, failed] = await reindexAllPapers();
            setReindexResult(failed > 0 ? `重建完成：成功 ${ok} 篇，失败 ${failed} 篇` : `重建完成：共 ${ok} 篇`);
        }
        catch (e) {
            setError(String(e));
        }
        finally {
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
            if (customBaseUrl)
                config.base_url = customBaseUrl;
            if (customModel)
                config.default_model = customModel;
            const updated = await addProvider(config);
            setSettings(updated);
            setShowAddDialog(false);
            setSelectedTemplate(null);
            setError(null);
        }
        catch (e) {
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
        }
        catch (e) {
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
        }
        catch (e) {
            setError(String(e));
        }
    }
    async function handleSetActive(id: string) {
        try {
            const updated = await setActiveProvider(id);
            setSettings(updated);
            setError(null);
        }
        catch (e) {
            setError(String(e));
        }
    }
    const workflow = { ...DEFAULT_WORKFLOW, ...current.workflow };
    const row = (id: string, label: string, control: React.ReactNode) => <div id={`setting-${id}`} className="flex min-h-[64px] items-center justify-between gap-5 py-4"><span className="text-sm">{label}</span><div className="flex shrink-0 items-center gap-2">{control}</div></div>;
    const toggle = (key: keyof Preferences, label: string) => row(key, label, <Switch aria-label={label} checked={Boolean(prefs[key])} onCheckedChange={value => setPreferences({ [key]: value })}/>);
    const selectControl = (label: string, value: string, options: {value:string;label:string}[], change: (value:string)=>void) => <Select value={value} onValueChange={value=>{if(value!==null)change(value);}}><SelectTrigger aria-label={label} className="h-8 min-w-32 border-zp-border shadow-none"><SelectValue>{options.find(option=>option.value===value)?.label}</SelectValue></SelectTrigger><SelectContent>{options.map(option=><SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
    const language = (key: keyof Preferences, label: string, _inherit = false) => row(key, label, selectControl(label, String(prefs[key] === 'inherit' ? prefs.titleLanguage : prefs[key]), [{value:'original',label:'英文'},{value:'zh',label:'中文'},{value:'both',label:'中英双语'}], value=>void changeLanguage(key,value)));
    const workflowToggle = (key: keyof WorkflowSettings, label: string) => row(key, label, <Switch aria-label={label} checked={Boolean(workflow[key])} onCheckedChange={value => saveWorkflow({ [key]: value })}/>);
    const action = (id: string, label: string, button: string) => row(id, label, <Button size="sm" variant="outline" disabled={working || reindexing} onClick={() => ['extension', 'extensionDir', 'backup', 'restore'].includes(id) ? void perform(id) : setOperation(id)}>{button}</Button>);
    const panels = [
        { id: 'general', groups: [{ title: '外观', rows: [row('theme', '主题配色', <>{selectControl('主题配色', theme.scheme, [...THEME_PRESETS.map(p => ({value:p.key,label:p.key==='green'?'默认':p.label})), {value:'custom',label:'自定义'}], value=>setTheme(value as typeof theme.scheme))}{theme.scheme==='custom' && <input type="color" aria-label="自定义主色" value={theme.customColor} onChange={event=>setTheme('custom',event.target.value)} className="h-8 w-10 cursor-pointer rounded border border-zp-border"/>}</>)] }, { title: '高级主题', rows: [row('customTheme', 'JSON 主题', <>{selectControl('JSON 主题', customThemeName||'none', [{value:'none',label:'无'},...customThemes.map(t=>({value:t.name,label:t.name}))], value=>{const name=value==='none'?'':value;updateCustomThemeName(name);setCustomTheme(customThemes.find(t=>t.name===name)??null);})}<Button size="sm" variant="outline" onClick={()=>void getThemesDir().then(revealItemInDir).catch(error=>setError(String(error)))}>主题目录</Button><Button size="sm" variant="ghost" onClick={()=>void refreshThemes()}>刷新</Button></>)] }, { title: '标题与摘要'  , rows: [language('titleLanguage', '统一标题语言'), language('libraryLanguage', '论文库标题', true), language('tabLanguage', '论文标签标题', true), language('detailLanguage', '概览标题', true), language('abstractLanguage', '概览摘要'), language('historyLanguage', '阅读历史标题', true)] }, { title: '启动', rows: [toggle('restoreTabs', '恢复上次打开的论文')] }] },
        { id: 'reader', groups: [{ title: '阅读器', rows: [toggle('markReading', '打开后标记在读'), toggle('markReadAtEnd', '读到末页自动标记已读'), toggle('showAssistant', '默认显示 AI 助手')] }] },
        { id: 'companion', groups: [{ title: '阅读伙伴', rows: [row('pet', '显示桌面阅读伙伴', <Switch aria-label="显示桌面阅读伙伴" checked={petEnabled} onCheckedChange={setCompanionEnabled}/>), row('petAnimation', '角色动画', selectControl('角色动画',prefs.petAnimation?'rich':'normal',[{value:'rich',label:'丰富'},{value:'normal',label:'普通'}],value=>setPreferences({petAnimation:value==='rich'}))), toggle('petReading', '显示正在阅读'), toggle('petTasks', '显示任务气泡')] }] },
        { id: 'ai', groups: [{ title: 'AI 服务', rows: [<div key="providers" className="space-y-3 py-4">{current.providers.map(provider => <ProviderCard key={provider.id} provider={provider} isActive={provider.id === current.active_provider_id} onSetActive={() => handleSetActive(provider.id)} onEdit={() => { setEditingProvider(provider); setShowEditDialog(true); }} onDelete={() => handleDeleteProvider(provider.id)}/>)}<Button size="sm" variant="outline" onClick={() => setShowAddDialog(true)}><Plus size={15}/>添加 Provider</Button></div>] }, { title: '联网搜索', rows: [row('webProvider', '搜索 Provider', selectControl('搜索 Provider',current.web_search_provider,[{value:'none',label:'关闭'},{value:'auto',label:'自动'},{value:'deepseek',label:'DeepSeek'},{value:'anthropic',label:'Anthropic'}],value=>setSettings({...current,web_search_provider:value}))), row('webModel', '搜索模型名', <Input aria-label="搜索模型名" value={current.web_search_model ?? ''} onChange={e => setSettings({ ...current, web_search_model: e.target.value || null })} className="w-56"/>)] }] },
        { id: 'import', groups: [{ title: 'PDF 解析', rows: [row('mineru', 'MinerU API Key', <Input aria-label="MinerU API Key" type="password" autoComplete="off" value={current.mineru_api_key} onBlur={() => saveWorkflow({})} onChange={e => setSettings({ ...current, mineru_api_key: e.target.value })} className="w-56"/>), workflowToggle('autoParse', '导入后自动解析'), row('parseConcurrency', '同时解析论文数', <Input aria-label="同时解析论文数" type="number" min={1} step={1} value={concurrency} onChange={e => setConcurrency(e.target.value)} onBlur={() => { const n = Number(concurrency); if (!Number.isSafeInteger(n) || n < 1 || n > 4294967295) {
                            setError('同时解析论文数必须为正整数');
                            setConcurrency(String(workflow.parseConcurrency));
                        }
                        else
                            saveWorkflow({ parseConcurrency: n }); }} className="w-24"/>)] }, { title: '导入后处理', rows: [workflowToggle('autoDoi', '自动补全会议与 DOI'), workflowToggle('autoMetadataTranslation', '翻译标题与摘要'), workflowToggle('autoFullTranslation', '自动翻译全文')] }, { title: '浏览器扩展', rows: [row('connector', '导入接收服务', <span className="text-sm text-zp-tertiary">{extensionReady ? '已就绪' : '未连接'}</span>), action('extension', '浏览器扩展', '加载扩展'), action('extensionDir', '扩展文件夹', '定位')] }] },
        { id: 'data', groups: [{ title: '论文库', rows: [row('path', '存储位置', <><Input aria-label="论文库存储路径" readOnly value={pendingPath || current.paper_library_path || storagePath} title={pendingPath || current.paper_library_path || storagePath} className={`${pendingPath ? "w-[min(16vw,200px)]" : "w-[min(28vw,400px)]"} text-xs text-zp-secondary`}/><Button size="sm" variant="outline" disabled={working} onClick={() => void chooseStorageFolder()}>选择文件夹</Button>{pendingPath && <><Button size="sm" disabled={working} onClick={() => setOperation('path')}>确定</Button><Button size="sm" variant="ghost" disabled={working} onClick={() => setPendingPath('')}>取消</Button></>}</>), action('backup', '完整备份', '导出'), action('restore', '从备份恢复', '选择')] }, { title: '维护', rows: [action('reindex', '向量索引', '重建'), action('cache', '缓存', '清理'), action('trash', '回收站', '清空')] }] },
    ];
    const needle = query.trim().toLowerCase();
    const visible = panels.filter(panel => needle || panel.id === section).map(panel => ({ ...panel, groups: panel.groups.map(group => ({ ...group, rows: group.rows.filter(element => !needle || `${SECTIONS.find(s => s.id === panel.id)?.name} ${group.title} ${element.props.children?.[0]?.props?.children ?? ''} ${element.props.id ?? ''} ${String(element.props.id ?? '').includes('Language') ? '中文 英文 语言' : ''}`.toLowerCase().includes(needle) || needle === 'api' && panel.id === 'ai' || needle === '宠物' && panel.id === 'companion') })).filter(group => group.rows.length) })).filter(panel => panel.groups.length);
    return <div className="flex min-h-0 w-full flex-1 bg-zp-subtle">
    <aside className="w-60 shrink-0 overflow-y-auto border-r border-zp-border px-4 py-7"><h1 className="mb-6 px-3 text-xl font-semibold">设置</h1><label className="mb-6 flex items-center gap-2 rounded-full bg-zp-surface-hover px-3 py-2"><Search size={17} className="text-zp-tertiary"/><input aria-label="搜索设置" value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none"/>{query && <button aria-label="清空设置搜索" onClick={() => setQuery('')}><X size={14}/></button>}</label><nav className="space-y-1">{SECTIONS.map(s => <button key={s.id} onClick={() => { setSection(s.id); setQuery(''); setError(null); setActionStatus(''); setReindexResult(null); }} className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm ${section === s.id && !needle ? 'bg-zp-surface-hover text-zp-primary' : 'text-zp-secondary hover:bg-zp-surface-hover'}`}><s.icon size={18}/>{s.name}</button>)}</nav></aside>
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 py-10"><div className="mx-auto max-w-[860px]"><h2 className="mb-8 text-2xl font-semibold">{needle ? '搜索设置' : SECTIONS.find(s => s.id === section)?.name}</h2>
      {error && <p role="alert" className="mb-5 rounded-lg border border-red-200 px-4 py-3 text-sm text-red-600">{error}</p>}
      {visible.map(panel => <section key={panel.id}>{needle && <h3 className="mt-6 text-sm text-zp-tertiary">{SECTIONS.find(s => s.id === panel.id)?.name}</h3>}{panel.groups.map(group => <div key={group.title} className="mb-7"><h3 className="mb-3 text-sm font-medium">{group.title}</h3><div className="rounded-2xl border border-zp-border bg-card px-5 dark:bg-zp-surface">{group.rows.map((element, index) => <div key={element.props.id ?? index} className="border-b border-zp-border last:border-0">{element}</div>)}</div></div>)}</section>)}
      {section === 'ai' && !needle && <Button onClick={() => { settingsRef.current = current; void handleSave(); }} disabled={saving}>保存 API 配置</Button>}
      {saved && <span role="status" className="ml-3 text-xs text-zp-tertiary">已保存</span>}
      {reindexResult && <p role="status" className="mt-4 text-sm text-zp-secondary">{reindexResult}</p>}{actionStatus && <p role="status" className="mt-4 text-sm text-zp-secondary">{actionStatus}</p>}
    </div></div>
    <Dialog open={extensionInstall} onOpenChange={setExtensionInstall}><DialogContent><DialogHeader><DialogTitle>加载浏览器扩展</DialogTitle></DialogHeader><ol className="list-decimal space-y-3 py-3 pl-5 text-sm"><li>在 Chrome / Edge 的扩展管理页开启开发者模式。</li><li>点击“加载已解压的扩展程序”，选择此文件夹。</li></ol><Input aria-label="扩展文件夹路径" readOnly value={extensionPath}/><DialogFooter><Button variant="outline" onClick={()=>void revealItemInDir(extensionPath).catch(e=>setError(String(e)))}>定位文件夹</Button><Button onClick={()=>setExtensionInstall(false)}>完成</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={missing !== null} onOpenChange={value => { if (!value)
        setMissing(null); }}><DialogContent><DialogHeader><DialogTitle>补全中文标题与摘要？</DialogTitle></DialogHeader><div className="space-y-3 py-3 text-sm"><p>全部论文，回收站除外</p><p>{missing?.filter(p => !p.title_zh?.trim()).length ?? 0} 个标题 · {missing?.filter(p => !!p.abstract?.trim() && !p.abstract_zh?.trim()).length ?? 0} 个摘要</p></div><DialogFooter><Button variant="outline" onClick={() => setMissing(null)}>保留英文</Button><Button disabled={working} onClick={async () => { setWorking(true); try {
        await enqueueMetadataTranslations(missing!.map(p => p.id));
        setMissing(null);
        setActionStatus('标题与摘要已加入后台任务');
    }
    catch (e) {
        setError(String(e));
        setMissing(null);
    }
    finally {
        setWorking(false);
    } }}>全部翻译</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={operation !== null} onOpenChange={value => { if (!value && !working)
        setOperation(null); }}><DialogContent><DialogHeader><DialogTitle>{operation === 'trash' ? '清空回收站？' : operation === 'restore' ? '从备份恢复？' : operation === 'path' ? '迁移论文库？' : operation === 'cache' ? '清理缓存？' : '重建索引？'}</DialogTitle></DialogHeader><p className="py-3 text-sm">{operation === 'trash' ? '永久删除回收站中的论文与文件。' : operation === 'restore' ? '校验备份，重启时恢复；恢复前自动备份当前论文库。' : operation === 'path' ? '复制到所选文件夹中新建的论文库，保留旧目录。' : operation === 'cache' ? '清理 DOI 查询缓存，保留论文、笔记与译文。' : '重新生成索引，保留论文与笔记。'}</p><DialogFooter><Button variant="outline" disabled={working} onClick={() => setOperation(null)}>取消</Button><Button disabled={working} onClick={() => void perform(operation!)}>{working ? '处理中…' : '确认'}</Button></DialogFooter></DialogContent></Dialog>
    <AddProviderDialog open={showAddDialog} onClose={() => { setShowAddDialog(false); setSelectedTemplate(null); }} onAdd={handleAddProvider} selectedTemplate={selectedTemplate} onSelectTemplate={setSelectedTemplate}/>
    {editingProvider && <EditProviderDialog open={showEditDialog} provider={editingProvider} onClose={() => { setShowEditDialog(false); setEditingProvider(null); }} onSave={handleUpdateProvider}/>}
  </div>;
}
function ProviderCard({ provider, isActive, onSetActive, onEdit, onDelete, }: {
    provider: ProviderConfig;
    isActive: boolean;
    onSetActive: () => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    return (<div className={`rounded-lg border p-4 ${isActive ? 'border-primary bg-primary/5' : ''}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="font-medium">{provider.name}</h3>
            {isActive && (<Badge variant="default" className="text-xs">
                <Check className="mr-1 h-3 w-3"/>
                当前使用
              </Badge>)}
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
          {!isActive && (<Button size="sm" variant="outline" onClick={onSetActive}>
              切换使用
            </Button>)}
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Edit2 className="h-4 w-4"/>
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={isActive} title={isActive ? '无法删除当前使用的 provider' : '删除'}>
            <Trash2 className="h-4 w-4"/>
          </Button>
        </div>
      </div>
    </div>);
}
function ModelInput({ id, value, suggestions, onChange, required = false, }: {
    id: string;
    value: string;
    suggestions: string[];
    onChange: (value: string) => void;
    required?: boolean;
}) {
    const listId = `${id}-suggestions`;
    return (<div className="grid gap-1.5">
      <Label htmlFor={id}>默认模型{required ? " *" : ""}</Label>
      <Input id={id} list={suggestions.length > 0 ? listId : undefined} value={value} onChange={(event) => onChange(event.target.value)} autoComplete="off"/>
      {suggestions.length > 0 && (<datalist id={listId}>
          {suggestions.map((model) => <option key={model} value={model}/>)}
        </datalist>)}
    </div>);
}
function AddProviderDialog({ open, onClose, onAdd, selectedTemplate, onSelectTemplate, }: {
    open: boolean;
    onClose: () => void;
    onAdd: (template: ProviderTemplate, apiKey: string, customBaseUrl?: string, customModel?: string) => void;
    selectedTemplate: ProviderTemplate | null;
    onSelectTemplate: (template: ProviderTemplate | null) => void;
}) {
    const [apiKey, setApiKey] = useState("");
    const [customBaseUrl, setCustomBaseUrl] = useState("");
    const [customModel, setCustomModel] = useState<string>("");
    const handleAdd = () => {
        if (!selectedTemplate || !apiKey)
            return;
        onAdd(selectedTemplate, apiKey, customBaseUrl || undefined, customModel || undefined);
        setApiKey("");
        setCustomBaseUrl("");
        setCustomModel("");
    };
    return (<Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>添加 AI Provider</DialogTitle>
          <DialogDescription>
            从模板选择或自定义配置
          </DialogDescription>
        </DialogHeader>

        {!selectedTemplate ? (<div className="grid grid-cols-2 gap-3">
            {PROVIDER_TEMPLATES.map((template) => (<button key={template.id} onClick={() => {
                    onSelectTemplate(template);
                    if (template.base_url)
                        setCustomBaseUrl(template.base_url);
                    if (template.default_model)
                        setCustomModel(template.default_model);
                }} className="flex flex-col items-start gap-2 rounded-lg border p-4 text-left hover:bg-accent transition-colors">
                <div className="font-medium">{template.name}</div>
                <div className="text-sm text-muted-foreground">{template.description}</div>
              </button>))}
          </div>) : (<div className="space-y-4">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => onSelectTemplate(null)}>
                ← 返回
              </Button>
              <span className="font-medium">{selectedTemplate.name}</span>
            </div>

            <div className="space-y-3">
              <div className="grid gap-1.5">
                <Label htmlFor="add-api-key">API Key *</Label>
                <Input id="add-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}/>
              </div>

              {selectedTemplate.provider_type === "openai-compat" && (<div className="grid gap-1.5">
                  <Label htmlFor="add-base-url">Base URL *</Label>
                  <Input id="add-base-url" value={customBaseUrl} onChange={(e) => setCustomBaseUrl(e.target.value)}/>
                </div>)}

              <ModelInput id="add-model" value={customModel} suggestions={selectedTemplate.models} onChange={setCustomModel} required/>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button onClick={handleAdd} disabled={!apiKey || (selectedTemplate.provider_type === "openai-compat" && !customBaseUrl) || !customModel}>
                添加
              </Button>
            </DialogFooter>
          </div>)}
      </DialogContent>
    </Dialog>);
}
function EditProviderDialog({ open, provider, onClose, onSave, }: {
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
    return (<Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>编辑 Provider</DialogTitle>
          <DialogDescription>{provider.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="edit-name">名称</Label>
            <Input id="edit-name" value={config.name} onChange={(e) => setConfig({ ...config, name: e.target.value })}/>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="edit-api-key">API Key</Label>
            <Input id="edit-api-key" type="password" value={config.api_key} onChange={(e) => setConfig({ ...config, api_key: e.target.value })}/>
          </div>

          {config.provider_type === "openai-compat" && (<div className="grid gap-1.5">
              <Label htmlFor="edit-base-url">Base URL</Label>
              <Input id="edit-base-url" value={config.base_url || ""} onChange={(e) => setConfig({ ...config, base_url: e.target.value || null })}/>
            </div>)}

          <ModelInput id="edit-model" value={config.default_model} suggestions={config.models} onChange={(default_model) => setConfig({ ...config, default_model })}/>
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
    </Dialog>);
}
