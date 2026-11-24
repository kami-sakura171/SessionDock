/**
 * 离屏渲染 Markdown 预览并截图，用来检查排版效果。
 * 用法: node scripts/shot.js  → 生成 /tmp/md-shot.png
 */
const fs = require("node:fs");
const path = require("node:path");
const { marked } = require("marked");
const hljs = require("highlight.js/lib/common");
const katex = require("katex");

const ROOT = path.join(__dirname, "..");
const cssFile = fs
  .readdirSync(path.join(ROOT, "dist", "assets"))
  .find((f) => f.endsWith(".css"));
const css = fs.readFileSync(path.join(ROOT, "dist", "assets", cssFile), "utf8");

const mathSample = `
## 黎曼猜想

黎曼猜想是关于黎曼ζ函数的非平凡零点位置的猜想。

ζ函数可以先在实部大于 1 时定义为：

\\[ \\zeta(s)=\\sum_{n=1}^{\\infty}\\frac{1}{n^s} \\]

再通过解析延拓扩展到复数范围。**黎曼猜想断言：所有非平凡零点的实部都等于 \\(1/2\\)。**也就是说，它们都位于直线

\\[ \\operatorname{Re}(s)=\\frac{1}{2} \\]

这条线叫“临界线”。单行公式形如 $\\zeta(2)=\\pi^2/6$ 也要能渲染。
`;

const sample = mathSample + `# 性能分析结论

这段是**普通段落**，包含 \`inline code\`、[链接](https://example.com)，以及 *斜体*。
第二行紧跟着，用来检查行距是否舒服。

## 1. baseline 性能瓶颈

- 矩阵乘法占了 62% 的时间
- 数据搬运占了 21%
- 其余是框架开销

1. 先看 profiler
2. 再看 kernel 实现
3. 最后对比 cuBLAS

### 代码块

\`\`\`python
import torch

def attention(q, k, v, mask=None):
    scale = q.shape[-1] ** -0.5
    scores = torch.matmul(q, k.transpose(-2, -1)) * scale
    if mask is not None:
        scores = scores.masked_fill(mask == 0, float("-inf"))
    return torch.matmul(torch.softmax(scores, dim=-1), v)
\`\`\`

### 表格

| 方案 | 耗时 | 相对提升 | 备注 |
|---|---|---|---|
| baseline | 128.4 ms | — | 原始实现 |
| v1 | 96.2 ms | 25% | 合并访存 |
| v2 | 61.7 ms | 52% | 使用 shared memory |

> 注意：以上数据来自 A100，单卡，batch=8。

---

结论：v2 已经接近理论上限，继续优化收益有限。
`;

const escapeHtml = (x) => x.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const strongCJK = {
  name: "strongCJK",
  level: "inline",
  start(src) { const i = src.indexOf("**"); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\*\*([^*\n]+?)\*\*/.exec(src);
    if (!m) return undefined;
    return { type: "strong", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
  },
};

const wrapTables = (html) => html.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, "</table></div>");
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = (lang || "").split(/\s+/)[0].toLowerCase();
      const clean = text.replace(/^\n+/, "").replace(/\s+$/, "");
      const known = language && hljs.getLanguage(language);
      const body = known ? hljs.highlight(clean, { language, ignoreIllegals: true }).value : escapeHtml(clean);
      return `<div class="codeblock"><div class="codebar"><span class="lang">${escapeHtml(language || "text")}</span><button class="copy" type="button">复制</button></div><pre><code class="hljs">${body}</code></pre></div>`;
    },
  },
  extensions: [strongCJK],
});
const renderMath = (src) =>
  src
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }))
    .replace(/\$(?!\$)([^$\n]+?)\$/g, (_, tex) => katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }));

const body = wrapTables(marked.parse(renderMath(sample), { gfm: true, breaks: true }));

let katexCss = fs.readFileSync(path.join(ROOT, "node_modules", "katex", "dist", "katex.min.css"), "utf8");
const fontBase = "file:///" + path.join(ROOT, "node_modules", "katex", "dist").replace(/\\/g, "/") + "/";
katexCss = katexCss.replace(/url\(fonts\//g, "url(" + fontBase + "fonts/");

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}${katexCss}
body{background:#fff;padding:0;margin:0}
.frame{display:flex;height:100vh}
.drawer{width:100%;max-width:none;border-left:0}
.drawer-body{padding:18px 22px}
</style></head><body>
<div class="frame"><aside class="drawer"><div class="drawer-head" style="height:auto">
<div class="drawer-top"><h3>注意力 kernel 性能分析</h3></div>
<div class="mono">D:\\LLM\\FlagGems_test\\FlagGems</div>
</div><div class="drawer-body"><div class="msg assistant"><div class="who">助手</div><div class="md">${body}</div></div></div></aside></div>
</body></html>`;

fs.writeFileSync(path.join(ROOT, ".md-preview.html"), html, "utf8");
console.log("html 已生成");
