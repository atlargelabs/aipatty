// Local, decorative line icons. The native button carries the accessible name and tooltip.
const paths = {
  fork: "M6 7.5v9m12-9a7 7 0 0 1-7 7H6M8.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Zm12 0a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Zm-12 14a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z",
  edit: "m13.5 6.5 4 4M4 20l1-5L16 4a2.8 2.8 0 0 1 4 4L9 19l-5 1Z",
  copy: "M8 16H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3m-6 0h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h1Z",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13m-8 3v6m4-6v6",
};

export function drawButtonIcon(button: HTMLButtonElement, icon: keyof typeof paths, label: string): void {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("stroke-linecap", "round");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", paths[icon]);
  svg.append(path);
  button.classList.add("icon-button");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(svg);
}
