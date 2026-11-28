import assert from "node:assert/strict";
import { test } from "node:test";
import markdownit from "markdown-it";
import { mathMarkdown } from "../src/web/math.ts";

const markdown = markdownit({ html: false, breaks: true });
mathMarkdown(markdown, () => assert.fail("the parser must not run KaTeX"));

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
    "[Formula $a[b]$](https://example.org/)",
  ].join("\n");
  assert.deepEqual(formulas(source), [
    ["math_inline", "x_1 < y^2"], ["math_inline", String.raw`\text{cost \$5}`],
    ["math_display", "\n" + String.raw`\sum_{i=0}^{n} i` + "\n"],
    ["math_block", "\n" + String.raw`\begin{aligned} a &= b \\` + "\n\n" + String.raw`c &= d \end{aligned}` + "\n"],
    ["math_block", "\na+b\n"], ["math_block", "x"], ["math_inline", "a[b]"],
  ]);
});

test("Markdown math leaves currency, escapes, code and incomplete delimiters alone", () => {
  const literal = [
    String.raw`\$x\$ and \\(x\\) and \\[x\\]`,
    "Costs $5, or $10-$20 per person.",
    "Costs $5 and `echo $`.",
    "`\\(x\\) \\[x\\] $x$ $$x$$`", "", "`before", "$$x$$", "after`", "",
    "```tex", "$$", "x^2", "$$", "```", "",
    "    $$x$$", "", "$$", "```", "$$", "```", "", "Unfinished $x and \\(y.",
  ].join("\n");
  assert.deepEqual(formulas(literal), []);
  assert.ok(markdown.render(literal).includes("<code>before $$x$$ after</code>"));
  const mixed = "[Price $5](https://example.org/)$x$. Lunch cost $10; **$y$** is the tip.";
  assert.deepEqual(formulas(mixed), [["math_inline", "x"], ["math_inline", "y"]]);
  assert.match(markdown.render(mixed), /<a href="https:\/\/example\.org\/">Price \$5<\/a>/);
  assert.match(markdown.render(mixed), /Lunch cost \$10; <strong><span class="math-inline"/);
});
