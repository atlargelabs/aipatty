import type katexApi from "katex";
import type { MarkdownIt, RendererRule, StateBlock, StateInline } from "markdown-it";

const closing: Readonly<Record<string, string>> = { "\\(": "\\)", "\\[": "\\]", "$": "$", "$$": "$$" };
const maxMathLength = 4096;

function displayOpener(src: string, start: number, end: number): string | undefined {
  if (start + 2 > end) return;
  if (src.startsWith("\\[", start)) return "\\[";
  if (src.startsWith("$$", start) && src[start + 2] !== "$") return "$$";
}

/** Find the first unescaped closer. Leave Markdown's code spans and link label boundaries to its own rules. */
function findClose(
  src: string, start: number, end: number, close: string, mode: "block" | "display" | "inline" = "block", inLabel = false,
): number {
  let brackets = 0;
  for (let pos = start; pos < end; pos++) {
    const ch = src[pos];
    if ((mode === "inline" && ch === "\n") || (mode !== "block" && ch === "`")) break;
    if (pos + close.length <= end && src.startsWith(close, pos)) return pos;
    if (ch === "\\" && src[pos + 1] !== "\n") pos++;
    else if (inLabel && ch === "[") brackets++;
    else if (inLabel && ch === "]" && brackets-- === 0) break;
  }
  return -1;
}

function escapedAt(src: string, pos: number): boolean {
  let first = pos;
  while (src[first - 1] === "\\") first--;
  return (pos - first) % 2 === 1;
}

function inlineMath(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state;
  if (src[pos] === "$" && src[pos - 1] === "$" && !escapedAt(src, pos - 1)) return false;
  const display = displayOpener(src, pos, posMax);
  const open = display ?? (src.startsWith("\\(", pos) ? "\\(" : src[pos] === "$" && src[pos + 1] !== "$" ? "$" : undefined);
  if (!open) return false;
  const from = pos + open.length;
  if (open === "$" && /\s/.test(src[from] ?? "")) return false;
  const close = closing[open];
  const end = findClose(src, from, Math.min(posMax, from + maxMathLength + close.length), close, display ? "display" : "inline", silent);
  if (end < 0) return false;
  const after = end + close.length;
  const tex = src.slice(from, end);
  if (!tex.trim() || (src[end] === "$" && src[after] === "$")) return false;
  if (open === "$") {
    const next = src[after] ?? "";
    if (/\s$/.test(tex) || /\d/.test(next)) return false;
    // A price is a provisional opener. Prefer Markdown structure when pairing it would consume
    // a link destination or the opener of an emphasized formula, e.g. $5; **$(x+1)^2$**.
    if (/^\d/.test(tex)) {
      const link = /\]\(|\]\[|<[a-z][\w.+-]*:/i.test(tex);
      const emphasized = next && !/\s/.test(next) && /\s(?:\*{1,3}|_{1,3}|~~)$/.test(tex);
      if (link || emphasized) return false;
    }
  }
  if (!silent) {
    const token = state.push(display ? "math_display" : "math_inline", "", 0);
    token.content = tex;
    token.markup = open;
  }
  state.pos = after;
  return true;
}

function blockMath(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const { src, bMarks, tShift, eMarks, sCount, blkIndent } = state;
  const start = bMarks[startLine] + tShift[startLine];
  const open = displayOpener(src, start, eMarks[startLine]);
  if (!open || sCount[startLine] - blkIndent >= 4) return false;
  const close = closing[open];
  for (let line = startLine; line < endLine; line++) {
    const first = bMarks[line] + tShift[line];
    const last = eMarks[line];
    if (last - start > maxMathLength + open.length + close.length) return false;
    if (line > startLine && first < last && (sCount[line] < blkIndent || /^(?:```|~~~)/.test(src.slice(first, first + 3)))) return false;
    const end = findClose(src, line === startLine ? start + open.length : first, last, close);
    if (end < 0) continue;
    if (src.slice(end + close.length, last).trim()) return false;
    const tex = state.getLines(startLine, line + 1, blkIndent, false).trim().slice(open.length, -close.length);
    if (!tex.trim()) return false;
    if (!silent) {
      const token = state.push("math_block", "", 0);
      token.content = tex;
      token.markup = open;
      token.map = [startLine, line + 1];
      state.line = line + 1;
    }
    return true;
  }
  return false;
}

/** Add math to the built-in Markdown renderer, not to raw text, code, or custom card renderers. */
export function mathMarkdown(markdown: MarkdownIt, katex: Pick<typeof katexApi, "render" | "ParseError">): (body: HTMLElement, text: string) => void {
  markdown.inline.ruler.before("escape", "math", inlineMath);
  // Don't interrupt paragraphs here: a display delimiter might be inside a multiline code span.
  markdown.block.ruler.before("table", "math", blockMath);
  const escape = markdown.utils.escapeHtml;
  const placeholder = (tag: string, mode: string): RendererRule => (tokens, index) => {
    const { content, markup } = tokens[index];
    return `<${tag} class="math-${mode}" data-math="${escape(content)}">${escape(markup + content + closing[markup])}</${tag}>`;
  };
  markdown.renderer.rules.math_inline = placeholder("span", "inline");
  markdown.renderer.rules.math_display = placeholder("span", "display");
  markdown.renderer.rules.math_block = placeholder("div", "display");

  return (body, text) => {
    body.innerHTML = markdown.render(text);
    for (const node of body.querySelectorAll<HTMLElement>("[data-math]")) {
      const tex = node.dataset.math!;
      delete node.dataset.math;
      const literal = node.textContent;
      try {
        // KaTeX's DOM renderer sets layout styles via CSSOM; renderToString would produce CSP-blocked inline styles.
        katex.render(tex, node, { displayMode: node.classList.contains("math-display"), trust: false, throwOnError: true, maxSize: 20 });
      } catch (error) {
        // Keep the rest of the transcript readable even on an unexpected renderer failure.
        node.textContent = literal;
        if (!(error instanceof katex.ParseError)) console.error("KaTeX could not render chat math:", error);
      }
    }
  };
}
