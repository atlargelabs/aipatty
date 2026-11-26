import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "../http.ts";
import { maxPageTitle, maxSectionName, pageIdPattern, validLabel, type PageDetails, type PageSection } from "./shared.ts";

export const maxHtmlBytes = 256 * 1024;
const maxPages = 128;
const maxSections = 32;
const unsorted = 1;

function label(input: unknown, kind: string, max: number): string {
  const value = typeof input === "string" ? input.trim() : input;
  if (!validLabel(value, max)) throw new HttpError(400, `Expected ${kind} of 1 to ${max} characters without control characters.`);
  return value;
}

function pageId(input: unknown): string {
  if (typeof input !== "string" || !pageIdPattern.test(input)) throw new HttpError(400, "Invalid page ID.");
  return input;
}

export function openPagesStore(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS sections (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE
      ) STRICT;
      INSERT OR IGNORE INTO sections (id, name) VALUES (${unsorted}, 'Unsorted');
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('static', 'interactive')),
        html BLOB NOT NULL,
        section INTEGER NOT NULL REFERENCES sections(id),
        position INTEGER NOT NULL
      ) STRICT;
    `);

    const insertPage = db.prepare(`INSERT INTO pages (id, title, mode, html, section, position)
      SELECT ?, ?, ?, ?, ${unsorted}, COALESCE(MAX(position) + 1, 0) FROM pages WHERE section = ${unsorted}`);
    const pageCount = db.prepare("SELECT COUNT(*) AS count FROM pages");
    const selectPage = db.prepare("SELECT mode, html FROM pages WHERE id = ?");
    const selectSections = db.prepare("SELECT id, name FROM sections ORDER BY id");
    const selectLinks = db.prepare("SELECT id, title, mode FROM pages WHERE section = ? ORDER BY position");
    const selectSection = db.prepare("SELECT section FROM pages WHERE id = ?");
    const sectionExists = db.prepare("SELECT 1 FROM sections WHERE id = ?");
    const insertSection = db.prepare("INSERT INTO sections (name) VALUES (?) ON CONFLICT (name) DO NOTHING");
    const movePage = db.prepare(`UPDATE pages SET section = ?, position =
      (SELECT COALESCE(MAX(position) + 1, 0) FROM pages WHERE section = ?) WHERE id = ?`);
    const selectOrder = db.prepare("SELECT id, position FROM pages WHERE section = ? ORDER BY position");
    const swapPositions = db.prepare("UPDATE pages SET position = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?)");
    const deletePage = db.prepare("DELETE FROM pages WHERE id = ?");

    function sectionOf(id: string): number {
      const row = selectSection.get(id) as { section: number } | undefined;
      if (!row) throw new HttpError(404, "Page no longer available. Reload the library.");
      return row.section;
    }

    // Synchronous calls on the instance-owned DB; no other request can interleave a read and its update.
    return {
      close: () => db.close(),
      publish(titleInput: unknown, html: unknown, interactive: unknown): PageDetails {
        const title = label(titleInput, "a page title", maxPageTitle);
        if (typeof html !== "string" || Buffer.byteLength(html) > maxHtmlBytes || !html.trim()) {
          throw new HttpError(400, `Expected non-empty HTML of at most ${maxHtmlBytes / 1024} KiB.`);
        }
        if (interactive !== undefined && typeof interactive !== "boolean") throw new HttpError(400, "Expected a boolean interactive mode.");
        if (Number(pageCount.get()!.count) >= maxPages) throw new HttpError(409, `Pages is full (${maxPages} pages). Delete a page from the library first.`);
        const id = randomBytes(16).toString("hex");
        const mode = interactive ? "interactive" : "static";
        insertPage.run(id, title, mode, Buffer.from(html));
        return { id, title, mode };
      },
      page(id: string) {
        return selectPage.get(pageId(id)) as { mode: PageDetails["mode"]; html: Uint8Array } | undefined;
      },
      library(): PageSection[] {
        return (selectSections.all() as Omit<PageSection, "pages">[]).map(section => ({
          ...section, pages: selectLinks.all(section.id) as PageDetails[],
        }));
      },
      createSection(input: unknown) {
        const name = label(input, "a section name", maxSectionName);
        if (selectSections.all().length >= maxSections) throw new HttpError(409, `Pages supports at most ${maxSections} sections including Unsorted.`);
        if (!insertSection.run(name).changes) throw new HttpError(409, "A section with that name already exists.");
      },
      move(input: unknown, section: unknown) {
        const id = pageId(input);
        if (typeof section !== "number" || !Number.isSafeInteger(section) || !sectionExists.get(section)) {
          throw new HttpError(400, "Unknown section. Reload the library.");
        }
        if (sectionOf(id) !== section) movePage.run(section, section, id);
      },
      step(input: unknown, direction: unknown) {
        const id = pageId(input);
        if (direction !== "up" && direction !== "down") throw new HttpError(400, "Expected up or down.");
        const order = selectOrder.all(sectionOf(id)) as { id: string; position: number }[];
        const at = order.findIndex(page => page.id === id);
        const neighbor = order[at + (direction === "up" ? -1 : 1)];
        if (neighbor) swapPositions.run(id, neighbor.position, order[at].position, id, neighbor.id);
      },
      delete(input: unknown) {
        // Retrying a delete is harmless. The transcript (in a different DB) is not touched.
        deletePage.run(pageId(input));
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
