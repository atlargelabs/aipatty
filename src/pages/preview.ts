import type { Precard } from "../web/cards.ts";
import { pagePath, pagesLibraryApi, publishPageTool, readPageDetails, type PageDetails, type PageSection } from "./shared.ts";

type Availability = "checking" | "available" | "missing" | "unknown";
interface Preview {
  page: PageDetails;
  status: Availability;
  controls: HTMLElement;
  body: HTMLElement;
}

const previews = new WeakMap<HTMLElement, Preview>();

function mountFrame(preview: Preview) {
  const { page, body } = preview;
  const frame = document.createElement("iframe");
  frame.title = page.title;
  frame.setAttribute("sandbox", page.mode === "interactive" ? "allow-scripts" : "");
  frame.referrerPolicy = "no-referrer";
  if (page.mode === "static") frame.loading = "lazy";
  frame.src = pagePath(page.id);
  body.append(frame);
}

function update(preview: Preview, status: Availability) {
  if (preview.status === status) return;
  preview.status = status;
  const { body, controls, page } = preview;
  body.querySelector("iframe")?.remove();
  if (status !== "available") {
    controls.textContent = status === "missing" ? "Page no longer available." : "Could not check page availability.";
    return;
  }
  const open = document.createElement("a");
  open.textContent = "Open full page";
  open.href = pagePath(page.id);
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  controls.replaceChildren(open);
  if (page.mode === "static") mountFrame(preview);
  else {
    const run = document.createElement("button");
    run.type = "button";
    run.textContent = "Run inline";
    run.addEventListener("click", () => {
      run.remove();
      mountFrame(preview);
    });
    controls.append(run);
  }
}

let queued = false;
let revision = 0;
function checkPreviews() {
  if (queued) return;
  queued = true;
  // One bounded metadata lookup for the cards this draw added, not one HTML/HEAD request per card.
  queueMicrotask(async () => {
    queued = false;
    const current = ++revision;
    const shown = [...document.querySelectorAll<HTMLElement>('.card-body[data-format="page-preview"]')];
    if (!shown.length) return;
    let ids: Set<string> | undefined;
    try {
      const response = await fetch(pagesLibraryApi);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { sections } = await response.json() as { sections: PageSection[] };
      ids = new Set(sections.flatMap(section => section.pages.map(page => page.id)));
    } catch { /* Keep the title readable if the library cannot be reached. */ }
    if (current !== revision) return;
    for (const body of shown) {
      const preview = previews.get(body);
      if (preview && body.isConnected) update(preview, !ids ? "unknown" : ids.has(preview.page.id) ? "available" : "missing");
    }
  });
}

window.addEventListener("focus", checkPreviews);
window.addEventListener("pageshow", event => { if (event.persisted) checkPreviews(); });

/** This is deliberately not a card format: an app step's format/text cannot create an iframe. */
export function drawPagePreview(body: HTMLElement, precard: Precard): boolean {
  const page = precard.kind === "toolResult" && precard.message.toolName === publishPageTool && precard.message.isError === false
    ? readPageDetails(precard.message.details) : undefined;
  if (!page) return false;
  const existing = previews.get(body);
  if (existing?.page.id === page.id && body.dataset.format === "page-preview") return true;
  const heading = document.createElement("strong");
  heading.textContent = `${page.title} · ${page.mode === "static" ? "Static HTML" : "JavaScript"}`;
  const controls = document.createElement("div");
  controls.className = "preview-controls";
  controls.textContent = "Checking page…";
  body.dataset.format = "page-preview";
  body.replaceChildren(heading, controls);
  previews.set(body, { page, status: "checking", controls, body });
  checkPreviews();
  return true;
}
