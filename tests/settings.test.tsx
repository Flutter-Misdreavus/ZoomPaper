import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';import{afterEach,expect,it,vi}from'vitest';import{SettingsPage}from'@/pages/Settings';
const mocks=vi.hoisted(()=>({save:vi.fn(async(s:any)=>s),enqueue:vi.fn().mockResolvedValue(undefined),reveal:vi.fn().mockResolvedValue(undefined),folder:vi.fn(),invoke:vi.fn(async(command:string,args?:any)=>command==='library_storage_path'?'/test/papers':command==='prepare_browser_extension'?'/test/extension':command==='relocate_library'?{providers:[],active_provider_id:'',mineru_api_key:'',web_search_provider:'auto',web_search_model:null,paper_library_path:args.destination+'/ZoomPaper-library'}:false)}));
vi.mock('@/lib/api',()=>({listCustomThemes:async()=>[],getThemesDir:async()=>"/test/themes",getSettings:async()=>({providers:[],active_provider_id:'',mineru_api_key:'',web_search_provider:'auto',web_search_model:null,paper_library_path:null}),updateSettings:mocks.save,listPapers:async()=>[{id:'a',title:'A',title_zh:null,abstract:'Text',abstract_zh:null}],listJobs:async()=>[],enqueueMetadataTranslations:mocks.enqueue,emptyTrash:vi.fn(),reindexAllPapers:vi.fn(),addProvider:vi.fn(),updateProvider:vi.fn(),deleteProvider:vi.fn(),setActiveProvider:vi.fn(),generateBlog:vi.fn(),translateChunk:vi.fn(),saveTranslation:vi.fn(),DEFAULT_WORKFLOW:{autoParse:true,parseConcurrency:2,autoDoi:true,autoMetadataTranslation:true,autoFullTranslation:false}}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));vi.mock('@tauri-apps/plugin-dialog',()=>({open:mocks.folder}));vi.mock('@tauri-apps/plugin-opener',()=>({revealItemInDir:mocks.reveal}));
afterEach(()=>{cleanup();localStorage.clear();vi.clearAllMocks();});
it('offers the approved categories without task notifications or help icons',async()=>{
 render(<SettingsPage/>);await screen.findByLabelText('统一标题语言');expect(screen.getByRole('navigation').querySelectorAll('button')).toHaveLength(6);fireEvent.click(screen.getByRole('button',{name:'阅读伙伴'}));expect(screen.getByLabelText('显示正在阅读')).toBeTruthy();expect(screen.queryByText('任务通知')).toBeNull();expect(screen.queryByText('i')).toBeNull();
});
it('preserves English without issuing requests and enqueues a confirmed batch',async()=>{
 render(<SettingsPage/>);await screen.findByLabelText('统一标题语言');fireEvent.click(screen.getByLabelText('统一标题语言'));{const option=await screen.findByRole('option',{name:'中英双语'});fireEvent.pointerDown(option);fireEvent.click(option);}await screen.findByText('补全中文标题与摘要？');fireEvent.click(screen.getByText('保留英文'));expect(mocks.enqueue).not.toHaveBeenCalled();fireEvent.click(screen.getByLabelText('统一标题语言'));{const option=await screen.findByRole('option',{name:'中文'});fireEvent.pointerDown(option);fireEvent.click(option);}await screen.findByText('补全中文标题与摘要？');fireEvent.click(screen.getByText('全部翻译'));await waitFor(()=>expect(mocks.enqueue).toHaveBeenCalledWith(['a']));
});
it('validates and saves a custom concurrency value',async()=>{
 render(<SettingsPage/>);await screen.findByLabelText('统一标题语言');fireEvent.click(screen.getByRole('button',{name:'导入与解析'}));const input=screen.getByLabelText('同时解析论文数');fireEvent.change(input,{target:{value:'8'}});fireEvent.blur(input);await waitFor(()=>expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({workflow:expect.objectContaining({parseConcurrency:8})})));mocks.save.mockClear();fireEvent.change(input,{target:{value:'0'}});fireEvent.blur(input);expect(mocks.save).not.toHaveBeenCalled();expect(screen.getByRole('alert').textContent).toContain('正整数');
});
it('searches language settings by Chinese keywords across categories',async()=>{
 render(<SettingsPage/>);await screen.findByLabelText('统一标题语言');fireEvent.change(screen.getByLabelText('搜索设置'),{target:{value:'中文'}});expect(screen.getByLabelText('论文标签标题')).toBeTruthy();expect(screen.queryByLabelText('同时解析论文数')).toBeNull();
});

it('shows only three language choices using the library select',async()=>{
 render(<SettingsPage/>);const trigger=await screen.findByLabelText('统一标题语言');expect(trigger.getAttribute('data-slot')).toBe('select-trigger');fireEvent.click(trigger);await screen.findByRole('option',{name:'英文'});expect(screen.getAllByRole('option').map(e=>e.textContent)).toEqual(['英文','中文','中英双语']);
});
it('auto-saves MinerU and confines extension feedback to its dialog',async()=>{
 render(<SettingsPage/>);await screen.findByLabelText('统一标题语言');fireEvent.click(screen.getByRole('button',{name:'导入与解析'}));expect(screen.queryByText('保存 API 配置')).toBeNull();const input=screen.getByLabelText('MinerU API Key');fireEvent.change(input,{target:{value:'new-key'}});fireEvent.blur(input);await waitFor(()=>expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({mineru_api_key:'new-key'})));fireEvent.click(screen.getByRole('button',{name:'加载扩展'}));await screen.findByText('加载浏览器扩展');expect(mocks.reveal).toHaveBeenCalledWith('/test/extension');fireEvent.click(screen.getByRole('button',{name:'完成'}));fireEvent.click(screen.getByRole('button',{name:'数据与存储'}));await waitFor(()=>expect((screen.getByLabelText('论文库存储路径') as HTMLInputElement).value).toBe('/test/papers'));expect(screen.getByRole('button',{name:'选择文件夹'})).toBeTruthy();expect(screen.queryByText('/test/extension')).toBeNull();
});

it('chooses a path without migration, confirms only after committing, and restores directly',async()=>{
 render(<SettingsPage/>);await screen.findByLabelText('统一标题语言');fireEvent.click(screen.getByRole('button',{name:'数据与存储'}));mocks.folder.mockResolvedValueOnce('/new');fireEvent.click(screen.getByRole('button',{name:'选择文件夹'}));await screen.findByRole('button',{name:'确定'});expect(screen.queryByText('迁移论文库？')).toBeNull();expect(mocks.invoke.mock.calls.some(([command])=>command==='relocate_library')).toBe(false);fireEvent.click(screen.getByRole('button',{name:'确定'}));await screen.findByText('迁移论文库？');fireEvent.click(screen.getByRole('button',{name:'确认'}));await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('relocate_library',{destination:'/new'}));mocks.folder.mockResolvedValueOnce('/backup');fireEvent.click(screen.getByRole('button',{name:'选择'}));await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('stage_library_restore',expect.objectContaining({source:'/backup'})));expect(screen.queryByText('从备份恢复？')).toBeNull();
});
it('shows format errors from backup validation',async()=>{
 render(<SettingsPage/>);await screen.findByLabelText('统一标题语言');fireEvent.click(screen.getByRole('button',{name:'数据与存储'}));mocks.folder.mockResolvedValueOnce('/bad-backup');mocks.invoke.mockImplementationOnce(async()=>{throw new Error('请选择 ZoomPaper 导出的备份文件夹');});fireEvent.click(screen.getByRole('button',{name:'选择'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('备份文件夹'));
});

it('integrates theme selection into existing settings and persists a custom color',async()=>{
 render(<SettingsPage/>);const trigger=await screen.findByLabelText('主题配色');fireEvent.click(trigger);
 const dark=await screen.findByRole('option',{name:'深色'});fireEvent.pointerDown(dark);fireEvent.click(dark);
 expect(document.documentElement.classList.contains('dark')).toBe(true);
 await waitFor(()=>expect(screen.queryByRole('option',{name:'自定义'})).toBeNull());
 fireEvent.click(screen.getByLabelText('主题配色'));const custom=await screen.findByRole('option',{name:'自定义'});fireEvent.pointerDown(custom);fireEvent.click(custom);
 fireEvent.change(await screen.findByLabelText('自定义主色'),{target:{value:'#123456'}});
 expect(JSON.parse(localStorage.getItem('zoompaper.theme')!).customColor).toBe('#123456');
 expect(document.documentElement.classList.contains('dark')).toBe(false);
 fireEvent.change(screen.getByLabelText('搜索设置'),{target:{value:'主题'}});expect(screen.getByLabelText('主题配色')).toBeTruthy();
 expect(screen.queryByText('高级主题（JSON）')).toBeNull();
});
