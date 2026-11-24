import { api, branchId, gymPath, node, setLine } from "./view.js";

function gymLink(label) {
  const link = node("a", label);
  const branch = branchId(location.hash.slice(1));
  link.href = gymPath + (branch ? "?branch=" + branch : "");
  return link;
}

function preview(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

export async function header(el) {
  const link = gymLink("Open Gym");
  const { latestWorkout, plan } = await api("overview");
  const names = latestWorkout ? [...new Set(latestWorkout.sets.map(set => set.exercise))] : [];
  const latest = latestWorkout
    ? "Last workout: " + latestWorkout.date + " · " + latestWorkout.sets.length + " sets · " + preview(names.join(", "), 90)
    : "No workouts logged yet.";
  el.replaceChildren(link, node("div", latest), node("div", plan.trim() ? "Plan: " + preview(plan, 160) : "No plan saved yet."));
}

function card(title, ...lines) {
  const el = node("div");
  el.className = "gym-tool-card";
  el.append(node("strong", title), ...lines.map(line => node("div", line)), gymLink("Open Gym"));
  return el;
}

export function renderTool(call, result) {
  if (!result || result.isError) return;
  const details = result.details;
  switch (result.toolName ?? call?.name) {
    case "gym_save_workout": {
      const workout = details?.workout;
      if (!Array.isArray(workout?.sets)) return;
      const lines = workout.sets.slice(0, 4).map(set => preview(setLine(set), 100));
      if (workout.sets.length > lines.length) lines.push("… and " + (workout.sets.length - lines.length) + " more sets");
      return card("Workout saved · " + workout.date, ...lines);
    }
    case "gym_delete_workout":
      if (typeof details?.id === "string") return card(details.deleted ? "Workout deleted" : "Workout not found", details.id);
      return;
    case "gym_save_plan":
      if (typeof details?.plan === "string") return card(details.plan.length ? "Plan saved" : "Plan cleared", preview(details.plan, 240));
      return;
    case "gym_query": {
      let data;
      // Old or shortened tool text may not contain a complete payload; leave it readable as-is.
      try { data = JSON.parse(result.content.find(block => block.type === "text")?.text); }
      catch { return; }
      const { columns, rows, truncated } = data;
      const summary = rows.length + (rows.length === 1 ? " row" : " rows") + (truncated ? " (result capped)" : "");
      const line = values => values.slice(0, 4).map(value => value === null ? "NULL" : preview(value, 28)).join(" · ") + (values.length > 4 ? " · …" : "");
      return card("Gym query · " + summary, line(columns), ...rows.slice(0, 3).map(line), ...(rows.length > 3 ? ["…"] : []));
    }
  }
}
