export const gymPath = "/apps/gym/";

export function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

export function branchId(value) {
  return /^[1-9]\d*$/.test(value ?? "") ? value : null;
}

export async function api(path, method = "GET", body) {
  const response = await fetch(gymPath + "api/" + path, {
    method,
    signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error || "Gym request failed (HTTP " + response.status + ").");
  return result;
}

export function setLine({ exercise, reps, amount, unit }) {
  return exercise + " · " + (reps == null ? "" : reps + " × ") + amount + " " + unit;
}
