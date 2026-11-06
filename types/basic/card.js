// Long questions step down from the big serif so they stay readable.
{
  const q = etude.root.firstElementChild;
  const n = q?.textContent.length ?? 0;
  if (q && (n > 260 || q.querySelector("pre, ul, ol, table, .katex-display, h1, h2, h3"))) q.classList.add("q-long");
  else if (q && n > 110) q.classList.add("q-mid");
}
