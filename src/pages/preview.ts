import type { Precard } from "../web/cards.ts";
import { pagePath, pagesLibraryApi, publishPageTool, readPageDetails, type PageDetails, type PageSection } from "./shared.ts";

type Availability = "available" | "missing";
interface Preview {
  page: PageDetails;
  status?: Availability;
  controls: HTMLElement;
  message: HTMLElement;
  body: HTMLElement;
}

type PreserveScroll = (change: () => void) => void;

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

function update(preview: Preview, preserveScroll: PreserveScroll, status?: Availability) {
  const { body, controls, message, page } = preview;
  // A failed lookup is not a deletion: keep an already-running frame and its local state.
  const text = (status ?? preview.status) === "missing" ? "Page no longer available."
    : status === undefined ? "Could not check page availability." : "";
  if (message.textContent !== text) message.textContent = text;
  if (status === undefined || preview.status === status) return;
  preview.status = status;
  if (status === "missing") {
    body.querySelector("iframe")?.remove();
    controls.replaceChildren();
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
    run.addEventListener("click", () => preserveScroll(() => {
      run.remove();
      mountFrame(preview);
    }));
    controls.append(run);
  }
}

export function pagePreviews(preserveScroll: PreserveScroll) {
  const previews = new WeakMap<HTMLElement, Preview>();
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
        if (response.status === 404) ids = new Set(); // The server no longer serves the library (e.g. after rollback).
        else if (response.ok) {
          const { sections } = await response.json() as { sections: PageSection[] };
          ids = new Set(sections.flatMap(section => section.pages.map(page => page.id)));
        }
      } catch { /* Keep the title readable if the library cannot be reached. */ }
      if (current !== revision) return;
      preserveScroll(() => {
        for (const body of shown) {
          const preview = previews.get(body);
          if (preview && body.isConnected) update(preview, preserveScroll, ids && (ids.has(preview.page.id) ? "available" : "missing"));
        }
      });
    });
  }

  window.addEventListener("focus", checkPreviews);
  window.addEventListener("pageshow", event => { if (event.persisted) checkPreviews(); });

  /** This is deliberately not a card format: an app step's format/text cannot create an iframe. */
  return function drawPagePreview(body: HTMLElement, precard: Precard): boolean {
    const page = precard.kind === "toolResult" && precard.message.toolName === publishPageTool && precard.message.isError === false
      ? readPageDetails(precard.message.details) : undefined;
    if (!page) return false;
    const existing = previews.get(body);
    if (existing?.page.id === page.id && body.dataset.format === "page-preview") return true;
    const heading = document.createElement("strong");
    heading.textContent = `${page.title} · ${page.mode === "static" ? "Static HTML" : "JavaScript"}`;
    const controls = document.createElement("div");
    controls.className = "preview-controls";
    const message = document.createElement("div");
    message.setAttribute("role", "status");
    message.textContent = "Checking page…";
    body.dataset.format = "page-preview";
    body.replaceChildren(heading, controls, message);
    previews.set(body, { page, controls, message, body });
    checkPreviews();
    return true;
  };
}
