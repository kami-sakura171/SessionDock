/**
 * 端到端校验 Markdown 渲染管线（与 src/Markdown.tsx 保持同一套规则）：
 * 公式抽取 → marked → DOMPurify → 公式回填。
 * 用法: node scripts/verify-md.mjs
 */
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { marked } from "marked";
import katex from "katex";
import hljs from "highlight.js/lib/common";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
const DOMPurify = createDOMPurify(window);

const escapeHtml = (s) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const wrapTables = (html) =>
  html.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, "</table></div>");

const renderer = {
  code({ text, lang }) {
    const language = (lang || "").split(/\s+/)[0].toLowerCase();
    const clean = text.replace(/^\n+/, "").replace(/\s+$/, "");
    const known = language && hljs.getLanguage(language);
    const body = known ? hljs.highlight(clean, { language, ignoreIllegals: true }).value : escapeHtml(clean);
    return `<div class="codeblock"><div class="codebar"><span class="lang">${escapeHtml(language || "text")}</span><button class="copy" type="button">复制</button></div><pre><code class="hljs">${body}</code></pre></div>`;
  },
};

const strongCJK = {
  name: "strongCJK",
  level: "inline",
  start(src) {
    const i = src.indexOf("**");
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^\*\*([^*\n]+?)\*\*/.exec(src);
    if (!m) return undefined;
    return { type: "strong", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
  },
};

marked.use({ gfm: true, breaks: true, renderer, extensions: [strongCJK] });

const MATH_RE = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\$)[^$\n]+?\$)/g;

function extractMath(input) {
  const store = [];
  const text = input
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((seg) => {
      if (seg.startsWith("```") || (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1)) return seg;
      return seg.replace(MATH_RE, (m) => {
        const display = m.startsWith("$$") || m.startsWith("\\[");
        const tex = m
          .replace(/^\$\$/, "")
          .replace(/^\$/, "")
          .replace(/^\\\[/, "")
          .replace(/^\\\(/, "")
          .replace(/\$\$$/, "")
          .replace(/\$$/, "")
          .replace(/\\\]$/, "")
          .replace(/\\\)$/, "")
          .trim();
        try {
          const html = katex.renderToString(tex, { displayMode: display, throwOnError: false });
          store.push(html);
          return `CSMMATHTOKEN${store.length - 1}END`;
        } catch {
          return m;
        }
      });
    })
    .join("");
  return { text, store };
}

const restoreMath = (html, store) =>
  html.replace(/CSMMATHTOKEN(\d+)END/g, (_, i) => store[Number(i)] ?? "");

const SAMPLE = `## 黎曼猜想

ζ函数定义为：

\\[ \\zeta(s)=\\sum_{n=1}^{\\infty}\\frac{1}{n^s} \\]

**黎曼猜想断言：所有非平凡零点的实部都等于 \\(1/2\\)。**也就是说

行内 $\\zeta(2)=\\pi^2/6$ 要能渲染。

\`\`\`python
# 这里的 \$x 和 \\[y\\] 不能被当成公式
print("hi")
\`\`\`
`;

const { text: protectedText, store } = extractMath(SAMPLE);
const parsed = wrapTables(marked.parse(protectedText, { async: false }));
const clean = DOMPurify.sanitize(parsed, { FORBID_TAGS: ["style", "iframe", "form", "script"] });
const html = restoreMath(clean, store);
const doc = new JSDOM(`<body>${html}</body>`).window.document;

// 正文（排除代码块）不应残留任何公式定界符
const prose = doc.body.cloneNode(true);
prose.querySelectorAll("pre, code").forEach((n) => n.remove());
const proseText = prose.textContent;

const checks = [
  ["占位符已全部回填", !html.includes("CSMMATHTOKEN")],
  ["块级公式渲染", doc.querySelectorAll(".katex-display").length >= 1],
  ["行内公式渲染", doc.querySelectorAll(".katex").length >= 2],
  ["正文无裸定界符", !proseText.includes("\\[") && !proseText.includes("\\(") && !proseText.includes("\\]")],
  ["中文粗体生效", doc.querySelectorAll("strong").length === 1],
  ["代码块保留反斜杠", doc.querySelector("pre code").textContent.includes("\\[y\\]")],
  ["代码块未渲染公式", doc.querySelectorAll("pre .katex").length === 0],
  ["代码高亮有 span", doc.querySelectorAll("pre code .hljs-keyword, pre code .hljs-comment").length >= 1],
];

let pass = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
