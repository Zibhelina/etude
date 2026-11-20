// What a web tab's address bar makes of what was typed (lib/web-tabs.tsx). No React here, so tests can load it.

export const SEARCH_ENGINES = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
  brave: { name: "Brave Search", url: "https://search.brave.com/search?q=" },
  kagi: { name: "Kagi", url: "https://kagi.com/search?q=" },
} as const;
export type SearchEngine = keyof typeof SEARCH_ENGINES;

/**
 * An address when the text is one (https:// added to a bare host, http:// to localhost and IP addresses), else a
 * search at `search` (the engine's address, the words go on the end). Null for an empty box or an address that
 * isn't a web page (file:, javascript:, mailto:…).
 */
export function addressOf(input: string, search: string): string | null {
  const t = input.trim();
  if (!t) return null;
  // A scheme ("https:", "file:"), but not a host with a port ("localhost:3000").
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[\w.-]+:\d+(\/|$)/.test(t)) return /^https?:\/\/[^\s]/i.test(t) && !/\s/.test(t) ? t : null;
  if (!/\s/.test(t)) {
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(t)) return "http://" + t;
    if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(t)) return "https://" + t;
  }
  return search + encodeURIComponent(t);
}
