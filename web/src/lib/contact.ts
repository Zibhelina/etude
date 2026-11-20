// Reaching the Etude team: the contact address, and a Market entry's link and report email. An entry's link is the
// app's universal link: the phone apps open the entry itself (src/browser/native-shell.ts, routeOf), anywhere else it
// opens in the web app.

export const CONTACT_EMAIL = "hello@etude.study";

/** https://etude.study/app/market?entry=<key>: the address that opens this entry. Keys are kind/id, paid/<listing> or soon/<id>. */
export function entryLink(key: string): string {
  return `https://etude.study/app/market?entry=${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

/** A mailto: link that reports an entry to the Etude team: its name, key and link, and a line for the reason. */
export function reportMail(e: { name: string; key: string }): string {
  const subject = `Report: ${e.name} (${e.key})`;
  const body = ["I'd like to report this Market entry.", "", `Entry: ${e.name}`, `Key: ${e.key}`, `Link: ${entryLink(e.key)}`, "", "Reason: "].join("\r\n");
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** mailto: to the Etude team, with a subject. */
export const contactMail = (subject = "Etude") => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
