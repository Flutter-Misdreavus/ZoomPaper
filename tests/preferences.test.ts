import {afterEach,expect,it} from 'vitest';
import {getPreferences,setPreferences,paperTitle,missingMetadata,DEFAULT_PREFERENCES} from '@/lib/preferences';
afterEach(()=>localStorage.clear());
it('validates saved preferences and supports independent title languages',()=>{
 localStorage.setItem('zoompaper.preferences',JSON.stringify({restoreTabs:'false',titleLanguage:'invalid',petTasks:false}));expect(getPreferences()).toEqual({...DEFAULT_PREFERENCES,petTasks:false});
 setPreferences({titleLanguage:'zh',tabLanguage:'original'});const p={title:'Original',title_zh:'中文'};expect(paperTitle(p,'library')).toBe('中文');expect(paperTitle(p,'tab')).toBe('Original');setPreferences({detailLanguage:'both'});expect(paperTitle(p,'detail')).toBe('中文 / Original');expect(paperTitle({...p,title_zh:' '},'library')).toBe('Original');
});
it('counts missing title or abstract translations without including trash',()=>{
 expect(missingMetadata([{id:'a',title_zh:'',abstract:null},{id:'b',title_zh:'中文',abstract:'Text',abstract_zh:null},{id:'c',title_zh:null,deleted_at:1},{id:'d',title_zh:'中文',abstract:null}] as any).map(p=>p.id)).toEqual(['a','b']);
});
it('exports only view preferences, excluding keys and job payloads',async()=>{
 const {exportViewPreferences,isViewPreferenceKey}=await import('@/lib/preferences');localStorage.setItem('zoompaper.api_key','SECRET');localStorage.setItem('zoompaper.companion.tasks','private tasks');localStorage.setItem('zoompaper.workspace','{}');localStorage.setItem('zoompaper:page:p','3');expect(exportViewPreferences()).toEqual({'zoompaper.workspace':'{}','zoompaper:page:p':'3'});expect(isViewPreferenceKey('zoompaper.workspace.evil')).toBe(false);
});
