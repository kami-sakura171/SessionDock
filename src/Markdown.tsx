import { memo, useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * 单条消息的最大渲染长度。Codex 里存在单条 939KB 的命令输出，
 * 直接丢给 markdown 解析器会把界面卡住，超出部分截断提示。
 */
const MAX_RENDER = 20000;

const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

/** 表格包一层横向滚动容器；不能在 renderer 里调 base.table，marked v18 依赖 this.parser */
const wrapTables = (html: string) =>
  html.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, "</table></div>");

const renderer = {
  /** 代码块：带语言标签和复制按钮 */
  code({ text, lang }: { text: string; lang?: string }) {
    const language = (lang || "").split(/\s+/)[0].toLowerCase();
    const clean = text.replace(/^\n+/, "").replace(/\s+$/, "");
    const known = language && hljs.getLanguage(language);
    const body = known
      ? hljs.highlight(clean, { language, ignoreIllegals: true }).value
      : escapeHtml(clean);
    const label = language || "text";
    return (
      `<div class="codeblock">` +
      `<div class="codebar"><span class="lang">${escapeHtml(label)}</span>` +
      `<button class="copy" type="button">复制</button></div>` +
      `<pre><code class="hljs">${body}</code></pre>` +
      `</div>`
    );
  },
};

/**
 * CommonMark 的强调闭合规则要求「右翼」：当 `**` 前面是标点、后面紧跟汉字时，
 * 会被判定为不能闭合，于是 `**粗体**中文` 原样输出。
 * 中文写作里这种边界极常见，这里用行内扩展放宽为：只要匹配到成对的 ** 就加粗。
 */
const strongCJK: any = {
  name: "strongCJK",
  level: "inline",
  start(src: string) {
    const i = src.indexOf("**");
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = /^\*\*([^*\n]+?)\*\*/.exec(src);
    if (!m) return undefined;
    return { type: "strong", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
  },
};

marked.use({ gfm: true, breaks: true, renderer, extensions: [strongCJK] } as any);

/**
 * marked 会把 `\[` `\(` 当转义符吃掉反斜杠，导致定界符在 DOM 里已经变成 `[` `(`，
 * KaTeX 再也认不出来。所以必须在解析之前把公式抽出来换成占位符，解析完再回填 HTML。
 * 代码块与行内代码里的 `$` / 反斜杠不参与提取。
 */
const MATH_RE = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\$)[^$\n]+?\$)/g;

function extractMath(input: string): { text: string; store: string[] } {
  const store: string[] = [];
  // 按代码段切开，只处理非代码部分
  const segments = input.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  const text = segments
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

const restoreMath = (html: string, store: string[]) =>
  html.replace(/CSMMATHTOKEN(\d+)END/g, (_, i) => store[Number(i)] ?? "");

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);

  const { html, truncated } = useMemo(() => {
    if (!text) return { html: "", truncated: false };
    const src = text.length > MAX_RENDER ? text.slice(0, MAX_RENDER) : text;
    let raw = "";
    try {
      const { text: protectedText, store } = extractMath(src);
      const parsed = wrapTables(marked.parse(protectedText, { async: false }) as string);
      // 先净化 Markdown（占位符是纯字母数字，不会被破坏），再回填 KaTeX 生成的 HTML，
      // 避免 DOMPurify 把 MathML 节点洗掉
      const clean = DOMPurify.sanitize(parsed, { FORBID_TAGS: ["style", "iframe", "form", "script"] });
      raw = restoreMath(clean, store);
    } catch {
      raw = escapeHtml(src);
    }
    return { html: raw, truncated: text.length > MAX_RENDER };
  }, [text]);

  // 代码块复制按钮：事件委托，避免给每个块单独挂 handler
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target?.classList?.contains("copy")) return;
      const code = target.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
      navigator.clipboard.writeText(code);
      target.textContent = "已复制";
      setTimeout(() => {
        target.textContent = "复制";
      }, 1200);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [html]);


  return (
    <>
      <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      {truncated && (
        <div className="hint" style={{ marginTop: 4 }}>
          仅渲染前 {MAX_RENDER.toLocaleString()} 字符（原文共 {text.length.toLocaleString()}）
        </div>
      )}
    </>
  );
});

export default Markdown;
