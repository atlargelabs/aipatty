// Shared by the listener, the tool and the trusted browser modules. No server imports.
export const pagesPath = "/pages";
export const pagesLibraryApi = `${pagesPath}/library.json`;
export const pagesPreviewScript = `${pagesPath}/preview.js`;
export const publishPageTool = "publish_page";
export const maxPageTitle = 100;
export const maxSectionName = 60;
export const pageIdPattern = /^[0-9a-f]{32}$/;

export type PageDetails = { id: string; title: string; mode: "static" | "interactive" };
export type PageSection = { id: number; name: string; pages: PageDetails[] };

export function pagePath(id: string): string {
  return `${pagesPath}/${id}/`;
}

export function validLabel(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function readPageDetails(value: unknown): PageDetails | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { id, title, mode } = value as Record<string, unknown>;
  if (typeof id === "string" && pageIdPattern.test(id) && validLabel(title, maxPageTitle)
    && (mode === "static" || mode === "interactive")) return { id, title, mode };
}
