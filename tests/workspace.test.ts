import { expect, it } from 'vitest';
import { EMPTY_WORKSPACE, restoreWorkspace, openWorkspacePaper, closeWorkspacePaper, layoutWorkspaceTabs } from '@/lib/workspace';
it('restores only valid unique tabs and recovers invalid active selection', () => {
  expect(restoreWorkspace('{"tabs":["a","a",null,2,"b"],"active":"missing"}')).toEqual({tabs:['a','b'],active:'library',lastRead:'b'});
  expect(restoreWorkspace('null')).toEqual(EMPTY_WORKSPACE);
});
it('background opening preserves the current reading session', () => {
  const state = openWorkspacePaper(EMPTY_WORKSPACE,'a');
  expect(openWorkspacePaper(state,'b',true)).toEqual({tabs:['a','b'],active:'a',lastRead:'a'});
  expect(openWorkspacePaper(state,'a').tabs).toEqual(['a']);
});
it('closing the active paper selects its neighbor and keeps library accessible', () => {
  const state = {tabs:['a','b','c'],active:'b',lastRead:'b'};
  expect(closeWorkspacePaper(state,'b')).toEqual({tabs:['a','c'],active:'a',lastRead:'a'});
  expect(closeWorkspacePaper({tabs:['a'],active:'a',lastRead:'a'},'a')).toEqual(EMPTY_WORKSPACE);
});

it('shrinks tabs before hiding neighbors and always exposes the active paper', () => {
  const all = layoutWorkspaceTabs(['a','b','c'], 'b', 440);
  expect(all.visible).toEqual(['a','b','c']);
  expect(all.widths.b).toBe(160);
  expect(all.widths.a).toBe(140);
  const crowded = layoutWorkspaceTabs(Array.from({length:24},(_,i)=>String(i)), '20', 600);
  expect(crowded.visible).toContain('20');
  expect(crowded.visible.length).toBeLessThan(24);
  expect(Object.values(crowded.widths).reduce((a,b)=>a+b,0)).toBeLessThanOrEqual(600);
  expect(Math.min(...Object.values(crowded.widths))).toBeGreaterThanOrEqual(110);
  expect(layoutWorkspaceTabs(['a','b'], 'b', 80)).toEqual({visible:['b'],widths:{b:80}});
});

it('migrates upstream tabs without losing the active paper',async()=>{const {migrateReaderWorkspace}=await import('@/lib/workspace');expect(migrateReaderWorkspace(JSON.stringify({tabs:[{id:'one',paperId:'a'},{id:'two',paperId:'b'}],activeTabId:'two'}))).toEqual({tabs:['a','b'],active:'b',lastRead:'b'});});
