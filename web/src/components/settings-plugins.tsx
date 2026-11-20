// Settings -> Plugins: install bundled free plugins (Pomodoro), enable/disable, review permissions, uninstall.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, Loader2, Puzzle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Group } from "@/components/settings-ui";
import { api, type BundledPluginInfo, type InstalledPluginInfo } from "@/lib/api";
import { notifyPluginsChanged } from "@/lib/plugins";

export function PluginsSection() {
  const [plugins, setPlugins] = useState<InstalledPluginInfo[]>([]);
  const [bundled, setBundled] = useState<BundledPluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.plugins();
      setPlugins(res.plugins);
      setBundled(res.bundled);
    } catch (e) {
      toast.error("Couldn't load plugins", { description: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const installBundled = async (b: BundledPluginInfo) => {
    setBusy(b.id);
    try {
      await api.installBundledPlugin(b.id);
      toast.success(`${b.manifest.name} installed`, { description: "Open it from Ctrl/⌘K or the right-click menu." });
      await load();
      notifyPluginsChanged();
    } catch (e) {
      toast.error("Couldn't install plugin", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (p: InstalledPluginInfo, enabled: boolean) => {
    setBusy(p.id);
    try {
      await api.updatePlugin(p.id, { enabled });
      await load();
      notifyPluginsChanged();
    } catch (e) {
      toast.error("Couldn't update plugin", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const togglePermission = async (p: InstalledPluginInfo, perm: string, on: boolean) => {
    setBusy(`${p.id}:${perm}`);
    try {
      const next = on ? [...new Set([...p.granted, perm])] : p.granted.filter((x) => x !== perm);
      await api.updatePlugin(p.id, { granted: next });
      await load();
      notifyPluginsChanged();
    } catch (e) {
      toast.error("Couldn't update permissions", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const approvePending = async (p: InstalledPluginInfo) => {
    setBusy(p.id);
    try {
      await api.updatePlugin(p.id, { granted: p.manifest.permissions, enabled: true });
      toast.success(`${p.manifest.name} resumed`);
      await load();
      notifyPluginsChanged();
    } catch (e) {
      toast.error("Couldn't resume plugin", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (p: InstalledPluginInfo) => {
    setBusy(p.id);
    try {
      await api.uninstallPlugin(p.id);
      toast.success(`${p.manifest.name} removed`);
      await load();
      notifyPluginsChanged();
    } catch (e) {
      toast.error("Couldn't remove plugin", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const availableBundled = bundled.filter((b) => !b.installed);

  return (
    <>
      <Group title="Installed">
        <div className="p-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading plugins…
            </div>
          ) : plugins.length === 0 ? (
            <div className="flex items-center gap-3 py-2 text-sm text-muted-foreground">
              <Puzzle className="size-4 shrink-0" />
              <span>No plugins installed yet. Install Pomodoro below, browse free plugins in the Market, or run <code>etude plugin install &lt;folder&gt;</code>.</span>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {plugins.map((p) => (
                <div key={p.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[15px] font-medium text-foreground">{p.manifest.name}</span>
                        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">v{p.manifest.version}</span>
                        <span className="text-xs text-muted-foreground">by {p.manifest.author}</span>
                      </div>
                      {p.manifest.description && <p className="mt-0.5 text-[13.5px] text-muted-foreground">{p.manifest.description}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        checked={p.enabled}
                        disabled={busy === p.id}
                        aria-label={`Enable ${p.manifest.name}`}
                        onCheckedChange={(on) => void toggleEnabled(p, on)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${p.manifest.name}`}
                        disabled={busy === p.id}
                        onClick={() => void uninstall(p)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                  {p.pendingPermissions.length > 0 && (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
                      <span className="flex items-center gap-2">
                        <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
                        Paused: asks for new permissions ({p.pendingPermissions.join(", ")}).
                      </span>
                      <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => void approvePending(p)}>
                        Approve &amp; resume
                      </Button>
                    </div>
                  )}
                  {p.manifest.permissions.length > 0 && (
                    <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 px-3 py-2.5">
                      <div className="text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">Permissions</div>
                      {p.manifest.permissions.map((perm) => {
                        const on = p.granted.includes(perm);
                        return (
                          <label key={perm} className="flex items-center justify-between gap-3 text-[13px]">
                            <span className="text-foreground/90">
                              {p.permissionLabels?.[perm] ?? perm}{" "}
                              <code className="text-[11px] text-muted-foreground">{perm}</code>
                            </span>
                            <Switch
                              checked={on}
                              disabled={busy === `${p.id}:${perm}`}
                              aria-label={`${perm} for ${p.manifest.name}`}
                              onCheckedChange={(v) => void togglePermission(p, perm, v)}
                            />
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Group>

      {availableBundled.length > 0 && (
        <Group title="Starter plugins">
          <div className="flex flex-col divide-y divide-border p-4">
            {availableBundled.map((b) => (
              <div key={b.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-medium text-foreground">{b.manifest.name}</span>
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Free</span>
                    </div>
                    <p className="mt-0.5 text-[13.5px] text-muted-foreground">{b.manifest.description}</p>
                  </div>
                  <Button size="sm" className="shrink-0 gap-1.5" disabled={busy === b.id} onClick={() => void installBundled(b)}>
                    {busy === b.id ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                    Install
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground">
                  Needs: {b.manifest.permissions.map((p) => b.permissionLabels?.[p] ?? p).join(" · ")}
                </div>
              </div>
            ))}
          </div>
        </Group>
      )}
    </>
  );
}
