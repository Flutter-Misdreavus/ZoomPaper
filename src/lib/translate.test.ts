import { describe, expect, it } from "vitest";
import {
  buildZhDoc,
  chunkMarkdown,
  pairChunks,
  splitBlocks,
  splitReferences,
  stripStandaloneImagesAndMath,
} from "@/lib/translate";
import type { TranslationChunk } from "@/lib/api";

// ---------- 基础切分 ----------

describe("splitBlocks", () => {
  it("按空行切块，去首尾空行", () => {
    expect(splitBlocks("\n\np1\n\np2\n\n")).toEqual(["p1", "p2"]);
  });

  it("不切分围栏代码块与公式块内部", () => {
    const md = "a\n\n```\nx\n\ny\n```\n\nb";
    expect(splitBlocks(md)).toEqual(["a", "```\nx\n\ny\n```", "b"]);
  });
});

// ---------- Phase 1：无内容丢失 ----------

describe("pairChunks 无内容丢失", () => {
  it("等段数：全部 1:1 配对，无 rest", () => {
    const r = pairChunks([
      { en: "p1\n\np2", zh: "t1\n\nt2" },
      { en: "p3", zh: "t3" },
    ]);
    expect(r.pairs).toEqual([
      { en: "p1", zh: "t1" },
      { en: "p2", zh: "t2" },
      { en: "p3", zh: "t3" },
    ]);
    expect(r.restEn).toEqual([]);
    expect(r.restZh).toEqual([]);
  });

  it("中文多余段完整保留（不静默丢弃）", () => {
    const zh = "t1\n\nt2\n\nt3";
    const r = pairChunks([{ en: "p1\n\np2", zh }]);
    // 配对译文 + 多余译文逐字覆盖全部中文块（块级多集相等，一段不丢）
    const zhAll = [...r.pairs.map((p) => p.zh), ...r.restZh].join("\n\n");
    expect(splitBlocks(zhAll).sort()).toEqual(splitBlocks(zh).sort());
    expect(r.pairs.length + r.restZh.length).toBe(3);
  });

  it("英文多余段完整保留", () => {
    const en = "p1\n\np2\n\np3";
    const r = pairChunks([{ en, zh: "t1" }]);
    const enAll = [...r.pairs.map((p) => p.en), ...r.restEn].join("\n\n");
    expect(splitBlocks(enAll).sort()).toEqual(splitBlocks(en).sort());
    expect(r.pairs).toHaveLength(1);
    expect(r.restEn).toHaveLength(2);
    expect(r.restZh).toEqual([]);
  });

  it("restZh 保留多行块（含围栏代码）原文，逐字不丢", () => {
    const zh = "t1\n\n```\ncode block\n```\n\nt2";
    const r = pairChunks([{ en: "p1", zh }]);
    const zhAll = [...r.pairs.map((p) => p.zh), ...r.restZh].join("\n\n");
    expect(splitBlocks(zhAll).sort()).toEqual(splitBlocks(zh).sort());
  });
});

// ---------- Phase 2：对齐算法 ----------

describe("pairChunks 块级锚定（无全局级联）", () => {
  it("中间块缺段：只影响该块，后续块配对不受影响", () => {
    const chunks: TranslationChunk[] = [
      { en: "C1A.\n\nC1B.", zh: "T1A。\n\nT1B。" },
      // 第二个翻译块缺一个中文段（T2B 缺失）
      { en: "C2A.\n\nC2B.\n\nC2C.", zh: "T2A。\n\nT2C。" },
      { en: "C3A.\n\nC3B.", zh: "T3A。\n\nT3B。" },
    ];
    const r = pairChunks(chunks);
    // 总配对 2+2+2，缺段只产生 1 个 restEn，且落在块 2 内
    expect(r.pairs).toHaveLength(6);
    expect(r.restEn).toHaveLength(1);
    expect(r.restZh).toHaveLength(0);
    // 块 3 的配对完全不受块 2 缺段影响（旧算法此处会整体错位）
    expect(r.pairs[4]).toEqual({ en: "C3A.", zh: "T3A。" });
    expect(r.pairs[5]).toEqual({ en: "C3B.", zh: "T3B。" });
  });

  it("块内缺段：靠长度信号把缺口定位在明显更长的段上", () => {
    const r = pairChunks([
      {
        en: "Short one.\n\nThis is a considerably longer second paragraph with lots of words to clearly dominate in length.\n\nShort three.",
        zh: "短一。\n\n短三。",
      },
    ]);
    expect(r.pairs).toEqual([
      { en: "Short one.", zh: "短一。" },
      { en: "Short three.", zh: "短三。" },
    ]);
    expect(r.restEn).toEqual([
      "This is a considerably longer second paragraph with lots of words to clearly dominate in length.",
    ]);
  });
});

describe("pairChunks 合段 / 拆段", () => {
  it("中文合段：合并译文就近配到短段，长段进 restEn，不跨块错位", () => {
    const r = pairChunks([
      {
        en: "Short first.\n\nA much longer second paragraph with plenty of extra words to make it clearly the longest block here by a wide margin.",
        zh: "合并译文长度适中。",
      },
    ]);
    expect(r.pairs).toEqual([
      { en: "Short first.", zh: "合并译文长度适中。" },
    ]);
    expect(r.restEn).toEqual([
      "A much longer second paragraph with plenty of extra words to make it clearly the longest block here by a wide margin.",
    ]);
  });

  it("中文拆段：相邻中文段合并为一个译文组配对，不产生多余 rest", () => {
    const r = pairChunks([
      { en: "One single paragraph.", zh: "拆出的第一小段。\n\n拆出的第二小段。" },
    ]);
    expect(r.pairs).toEqual([
      {
        en: "One single paragraph.",
        zh: "拆出的第一小段。\n\n拆出的第二小段。",
      },
    ]);
    expect(r.restEn).toEqual([]);
    expect(r.restZh).toEqual([]);
  });
});

describe("pairChunks 锚点", () => {
  it("标题锚：标题按序配对，其后的缺段只影响本标题区间", () => {
    const r = pairChunks([
      {
        en: "## Intro\n\nPara one.\n\nPara two is a longer paragraph with extra words.",
        zh: "## 引言\n\n第一段。",
      },
    ]);
    expect(r.pairs).toEqual([
      { en: "## Intro", zh: "## 引言" },
      { en: "Para one.", zh: "第一段。" },
    ]);
    expect(r.restEn).toEqual([
      "Para two is a longer paragraph with extra words.",
    ]);
  });

  it("公式锚：$f(x)=x^2$ 原样保留命中 → 公式段正确配对，缺失段进 restEn", () => {
    const r = pairChunks([
      {
        en: "First paragraph plain.\n\nWe define $f(x)=x^2$ here.\n\nThird paragraph plain.",
        zh: "第一段。\n\n我们在此定义 $f(x)=x^2$。",
      },
    ]);
    expect(r.pairs).toEqual([
      { en: "First paragraph plain.", zh: "第一段。" },
      { en: "We define $f(x)=x^2$ here.", zh: "我们在此定义 $f(x)=x^2$。" },
    ]);
    expect(r.restEn).toEqual(["Third paragraph plain."]);
  });

  it("Figure 引用锚：Figure 1 命中 → 对应段正确配对", () => {
    const r = pairChunks([
      {
        en: "Method overview.\n\nAs shown in Figure 1 the pipeline runs end to end.\n\nPlain ending paragraph here.",
        zh: "方法总览。\n\n如图 Figure 1 所示，流水线端到端运行。",
      },
    ]);
    expect(r.pairs).toContainEqual({
      en: "As shown in Figure 1 the pipeline runs end to end.",
      zh: "如图 Figure 1 所示，流水线端到端运行。",
    });
    expect(r.restEn).toEqual(["Plain ending paragraph here."]);
  });
});

describe("pairChunks 边界与稳定性", () => {
  it("空中文块：全部英文段进 restEn", () => {
    const r = pairChunks([
      { en: "Only english one.\n\nOnly english two.", zh: "" },
    ]);
    expect(r.pairs).toEqual([]);
    expect(r.restEn).toEqual(["Only english one.", "Only english two."]);
  });

  it("纯公式块不参与错配：整块公式视为 math 块", () => {
    const r = pairChunks([
      { en: "Text before.\n\n$$\nx + y\n$$\n\nText after.", zh: "文前。\n\n$$\nx + y\n$$\n\n文后。" },
    ]);
    expect(r.pairs.map((p) => p.en)).toEqual([
      "Text before.",
      "$$\nx + y\n$$",
      "Text after.",
    ]);
    expect(r.restEn).toEqual([]);
    expect(r.restZh).toEqual([]);
  });

  it("确定性：同输入两次输出深相等", () => {
    const chunks: TranslationChunk[] = [
      { en: "C1A.\n\nC1B.", zh: "T1A。\n\nT1B。" },
      { en: "C2A.\n\nC2B.\n\nC2C.", zh: "T2A。\n\nT2C。" },
    ];
    expect(pairChunks(chunks)).toEqual(pairChunks(chunks));
  });
});

// ---------- 翻译流程基础（供对照对齐使用） ----------

describe("翻译流程基础函数", () => {
  it("chunkMarkdown：低于阈值整块产出，超阈值在段落边界断块", () => {
    expect(chunkMarkdown("a\n\nb\n\nc", 2500)).toEqual(["a\n\nb\n\nc"]);
    const long = Array.from(
      { length: 20 },
      (_, i) => `paragraph ${i} with some filler text`,
    ).join("\n\n");
    const chunks = chunkMarkdown(long, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });

  it("buildZhDoc 用空行拼接各块译文", () => {
    const chunks: TranslationChunk[] = [
      { en: "a", zh: "甲" },
      { en: "b", zh: "乙" },
    ];
    expect(buildZhDoc(chunks)).toBe("甲\n\n乙");
  });

  it("splitReferences 分离正文与参考文献", () => {
    const { body, references } = splitReferences(
      "# Title\n\nbody text\n\n## References\n\n[1] a",
    );
    expect(body).toContain("body text");
    expect(references).toContain("[1] a");
  });

  it("stripStandaloneImagesAndMath 只删整块公式与单独成行的图片，保留行内公式", () => {
    const md = "text $x$ inline\n\n$$x+y$$\n\n![](img.png)\n\nend $y$";
    const out = stripStandaloneImagesAndMath(md);
    expect(out).toContain("text $x$ inline");
    expect(out).not.toContain("$x+y$");
    expect(out).not.toContain("img.png");
    expect(out).toContain("end $y$");
  });
});
