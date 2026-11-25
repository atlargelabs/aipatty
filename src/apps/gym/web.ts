import type { Step } from "../../web/cards.ts";

export const queryTool = "gym_query";
export const suggestionTool = "gym_suggest_workout";

function gymTool(name: string) {
  return name === queryTool || name === suggestionTool;
}

function logLink(branch: number) {
  return { label: "Log workout", href: "/apps/gym/?branch=" + branch };
}

export const steps: Step[] = [{
  name: "gym",
  card(card) {
    if (card.kind === "toolResult" && gymTool(card.message.toolName) && !card.message.isError) {
      return { format: "markdown", links: [logLink(card.branch)] };
    }
  },
  surround(surround) {
    return { header: [logLink(surround.branch)] };
  },
}];
