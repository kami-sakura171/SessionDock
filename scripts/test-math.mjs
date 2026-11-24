import { marked } from "marked";
import katex from "katex";

const MATH_RE = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\$)[^$\n]+?\$)/g;

function extractMath(input) {
  const store = [];
  const segments = input.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  const text = segments.map((seg) => {
    if (seg.startsWith("```") || (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1)) return seg;
    return seg.replace(MATH_RE, (m) => {
      const display = m.startsWith("$$") || m.startsWith("\\[");
      const tex = m.replace(/^\$\$/,"").replace(/^\$/,"").replace(/^\\\[/,"").replace(/^\\\(/,"")
        .replace(/\$\$$/,"").replace(/\$$/,"").replace(/\\\]$/,"").replace(/\\\)$/,"").trim();
      try { const html = katex.renderToString(tex, { displayMode: display, throwOnError: false }); store.push(html); return `CSMMATHTOKEN${store.length-1}END`; }
      catch { return m; }
    });
  }).join("");
  return { text, store };
}

const src = `黎曼猜想

\\[ \\zeta(s)=\\sum_{n=1}^{\\infty}\\frac{1}{n^s} \\]

**断言：实部等于 \\(1/2\\)。**也就是说

行内 $\\zeta(2)=\\pi^2/6$ 也要能渲染。

代码里的 \`\\[x\\]\` 和 $y$ 不能被动。
`;
const { text, store } = extractMath(src);
console.log("占位符数量:", store.length);
console.log("保护后片段:", text.split("\n").slice(2,4).join(" | "));
const html = marked.parse(text).replace(/CSMMATHTOKEN(\d+)END/g, (_, i) => store[+i] ?? "");
console.log("\n还原后含 katex:", html.includes('class="katex"'), "| 含 katex-display:", html.includes("katex-display"));
console.log("代码块保留反斜杠:", html.includes("\\[x\\]"));
console.log("\n前 300 字符:\n", html.slice(0, 300));
