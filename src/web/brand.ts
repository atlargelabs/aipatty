import { readFileSync } from "node:fs";
import { pageHeaders } from "../http.ts";

export const brandStylePath = "/web/brand.css";
export const brandAssets: ReadonlyMap<string, { body: Buffer; type: string }> = new Map([
  [brandStylePath, { body: readFileSync(new URL("./brand.css", import.meta.url)), type: "text/css; charset=utf-8" }],
  ...(["SourceCodePro-Regular.ttf", "SourceCodePro-Semibold.ttf"] as const).map(name => [
    `/web/fonts/${name}`, { body: readFileSync(new URL(`./fonts/${name}`, import.meta.url)), type: "font/ttf" },
  ] as const),
]);

// Only our branded documents need local fonts, not published pages or other app surfaces.
export const brandHeaders = {
  ...pageHeaders,
  "Content-Security-Policy": `${pageHeaders["Content-Security-Policy"]}; font-src 'self'`,
};

export const brandCredit = '<small class="brand-credit">by <span role="img" aria-label="atLarge Labs"><b>@</b>tLarge Labs</span></small>';
