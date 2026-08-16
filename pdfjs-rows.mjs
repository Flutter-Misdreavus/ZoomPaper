import * as pdfjs from "./node_modules/pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";

async function resolvePage(dest, doc) {
  try {
    const d = Array.isArray(dest) ? dest : await doc.getDestination(dest);
    if (!d || d.length === 0 || d[0] == null) return null;
    const ref = d[0];
    return typeof ref === "number" ? ref - 1 : await doc.getPageIndex(ref);
  } catch { return null; }
}

for (const f of [
  "/Users/fafa/Library/Application Support/com.paper-reader/papers/431124bb-cd3d-4599-9ebb-4479c16db769/paper.pdf",
  "/Users/fafa/Library/Application Support/com.paper-reader/papers/f4605a5c-50e5-4b29-9f75-75c1fa62576d/paper.pdf",
]) {
  const data = new Uint8Array(readFileSync(f));
  const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
  const outline = await doc.getOutline();
  console.log(`\n===== ${f.split("/").slice(-3, -2)[0]} =====`);
  const stack = [...(outline ?? [])];
  let n = 0;
  while (stack.length) {
    const node = stack.pop();
    n++;
    if (node.items?.length) stack.push(...node.items);
    // 模拟 renderOutlineNodes 的最终可见文本：title + 页码徽标（get(node)+1）
    let badge = "";
    if (node.dest) {
      const p = await resolvePage(node.dest, doc);
      if (p != null) badge = String(p + 1);
    }
    const row = `[${node.title}]${badge ? ` →${badge}` : ""}`;
    const hasZero = /0/.test(node.title) || badge === "0";
    console.log(`${hasZero ? "!! " : "   "}${row}`);
  }
  console.log(`rows = ${n}`);
}
