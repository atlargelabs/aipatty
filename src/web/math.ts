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
  state: StateInline, start: number, end: number, close: string, multiline: boolean, inLabel: boolean,
): number {
  const { src, pos: opener, posMax } = state;
  let brackets = 0;
  for (let pos = start; pos < end; pos++) {
    const ch = src[pos];
    if (!multiline && ch === "\n") break;
    if (pos + close.length <= end && src.startsWith(close, pos)) return pos;
    if (ch === "`") {
      let runEnd = pos + 1;
      while (runEnd < posMax && src[runEnd] === "`") runEnd++;
      // Let the Markdown tokenizer distinguish a code span from literal backticks in TeX.
      state.pos = pos;
      state.md.inline.skipToken(state);
      const isCode = state.pos > runEnd;
      state.pos = opener;
      if (isCode) break;
      pos = runEnd - 1;
    } else if (ch === "\\" && src[pos + 1] !== "\n") pos++;
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
  const end = findClose(state, from, Math.min(posMax, from + maxMathLength + close.length), close, !!display, silent);
  if (end < 0) return false;
  const after = end + close.length;
  const tex = src.slice(from, end);
  if (!tex.trim() || (src[end] === "$" && src[after] === "$")) return false;
  if (open === "$") {
    const next = src.slice(after, after + 2);
    if (/\s$/.test(tex) || /^(?:\d|\.\d)/.test(next)) return false;
    // Dollar openers are ambiguous. Prefer Markdown links and new emphasized formulas over a
    // candidate that would swallow that markup, no matter how a preceding price is formatted.
    const link = /(?:\]\(\s*<?|<)https?:\/\//i.test(tex);
    const emphasized = /^\S/.test(next) && /\s(?:\*{1,3}|_{1,3}|~~)$/.test(tex);
    if (link || emphasized) return false;
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
  // Blocks can span blank lines. Require standalone delimiters so that prose mentioning $$
  // cannot reach across a blank line into a code block. Compact display math is handled inline.
  if (!open || sCount[startLine] - blkIndent >= 4 || src.slice(start + open.length, eMarks[startLine]).trim()) return false;
  const close = closing[open];
  for (let line = startLine + 1; line < endLine; line++) {
    const first = bMarks[line] + tShift[line];
    const last = eMarks[line];
    if (last - start > maxMathLength + open.length + close.length) return false;
    if (first < last && (sCount[line] < blkIndent || /^(?:```|~~~)/.test(src.slice(first, first + 3)))) return false;
    if (sCount[line] - blkIndent >= 4 || src.slice(first, last).trimEnd() !== close) continue;
    const tex = "\n" + state.getLines(startLine + 1, line, blkIndent, true);
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
