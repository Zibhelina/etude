// Hosts enabled plugins inside sandboxed iframes (hidden controllers + draggable floating views).
// Desktop + Web only (never mounted on iOS/Android native apps).
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, X } from "lucide-react";
import { toast } from "sonner";
import { api, type InstalledPluginInfo } from "@/lib/api";
import { apiToken, etudeFetch, isLocal } from "@/lib/transport";
import { THEME_EVENT } from "@/lib/theme";
import {
  addPluginCommand,
  clearPluginCommands,
  getPluginCommands,
  playPluginChime,
  PLUGIN_REVIEW_EVENT,
  PLUGINS_EVENT,
} from "@/lib/plugins";

interface FloatingState {
  pluginId: string;
  view: string;
  title: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

const THEME_VARS = [
  "--foreground",
  "--background",
  "--card",
  "--card-foreground",
  "--border",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--muted",
  "--muted-foreground",
  "--font-sans",
];

function readThemeVars(): { vars: Record<string, string>; colorScheme: string } {
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of THEME_VARS) {
    const val = cs.getPropertyValue(name).trim();
    if (val) vars[name] = val;
  }
  const colorScheme = cs.colorScheme && cs.colorScheme !== "normal"
    ? cs.colorScheme
    : document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
  return { vars, colorScheme };
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function frameUrl(path: string): string {
  const tok = apiToken();
  return tok ? `${path}?token=${encodeURIComponent(tok)}` : path;
}

function applyNonce(html: string): string {
  const nonce = (window as unknown as { __etudeFrameNonce?: string }).__etudeFrameNonce ?? "";
  return html.replaceAll("%ETUDE_NONCE%", nonce);
}

/** Loads a plugin frame either by URL (desktop server) or fetched srcdoc with nonce (serverless web). */
function usePluginFrameSrc(path: string | null) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const local = isLocal();
  useEffect(() => {
    if (!path || !local) {
      setSrcDoc(null);
      return;
    }
    let live = true;
    etudeFetch(path)
      .then((r) => (r.ok ? r.text() : ""))
      .then((html) => live && setSrcDoc(html ? applyNonce(html) : null))
      .catch(() => live && setSrcDoc(null));
    return () => {
      live = false;
    };
  }, [path, local]);
  return local ? { srcDoc: srcDoc ?? undefined } : { src: path ? frameUrl(path) : undefined };
}

function matchShortcut(e: KeyboardEvent, shortcut?: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split("+").map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const wantMod = parts.includes("mod") || parts.includes("cmd") || parts.includes("ctrl");
  const wantAlt = parts.includes("alt") || parts.includes("opt");
  const wantShift = parts.includes("shift");
  return (e.metaKey || e.ctrlKey) === wantMod && e.altKey === wantAlt && e.shiftKey === wantShift && e.key.toLowerCase() === key;
}

export function PluginHost() {
  const [plugins, setPlugins] = useState<InstalledPluginInfo[]>([]);
  const [floating, setFloating] = useState<Record<string, FloatingState>>({});
  const pluginsRef = useRef<Map<string, InstalledPluginInfo>>(new Map());
  const controllerFrames = useRef<Map<string, HTMLIFrameElement>>(new Map());
  const viewFrames = useRef<Map<string, HTMLIFrameElement>>(new Map());
  const floatingRef = useRef(floating);
  floatingRef.current = floating;

  const loadPlugins = useCallback(async () => {
    try {
      const res = await api.plugins();
      const enabled = res.plugins.filter((p) => p.enabled);
      const activeIds = new Set(enabled.map((p) => p.id));
      for (const prevId of pluginsRef.current.keys()) {
        if (!activeIds.has(prevId)) clearPluginCommands(prevId);
      }
      pluginsRef.current = new Map(enabled.map((p) => [p.id, p]));
      setPlugins(enabled);
      setFloating((prev) => {
        const next: Record<string, FloatingState> = {};
        for (const [id, f] of Object.entries(prev)) if (activeIds.has(id)) next[id] = f;
        return next;
      });
    } catch {
      // Server not ready or older backend without /api/plugins.
    }
  }, []);

  useEffect(() => {
    void loadPlugins();
    const h = () => void loadPlugins();
    window.addEventListener(PLUGINS_EVENT, h);
    return () => window.removeEventListener(PLUGINS_EVENT, h);
  }, [loadPlugins]);

  // Push live theme CSS variables into all mounted plugin iframes.
  const broadcastTheme = useCallback(() => {
    const { vars, colorScheme } = readThemeVars();
    for (const [id, frame] of controllerFrames.current) {
      frame.contentWindow?.postMessage({ etudePlugin: id, kind: "theme", vars, colorScheme }, "*");
    }
    for (const [id, frame] of viewFrames.current) {
      frame.contentWindow?.postMessage({ etudePlugin: id, kind: "theme", vars, colorScheme }, "*");
    }
  }, []);

  useEffect(() => {
    window.addEventListener(THEME_EVENT, broadcastTheme);
    return () => window.removeEventListener(THEME_EVENT, broadcastTheme);
  }, [broadcastTheme]);

  // Forward review events to plugins with `events.review`.
  useEffect(() => {
    const onRev = (e: Event) => {
      const review = (e as CustomEvent).detail;
      for (const [id, p] of pluginsRef.current) {
        if (!p.granted.includes("events.review")) continue;
        controllerFrames.current.get(id)?.contentWindow?.postMessage({ etudePlugin: id, kind: "review", review }, "*");
      }
    };
    window.addEventListener(PLUGIN_REVIEW_EVENT, onRev);
    return () => window.removeEventListener(PLUGIN_REVIEW_EVENT, onRev);
  }, []);

  // Global keyboard shortcut listener for plugin commands.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      for (const cmd of getPluginCommands()) {
        if (matchShortcut(e, cmd.shortcut)) {
          e.preventDefault();
          cmd.run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Central postMessage RPC dispatcher with strict iframe-source + granted-permission checks.
  useEffect(() => {
    const onMsg = async (ev: MessageEvent) => {
      const d = ev.data;
      if (!d || typeof d !== "object" || typeof d.etudePlugin !== "string") return;
      const pluginId = d.etudePlugin as string;
      const plugin = pluginsRef.current.get(pluginId);
      if (!plugin) return;

      const ctrlWin = controllerFrames.current.get(pluginId)?.contentWindow ?? null;
      const viewWin = viewFrames.current.get(pluginId)?.contentWindow ?? null;
      const fromCtrl = !!ctrlWin && ev.source === ctrlWin;
      const fromView = !!viewWin && ev.source === viewWin;
      if (!fromCtrl && !fromView) return;
      const sender = ev.source as Window;

      if (d.kind === "ready") {
        const { vars, colorScheme } = readThemeVars();
        sender.postMessage({ etudePlugin: pluginId, kind: "theme", vars, colorScheme }, "*");
        return;
      }
      if (d.kind === "error") {
        console.warn(`[plugin:${pluginId}]`, d.message);
        return;
      }
      if (d.kind !== "call") return;

      const reply = (ok: boolean, valOrErr: unknown) => {
        sender.postMessage(
          ok
            ? { etudePlugin: pluginId, kind: "reply", id: d.id, ok: true, value: valOrErr }
            : { etudePlugin: pluginId, kind: "reply", id: d.id, ok: false, error: String(valOrErr) },
          "*",
        );
      };

      const granted = new Set(plugin.granted);
      const requirePerm = (perm: string) => {
        if (!granted.has(perm)) throw new Error(`missing permission "${perm}"`);
      };

      try {
        const args = Array.isArray(d.args) ? d.args : [];
        switch (d.op) {
          case "commands.register": {
            requirePerm("ui.commands");
            if (!fromCtrl) throw new Error("commands can only be registered from the plugin controller");
            const spec = args[0] ?? {};
            const cmdId = String(spec.id ?? "").slice(0, 64);
            const label = String(spec.label ?? cmdId).slice(0, 80);
            if (!cmdId) throw new Error("command id required");
            addPluginCommand({
              pluginId,
              pluginName: plugin.manifest.name,
              id: cmdId,
              label,
              shortcut: typeof spec.shortcut === "string" ? spec.shortcut.slice(0, 32) : undefined,
              contextMenu: !!spec.contextMenu,
              run: () => {
                controllerFrames.current.get(pluginId)?.contentWindow?.postMessage(
                  { etudePlugin: pluginId, kind: "runCommand", commandId: cmdId },
                  "*",
                );
              },
            });
            return reply(true, true);
          }
          case "floating.open": {
            requirePerm("ui.floating");
            const opts = args[0] ?? {};
            const view = String(opts.view ?? "");
            if (!plugin.manifest.views || !(view in plugin.manifest.views)) throw new Error(`unknown view "${view}"`);
            const width = clamp(Math.round(Number(opts.width) || 280), 120, 640);
            const height = clamp(Math.round(Number(opts.height) || 240), 40, 640);
            const title = String(opts.title ?? plugin.manifest.name).slice(0, 64);
            setFloating((prev) => {
              const cur = prev[pluginId];
              const x = cur ? cur.x : Math.max(16, window.innerWidth - width - 24);
              const y = cur ? cur.y : Math.max(16, window.innerHeight - height - 72);
              return { ...prev, [pluginId]: { pluginId, view, title, width, height, x, y } };
            });
            return reply(true, true);
          }
          case "floating.close": {
            requirePerm("ui.floating");
            setFloating((prev) => {
              const { [pluginId]: _, ...rest } = prev;
              return rest;
            });
            return reply(true, true);
          }
          case "floating.isOpen": {
            requirePerm("ui.floating");
            return reply(true, !!floatingRef.current[pluginId]);
          }
          case "floating.resize": {
            requirePerm("ui.floating");
            const opts = args[0] ?? {};
            setFloating((prev) => {
              const cur = prev[pluginId];
              if (!cur) return prev;
              const width = opts.width !== undefined ? clamp(Math.round(Number(opts.width)), 120, 640) : cur.width;
              const height = opts.height !== undefined ? clamp(Math.round(Number(opts.height)), 40, 640) : cur.height;
              return { ...prev, [pluginId]: { ...cur, width, height } };
            });
            return reply(true, true);
          }
          case "floating.post": {
            requirePerm("ui.floating");
            const target = fromCtrl ? viewWin : ctrlWin;
            target?.postMessage({ etudePlugin: pluginId, kind: "message", payload: args[0] }, "*");
            return reply(true, true);
          }
          case "storage.get": {
            requirePerm("storage");
            const r = await api.pluginKvGet(pluginId, String(args[0] ?? ""));
            return reply(true, r.value);
          }
          case "storage.set": {
            requirePerm("storage");
            const r = await api.pluginKvSet(pluginId, String(args[0] ?? ""), args[1]);
            return reply(true, r.value);
          }
          case "storage.getAll": {
            requirePerm("storage");
            const r = await api.pluginKvGetAll(pluginId);
            return reply(true, r.kv);
          }
          case "storage.appendEvent": {
            requirePerm("storage");
            const r = await api.pluginAppendEvent(pluginId, String(args[0] ?? ""), args[1]);
            return reply(true, r);
          }
          case "storage.listEvents": {
            requirePerm("storage");
            const r = await api.pluginListEvents(pluginId, args[0] ?? {});
            return reply(true, r.events);
          }
          case "notify": {
            requirePerm("notify");
            const opts = args[0] ?? {};
            const title = String(opts.title ?? plugin.manifest.name).slice(0, 120);
            const description = typeof opts.description === "string" ? opts.description.slice(0, 240) : undefined;
            if (opts.chime) playPluginChime();
            const actionLabel = typeof opts.actionLabel === "string" ? opts.actionLabel.slice(0, 40) : undefined;
            const actionId = typeof opts.actionId === "string" ? opts.actionId.slice(0, 64) : undefined;
            toast(title, {
              description,
              ...(actionLabel && actionId
                ? {
                    action: {
                      label: actionLabel,
                      onClick: () => {
                        controllerFrames.current.get(pluginId)?.contentWindow?.postMessage(
                          { etudePlugin: pluginId, kind: "action", actionId },
                          "*",
                        );
                      },
                    },
                  }
                : {}),
            });
            return reply(true, true);
          }
          case "read.decks": {
            requirePerm("read.decks");
            const decks = await api.decks();
            return reply(
              true,
              decks.map((d) => ({ name: d.name, cards: d.cards, new: d.new, learning: d.learning, review: d.review })),
            );
          }
          case "read.cards": {
            requirePerm("read.cards");
            const q = typeof args[0]?.query === "string" ? args[0].query : "";
            const res = await api.search(q, { limit: Math.min(200, Number(args[0]?.limit) || 50) });
            return reply(true, res.rows);
          }
          case "read.reviews": {
            requirePerm("read.reviews");
            const days = clamp(Number(args[0]?.days) || 30, 1, 365);
            const stats = await api.stats({}, days);
            return reply(true, { today: stats.today, streak: stats.streak, days: stats.days });
          }
          case "read.notes": {
            requirePerm("read.notes");
            const notes = await api.notes();
            return reply(
              true,
              notes.map((n) => ({ id: n.id, title: n.title, kind: n.kind, updated: n.updated })),
            );
          }
          case "write.createCard": {
            requirePerm("write.cards");
            const spec = args[0] ?? {};
            const id = typeof spec.id === "string" && spec.id.trim() ? spec.id.trim() : `${pluginId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            const res = await api.saveItem(id, {
              type: String(spec.type ?? "basic"),
              deck: String(spec.deck ?? "Default"),
              fields: typeof spec.fields === "object" && spec.fields ? spec.fields : {},
              tags: Array.isArray(spec.tags) ? spec.tags.map(String) : [],
            });
            return reply(true, res);
          }
          case "write.createNote": {
            requirePerm("write.notes");
            const spec = args[0] ?? {};
            const res = await api.createNote({
              title: String(spec.title ?? ""),
              parentId: typeof spec.parentId === "string" ? spec.parentId : undefined,
            });
            return reply(true, { id: res.id, title: res.title });
          }
          default:
            throw new Error(`unknown plugin operation "${String(d.op)}"`);
        }
      } catch (e) {
        reply(false, (e as Error).message || "plugin error");
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const closeFloating = (id: string) =>
    setFloating((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });

  const moveFloating = (id: string, x: number, y: number) =>
    setFloating((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], x, y } } : prev));

  return (
    <>
      {plugins.map((p) => (
        <PluginControllerIframe
          key={`${p.id}:${p.hash}:${p.granted.join(",")}`}
          plugin={p}
          onRef={(el) => {
            if (el) controllerFrames.current.set(p.id, el);
            else controllerFrames.current.delete(p.id);
          }}
        />
      ))}
      {Object.values(floating).map((f) => {
        const plugin = plugins.find((p) => p.id === f.pluginId);
        if (!plugin) return null;
        return (
          <FloatingPanel
            key={`${f.pluginId}:${f.view}:${plugin.hash}`}
            panel={f}
            plugin={plugin}
            onClose={() => closeFloating(f.pluginId)}
            onMove={(x, y) => moveFloating(f.pluginId, x, y)}
            onFrameRef={(el) => {
              if (el) viewFrames.current.set(f.pluginId, el);
              else viewFrames.current.delete(f.pluginId);
            }}
          />
        );
      })}
    </>
  );
}

function PluginControllerIframe({ plugin, onRef }: { plugin: InstalledPluginInfo; onRef(el: HTMLIFrameElement | null): void }) {
  const frameProps = usePluginFrameSrc(`/frame-plugin/${encodeURIComponent(plugin.id)}/main`);
  if (!frameProps.src && !frameProps.srcDoc) return null;
  return (
    <iframe
      ref={onRef}
      title={`Plugin ${plugin.manifest.name}`}
      sandbox="allow-scripts"
      aria-hidden="true"
      tabIndex={-1}
      style={{ display: "none" }}
      {...frameProps}
    />
  );
}

function FloatingPanel({
  panel,
  plugin,
  onClose,
  onMove,
  onFrameRef,
}: {
  panel: FloatingState;
  plugin: InstalledPluginInfo;
  onClose(): void;
  onMove(x: number, y: number): void;
  onFrameRef(el: HTMLIFrameElement | null): void;
}) {
  const frameProps = usePluginFrameSrc(`/frame-plugin/${encodeURIComponent(panel.pluginId)}/view/${encodeURIComponent(panel.view)}`);
  const [dragging, setDragging] = useState(false);

  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const ox = e.clientX - panel.x;
    const oy = e.clientY - panel.y;
    setDragging(true);
    const onMoveEvt = (ev: PointerEvent) => {
      const nx = clamp(ev.clientX - ox, 8, Math.max(8, window.innerWidth - panel.width - 8));
      const ny = clamp(ev.clientY - oy, 8, Math.max(8, window.innerHeight - panel.height - 40));
      onMove(nx, ny);
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMoveEvt);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMoveEvt);
    window.addEventListener("pointerup", onUp);
  };

  return createPortal(
    <div
      role="region"
      aria-label={panel.title}
      data-plugin-floating={panel.pluginId}
      className="fixed z-40 overflow-hidden rounded-2xl border border-border bg-card/95 shadow-[0_14px_38px_rgb(0_0_0/0.24)] backdrop-blur-md"
      style={{ left: panel.x, top: panel.y, width: panel.width }}
    >
      <div
        onPointerDown={startDrag}
        className="flex h-8 cursor-grab items-center gap-1.5 border-b border-border/70 px-2.5 select-none active:cursor-grabbing"
      >
        <GripHorizontal className="size-3.5 text-muted-foreground/70" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/90">{panel.title}</span>
        <button
          type="button"
          aria-label={`Close ${panel.title}`}
          onClick={onClose}
          className="grid size-5 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {(frameProps.src || frameProps.srcDoc) && (
        <iframe
          ref={onFrameRef}
          title={`${plugin.manifest.name}: ${panel.title}`}
          sandbox="allow-scripts"
          style={{ width: panel.width, height: panel.height, display: "block", border: 0, pointerEvents: dragging ? "none" : "auto" }}
          {...frameProps}
        />
      )}
    </div>,
    document.body,
  );
}
