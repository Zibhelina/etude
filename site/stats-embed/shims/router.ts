// On the website the panels have nowhere to go: "Review now" leads to the download page and the
// links into Browse or another deck's Stats do nothing.
export function navigate(to: string) {
  if (to.startsWith("/study")) location.href = new URL("download.html", document.baseURI).href;
}

export function useLocation() {
  return { path: "/stats", params: new URLSearchParams() };
}
