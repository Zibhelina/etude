// Which AI providers the iPhone app asks about at launch (components/ai-consent.tsx, AiConsentAtLaunch): those set up
// (a key, a ChatGPT sign-in), not agreed to yet, and not put off with Not now on this device before. No imports: the
// tests read it too.

type Provider = { id: string; ready: boolean; agreed: string | null };

export const launchAsks = (st: { providers: Provider[] }, putOff: string[]) => st.providers.filter((p) => p.ready && !p.agreed && !putOff.includes(p.id)).map((p) => p.id);

/** What Not now at launch remembered, read back from storage (anything else reads as nothing). */
export function putOffList(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
