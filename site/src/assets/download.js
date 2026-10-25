// Download page: picks the visitor's OS and shows the matching commands.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const nav = $("#nav");
const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

const revealer = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), revealer.unobserve(e.target))), { rootMargin: "0px 0px -8% 0px" });
$$("[data-reveal]").forEach((el) => revealer.observe(el));

const OS = {
  mac: {
    note: "With Homebrew, or the installer from <a href=\"https://nodejs.org/en/download\">nodejs.org</a>.",
    cmd: ["brew install node", "node --version   # v24 or newer"],
    ps: "$ ",
    home: "~/.etude/etude.db",
    env: "~/.etude/.env",
  },
  windows: {
    note: "In PowerShell with winget, or the installer from <a href=\"https://nodejs.org/en/download\">nodejs.org</a>. You'll also want <a href=\"https://git-scm.com/download/win\">Git</a>.",
    cmd: ["winget install OpenJS.NodeJS Git.Git", "node --version   # v24 or newer"],
    ps: "> ",
    home: "%USERPROFILE%\\.etude\\etude.db",
    env: "%USERPROFILE%\\.etude\\.env",
  },
  linux: {
    note: "With your package manager, or a version manager like <a href=\"https://mise.jdx.dev\">mise</a> or <a href=\"https://github.com/nvm-sh/nvm\">nvm</a> if your distribution ships an older Node.",
    cmd: ["mise use -g node@24", "node --version   # v24 or newer"],
    ps: "$ ",
    home: "~/.etude/etude.db",
    env: "~/.etude/.env",
  },
};

function detect() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("linux") || p.includes("x11") || p.includes("cros")) return "linux";
  return "mac";
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
function show(os) {
  const o = OS[os];
  $$("[data-os]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.os === os)));
  $("[data-node-note]").innerHTML = o.note;
  const pre = $("[data-node-cmd]");
  pre.innerHTML = o.cmd.map((c) => {
    const [cmd, comment] = c.split(/(?=\s+#)/);
    return `<span class="ps">${o.ps}</span>${esc(cmd)}${comment ? `<span class="c">${esc(comment)}</span>` : ""}`;
  }).join("\n");
  pre.nextElementSibling.dataset.copyText = o.cmd[0];
  $$("[data-ps]").forEach((s) => (s.textContent = o.ps));
  $("[data-home]").textContent = o.home;
  $("[data-env]").textContent = o.env;
  const panel = $("[data-panel]");
  panel.classList.remove("os-panel"); void panel.offsetWidth; panel.classList.add("os-panel");
  history.replaceState(null, "", `#${os}`);
}
$$("[data-os]").forEach((b) => b.addEventListener("click", () => show(b.dataset.os)));
show(OS[location.hash.slice(1)] ? location.hash.slice(1) : detect());

// Every command block gets a copy button.
const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
for (const c of $$(".cmd")) {
  if (c.querySelector(".copy-btn")) continue;
  const pre = c.querySelector("pre");
  c.insertAdjacentHTML("beforeend", `<button class="copy-btn" type="button" aria-label="Copy">${COPY_ICON}</button>`);
  const out = pre.querySelector(".out");
  if (out) c.lastElementChild.dataset.copyText = pre.textContent.replace(out.textContent, "").replace(/^[>$] /gm, "").trim();
}
for (const b of $$(".cmd .copy-btn")) {
  b.addEventListener("click", async () => {
    const text = b.dataset.copyText ?? b.previousElementSibling.textContent.replace(/^[>$] /gm, "");
    try { await navigator.clipboard.writeText(text); } catch { return; }
    b.classList.add("done");
    setTimeout(() => b.classList.remove("done"), 1400);
  });
}
