// The last theme, before the first paint, so a light theme doesn't flash dark. Embeds follow their host instead.
(function () {
  try {
    if (/\/embed$/.test(location.pathname)) return; // "/embed", or "/app/embed" in the web edition
    var t = JSON.parse(localStorage.getItem("etude.theme") || "null");
    if (!t || typeof t.css !== "string") return;
    var s = document.createElement("style");
    s.id = "etude-theme";
    s.textContent = t.css;
    document.head.appendChild(s);
    var root = document.documentElement;
    root.classList.toggle("dark", t.scheme !== "light");
    root.dataset.theme = t.id;
    document.querySelector('meta[name="color-scheme"]').content = t.scheme === "light" ? "light" : "dark";
    if (t.bg) document.querySelector('meta[name="theme-color"]').content = t.bg;
  } catch (e) {}
})();
