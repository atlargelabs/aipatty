import { brandCredit, brandStylePath } from "../web/brand.ts";
import { maxSectionName, pagesPath } from "./shared.ts";

export const libraryScriptPath = `${pagesPath}/library.js`;
export const libraryStylePath = `${pagesPath}/library.css`;

export const libraryHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pages · aipatty</title>
<link rel="stylesheet" href="${brandStylePath}">
<link rel="stylesheet" href="${libraryStylePath}">
<script type="module" src="${libraryScriptPath}"></script>
</head>
<body>
<header class="masthead">
  <div class="header-inner">
    <div><h1 class="product-name">Pages</h1>${brandCredit}</div>
    <a href="/">Back to chat</a>
  </div>
</header>
<main>
  <p>Ask aipatty in any branch to publish a page. New pages appear in Unsorted. Opening a JavaScript page runs its code in a sandbox.</p>
  <form id="new-section">
    <label>Section name <input name="name" maxlength="${maxSectionName}" required></label>
    <button type="submit" class="primary">Add section</button>
    <button id="refresh" type="button">Refresh</button>
  </form>
  <p id="status" role="status">Loading library…</p>
  <div id="sections"></div>
  <noscript>The library needs JavaScript to show and organize links. It does not run any published pages.</noscript>
</main>
</body>
</html>
`;

export const libraryCss = `
:root { --content-width: 54rem; }
main { max-width: var(--content-width); margin: 16px auto; padding-inline: 16px; }
h2 { font-size: 1.125rem; }
h2, p { overflow-wrap: anywhere; }
label, input, select { min-width: 0; max-width: 100%; }
input, select { font-size: 1rem; }
button, select, input { min-height: 44px; }
form, .page-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
section { margin-block: 12px; padding: 0 16px 8px; background: var(--paper); border: 1px solid var(--line); border-radius: 8px; }
li { margin-block: 12px; overflow-wrap: anywhere; }
li small { margin-inline-start: 8px; color: var(--muted); }
.page-actions { margin-top: 4px; }
#status { min-height: 1.55em; }
`;
