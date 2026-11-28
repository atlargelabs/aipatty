import assert from "node:assert/strict";
import { test } from "node:test";
import { ParseError } from "katex";
import markdownit from "markdown-it";
import { mathMarkdown } from "../src/web/math.ts";

const markdown = markdownit({ html: false, breaks: true });
mathMarkdown(markdown, { render: () => assert.fail("the parser must not run KaTeX"), ParseError });

function formulas(source: string): [string, string][] {
  return markdown.parse(source, {}).flatMap(token => token.children ?? [token])
    .filter(token => token.type.startsWith("math_")).map(({ type, content }) => [type, content]);
}

test("Markdown math recognizes opaque expressions in both delimiter styles", () => {
  const source = [
    String.raw`**\(x_1 < y^2\)** and $\text{cost \$5}$`,
    "\\[", String.raw`\sum_{i=0}^{n} i`, "\\]", "After the equation.", "",
    "$$", String.raw`\begin{aligned} a &= b \\`, "", String.raw`c &= d \end{aligned}`, "$$", "",
    "> \\[", "> a+b", "> \\]", "", "- $$x$$", "",
    "[Formula $a[b]$](https://example.org/) and $2 A[i][j] + 1$", "", "\\(\\verb|`|\\)",
  ].join("\n");
  assert.deepEqual(formulas(source), [
    ["math_inline", "x_1 < y^2"], ["math_inline", String.raw`\text{cost \$5}`],
    ["math_display", "\n" + String.raw`\sum_{i=0}^{n} i` + "\n"],
    ["math_block", "\n" + String.raw`\begin{aligned} a &= b \\` + "\n\n" + String.raw`c &= d \end{aligned}` + "\n"],
    ["math_block", "\na+b\n"], ["math_display", "x"], ["math_inline", "a[b]"], ["math_inline", "2 A[i][j] + 1"],
    ["math_inline", "\\verb|`|"],
  ]);
});

test("Markdown math leaves currency, escapes, code and incomplete delimiters alone", () => {
  const literal = [
    String.raw`\$x\$ and \\(x\\) and \\[x\\]`,
    "Costs $5, or $10-$20 per person. Sale prices: $.50-$.75.",
    "Costs $5 and `echo $`.",
    "`\\(x\\) \\[x\\] $x$ $$x$$`", "", "`before", "$$x$$", "after`", "",
    "```tex", "$$", "x^2", "$$", "```", "",
    "    $$x$$", "", "$$ is the shell PID. For example:", "", "    echo $$", "",
    "$$", "```", "$$", "```", "", "Unfinished $x and \\(y.",
  ].join("\n");
  assert.deepEqual(formulas(literal), []);
  const literalHtml = markdown.render(literal);
  assert.ok(literalHtml.includes("<code>before $$x$$ after</code>"));
  assert.ok(literalHtml.includes("<pre><code>echo $$\n</code></pre>"));
  assert.ok(literalHtml.includes("Sale prices: $.50-$.75."));
  const mixed = [
    "[Price $5](https://example.org/)$x$. Lunch cost $10; **$(y+1)^2$** is the adjustment.",
    String.raw`Price: \$$p$.`, "**$5**; see [details](https://example.org/?currency=$USD).",
  ].join("\n");
  assert.deepEqual(formulas(mixed), [["math_inline", "x"], ["math_inline", "(y+1)^2"], ["math_inline", "p"]]);
  const html = markdown.render(mixed);
  assert.ok(html.includes('<a href="https://example.org/">Price $5</a>'));
  assert.ok(html.includes('Lunch cost $10; <strong><span class="math-inline"'));
  assert.ok(html.includes('Price: $<span class="math-inline"'));
  assert.ok(html.includes('<strong>$5</strong>; see <a href="https://example.org/?currency=$USD">details</a>'));
});
