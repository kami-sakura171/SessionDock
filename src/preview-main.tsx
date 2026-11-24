import ReactDOM from "react-dom/client";
import Markdown from "./Markdown";
import "./styles.css";

const SAMPLE = `## 黎曼猜想

黎曼猜想是关于黎曼ζ函数的非平凡零点位置的猜想。

ζ函数可以先在实部大于 1 时定义为：

\\[ \\zeta(s)=\\sum_{n=1}^{\\infty}\\frac{1}{n^s} \\]

再通过解析延拓扩展到复数范围。**黎曼猜想断言：所有非平凡零点的实部都等于 \\(1/2\\)。**也就是说

\\[ \\operatorname{Re}(s)=\\frac{1}{2} \\]

行内公式 $\\zeta(2)=\\pi^2/6$ 也要能渲染。

\`\`\`python
def f(x):
    return \\$x  # 这里的符号不该被当成公式
\`\`\`
`;

ReactDOM.createRoot(document.getElementById("preview")!).render(
  <div className="frame" style={{ padding: 20, background: "#fff" }}>
    <div className="md">
      <Markdown text={SAMPLE} />
    </div>
  </div>
);
