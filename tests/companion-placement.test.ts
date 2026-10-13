import { expect, it } from 'vitest';
import { companionPlacement } from '@/lib/companionPlacement';
const area={position:{x:0,y:0},size:{width:1500,height:1000}};
it('preserves the owl location while expanding downward',()=>{
  const result=companionPlacement({x:1100,y:20},area,2,350,10,10,false);
  expect(result).toEqual({flipAbove:false,x:820,y:20});
});
it('flips the bubble upward near the bottom and anchors the owl after reordering',()=>{
  expect(companionPlacement({x:1000,y:800},area,1,300,10,10,false).flipAbove).toBe(true);
  const result=companionPlacement({x:1000,y:800},area,1,300,10,210,true);
  expect(result.flipAbove).toBe(false);expect(result.y+210).toBe(810);
});
