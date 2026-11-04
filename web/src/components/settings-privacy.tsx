// Settings → Privacy: the two anonymous telemetry toggles (src/core/telemetry.ts says what each sends).
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { BigSwitch, Block, Section } from "@/components/settings-ui";
import { NATIVE_COPY } from "@/lib/native-copy";

type Prefs = { errorReports: boolean; usageStats: boolean };

export function PrivacySection() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [active, setActive] = useState(true);
  useEffect(() => {
    api.telemetry().then(
      (t) => {
        setPrefs(t.prefs);
        setActive(t.active);
      },
      () => setActive(false),
    );
  }, []);

  const set = async (patch: Partial<Prefs>) => {
    if (!prefs) return;
    const before = prefs;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      const saved = await api.saveSettings({ privacy: next });
      setPrefs(saved.privacy ?? next);
    } catch (e) {
      setPrefs(before);
      toast.error("Couldn't save", { description: (e as Error).message });
    }
  };

  return (
    <Section id="privacy" title="Privacy" description="Both are anonymous: not linked to your Etude account, and they go to Etude's own server even when Sync uses yours.">
      <Block
        title={<label htmlFor="privacy-errors">Send error reports</label>}
        description={NATIVE_COPY.privacyErrors}
        aside={<BigSwitch id="privacy-errors" checked={prefs?.errorReports ?? true} disabled={!prefs} onCheckedChange={(v) => void set({ errorReports: v })} />}
      />
      <Block
        title={<label htmlFor="privacy-usage">Share usage stats</label>}
        description={NATIVE_COPY.privacyUsage}
        aside={<BigSwitch id="privacy-usage" checked={prefs?.usageStats ?? false} disabled={!prefs} onCheckedChange={(v) => void set({ usageStats: v })} />}
      />
      {prefs && !active && (
        <Block description="This copy of Etude isn't sending either right now (ETUDE_TELEMETRY=0, or an etude serve started outside the app). The switches apply wherever this collection opens in the app." />
      )}
    </Section>
  );
}
