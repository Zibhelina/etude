// The last theme, before the first paint, so a light theme doesn't flash dark. Embeds follow their host instead.
(function () {
  try {
    if (/\/embed$/.test(location.pathname)) return; // "/embed", or "/app/embed" in the web edition
    var t = JSON.parse(localStorage.getItem("etude.theme") || "null");
    if (t && t.pair && t.pair.light && t.pair.dark) t = matchMedia("(prefers-color-scheme: dark)").matches ? t.pair.dark : t.pair.light;
    if (!t || typeof t.css !== "string") return;
    var s = document.createElement("style");
    s.id = "etude-theme";
    s.textContent = t.css;
    document.head.appendChild(s);
    var root = document.documentElement;
    root.classList.toggle("dark", t.scheme !== "light");
    root.dataset.theme = t.id;
    document.querySelector('meta[name="color-scheme"]').content = t.scheme === "light" ? "light" : "dark";
    if (t.bg) {
      var tc = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 1; i < tc.length; i++) tc[i].remove();
      tc[0].removeAttribute("media");
      tc[0].content = t.bg;
    }
  } catch (e) {}
})();
