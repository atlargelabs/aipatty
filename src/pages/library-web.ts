import { pagePath, pagesLibraryApi, type PageSection } from "./shared.ts";

const list = document.getElementById("sections")!;
const status = document.getElementById("status")!;
const form = document.querySelector<HTMLFormElement>("#new-section")!;
let sections: PageSection[] = [];
let busy = false;

function button(text: string, label: string, click: () => void) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.setAttribute("aria-label", label);
  element.addEventListener("click", click);
  return element;
}

function draw() {
  list.replaceChildren(...sections.map(section => {
    const block = document.createElement("section");
    const heading = document.createElement("h2");
    const links = document.createElement("ol");
    heading.textContent = section.name;
    block.append(heading, links);
    if (!section.pages.length) {
      const empty = document.createElement("p");
      empty.textContent = "No pages in this section.";
      links.replaceWith(empty);
    }
    section.pages.forEach(({ id, title, mode }, index) => {
      const row = document.createElement("li");
      const link = document.createElement("a");
      link.textContent = title;
      link.href = pagePath(id);
      const badge = document.createElement("small");
      badge.textContent = mode === "interactive" ? "JavaScript" : "Static HTML";
      const actions = document.createElement("div");
      actions.className = "page-actions";
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Move ${title} to section`);
      select.disabled = sections.length < 2;
      for (const choice of sections) select.add(new Option(choice.name, String(choice.id)));
      select.value = String(section.id);
      select.addEventListener("change", () => {
        const target = Number(select.value);
        select.value = String(section.id);
        void update("POST", { action: "move", id, section: target });
      });
      const up = button("Up", `Move ${title} up`, () => void update("POST", { action: "step", id, direction: "up" }));
      const down = button("Down", `Move ${title} down`, () => void update("POST", { action: "step", id, direction: "down" }));
      up.disabled = index === 0;
      down.disabled = index === section.pages.length - 1;
      const remove = button("Delete", `Delete ${title}`, () => {
        if (confirm(`Delete “${title}”? Its URL will stop working. Conversation history will be kept.`)) {
          void update("DELETE", { id });
        }
      });
      actions.append(select, up, down, remove);
      row.append(link, badge, actions);
      links.append(row);
    });
    return block;
  }));
}

async function update(method: "GET" | "POST" | "DELETE", body?: object): Promise<boolean> {
  if (busy) return false;
  busy = form.inert = list.inert = true;
  status.textContent = method === "GET" ? "Loading library…" : "Saving…";
  try {
    const response = await fetch(pagesLibraryApi, {
      method, ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not update Pages.");
    sections = data.sections;
    draw();
    status.textContent = method === "GET" ? "" : "Library updated.";
    return true;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    busy = form.inert = list.inert = false;
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (await update("POST", { action: "create", name: new FormData(form).get("name") })) form.reset();
});
document.getElementById("refresh")!.addEventListener("click", () => void update("GET"));
void update("GET");
