/** Keep the owl at its screen position when its bubble grows or changes sides. */
export function companionPlacement(position: {x:number;y:number}, area: {position:{x:number;y:number};size:{width:number;height:number}}, scale: number, height: number, previousAnchor: number, anchor: number, above: boolean) {
  const desiredY = position.y + (previousAnchor-anchor)*scale;
  const flipAbove = !above && desiredY+height*scale > area.position.y+area.size.height;
  return { flipAbove, x: Math.max(area.position.x,Math.min(position.x,area.position.x+area.size.width-340*scale)), y: Math.max(area.position.y,Math.min(desiredY,area.position.y+area.size.height-height*scale)) };
}
