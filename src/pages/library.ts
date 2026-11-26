import { maxSectionName, pagesPath } from "./shared.ts";

export const libraryScriptPath = `${pagesPath}/library.js`;
export const libraryStylePath = `${pagesPath}/library.css`;

export const libraryHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pages · aipatty</title>
<link rel="stylesheet" href="${libraryStylePath}">
<script type="module" src="${libraryScriptPath}"></script>
</head>
<body>
<header><a href="/">Back to chat</a><h1>Pages</h1></header>
<main>
  <p>Ask aipatty in any branch to publish a page. New pages appear in Unsorted. Opening a JavaScript page runs its code in a sandbox.</p>
  <form id="new-section">
    <label>Section name <input name="name" maxlength="${maxSectionName}" required></label>
    <button type="submit">Add section</button>
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
* { box-sizing: border-box; }
body { max-width: 54rem; margin: 1.25rem auto; padding-inline: 1rem; font: 16px/1.45 system-ui, sans-serif; color: #1d1d1f; }
h1, h2, p { overflow-wrap: anywhere; }
button, select, input { font: inherit; }
button, select { padding: .2rem .45rem; }
form, .page-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
section { border-top: 1px solid #ddd; }
li { margin-block: .7rem; overflow-wrap: anywhere; }
li small { margin-inline-start: .5rem; color: #555; }
.page-actions { margin-top: .25rem; }
#status { min-height: 1.45em; }
`;
