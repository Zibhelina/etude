// Plugin runtime registry shared across the app (PluginHost, Ctrl/⌘K DeckFinder, right-click menu, Study).
import { useEffect, useState } from "react";

export const PLUGINS_EVENT = "etude:plugins-changed";
export const PLUGIN_COMMANDS_EVENT = "etude:plugin-commands-changed";
export const PLUGIN_REVIEW_EVENT = "etude:plugin-review";

export function notifyPluginsChanged() {
  window.dispatchEvent(new Event(PLUGINS_EVENT));
}

export interface PluginCommand {
  pluginId: string;
  pluginName: string;
  id: string;
  label: string;
  shortcut?: string;
  contextMenu?: boolean;
  run(): void;
}

const commandMap = new Map<string, PluginCommand[]>();

function notifyCommands() {
  window.dispatchEvent(new Event(PLUGIN_COMMANDS_EVENT));
}

export function setPluginCommands(pluginId: string, cmds: PluginCommand[]) {
  if (cmds.length) commandMap.set(pluginId, cmds);
  else commandMap.delete(pluginId);
  notifyCommands();
}

export function addPluginCommand(cmd: PluginCommand) {
  const prev = commandMap.get(cmd.pluginId) ?? [];
  const next = [...prev.filter((c) => c.id !== cmd.id), cmd];
  commandMap.set(cmd.pluginId, next);
  notifyCommands();
}

export function clearPluginCommands(pluginId: string) {
  if (commandMap.delete(pluginId)) notifyCommands();
}

export function getPluginCommands(): PluginCommand[] {
  const out: PluginCommand[] = [];
  for (const list of commandMap.values()) out.push(...list);
  return out;
}

export function usePluginCommands(): PluginCommand[] {
  const [cmds, setCmds] = useState<PluginCommand[]>(() => getPluginCommands());
  useEffect(() => {
    const h = () => setCmds(getPluginCommands());
    window.addEventListener(PLUGIN_COMMANDS_EVENT, h);
    return () => window.removeEventListener(PLUGIN_COMMANDS_EVENT, h);
  }, []);
  return cmds;
}

/** Emits a review completion event to enabled plugins that have `events.review` granted. */
export function emitPluginReview(review: { cardId: number; rating: number; deck?: string; durationMs?: number }) {
  window.dispatchEvent(new CustomEvent(PLUGIN_REVIEW_EVENT, { detail: review }));
}

/** Gentle two-note chime for plugin notifications (Pomodoro phase done, etc.). */
export function playPluginChime() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const tones = [523.25, 659.25]; // C5 -> E5
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + i * 0.14);
      gain.gain.setValueAtTime(0.0001, now + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.09, now + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.34);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.36);
    });
    window.setTimeout(() => void ctx.close().catch(() => {}), 900);
  } catch {
    // AudioContext blocked or unavailable.
  }
}
