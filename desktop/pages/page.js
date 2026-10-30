// The two pages the app shows without the engine: starting, and what went wrong. They take the
// last theme's background from ?bg, so the window doesn't flash a different color.
const q = new URLSearchParams(location.search);
const bg = /^#[0-9a-f]{6}$/i.test(q.get("bg") ?? "") ? q.get("bg") : "#0f0f0f";
const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
document.documentElement.style.background = bg;
if (0.2126 * r + 0.7152 * g + 0.0722 * b > 140) document.documentElement.classList.add("light");

addEventListener("DOMContentLoaded", () => {
  for (const id of ["title", "detail"]) {
    const el = document.getElementById(id);
    if (el && q.get(id)) el.textContent = q.get(id);
  }
  document.getElementById("retry")?.addEventListener("click", () => window.etudeDesktop?.retry());
  document.getElementById("logs")?.addEventListener("click", () => window.etudeDesktop?.showLogs());
});
