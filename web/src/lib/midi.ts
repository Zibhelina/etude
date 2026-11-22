// Host-side Web MIDI bridge for sandboxed card frames and HTML widgets.
// Frames keep their opaque sandbox origin (`sandbox="allow-scripts"`) and receive
// non-sysex MIDI input messages from Etude's own main frame over postMessage.

export interface MidiState {
  ok: boolean;
  supported: boolean;
  inputs: string[];
  error?: string;
}

export interface MidiSubscriber {
  onState(state: MidiState): void;
  onMessage(data: number[], input: string): void;
}

const subscribers = new Set<MidiSubscriber>();
let access: MIDIAccess | null = null;
let pending: Promise<MIDIAccess> | null = null;
const bound = new Set<MIDIInput>();
let lastState: MidiState = { ok: false, supported: typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function", inputs: [] };

function connectedInputs(acc: MIDIAccess): MIDIInput[] {
  const list: MIDIInput[] = [];
  for (const inp of acc.inputs.values()) {
    if (inp.state === "connected") list.push(inp);
  }
  return list;
}

function sameState(a: MidiState, b: MidiState): boolean {
  return a.ok === b.ok && a.supported === b.supported && a.error === b.error && a.inputs.length === b.inputs.length && a.inputs.every((x, i) => x === b.inputs[i]);
}

function broadcastState(state: MidiState, force = false) {
  if (!force && sameState(lastState, state)) return;
  lastState = state;
  for (const sub of subscribers) {
    try {
      sub.onState(state);
    } catch {}
  }
}

function wireInputs(acc: MIDIAccess, forceBroadcast = false): MidiState {
  const active = connectedInputs(acc);
  const activeSet = new Set(active);
  for (const old of [...bound]) {
    if (!activeSet.has(old)) {
      old.onmidimessage = null;
      bound.delete(old);
    }
  }
  for (const inp of active) {
    if (bound.has(inp)) continue;
    const label = inp.name || inp.manufacturer || "MIDI";
    inp.onmidimessage = (ev: MIDIMessageEvent) => {
      if (!ev.data || !ev.data.length || !subscribers.size) return;
      const st = ev.data[0];
      // Never forward SysEx (0xf0..0xf7) or realtime clock/active-sensing spam (0xf8..0xff).
      if (st >= 0xf0) return;
      const bytes = Array.from(ev.data);
      for (const sub of subscribers) {
        try {
          sub.onMessage(bytes, label);
        } catch {}
      }
    };
    bound.add(inp);
  }
  const names = active.map((i) => i.name || i.manufacturer || "MIDI");
  const state: MidiState = { ok: true, supported: true, inputs: names };
  broadcastState(state, forceBroadcast);
  return state;
}

export function subscribeMidi(sub: MidiSubscriber): () => void {
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
    if (!subscribers.size && access) {
      for (const inp of bound) inp.onmidimessage = null;
      bound.clear();
    }
  };
}

export async function connectMidi(): Promise<MidiState> {
  if (typeof navigator === "undefined" || typeof navigator.requestMIDIAccess !== "function") {
    const s: MidiState = { ok: false, supported: false, inputs: [], error: "Web MIDI is not supported in this browser" };
    broadcastState(s);
    return s;
  }
  if (access) return wireInputs(access);
  try {
    pending ??= navigator.requestMIDIAccess({ sysex: false });
    const acc = await pending;
    access = acc;
    acc.onstatechange = () => {
      if (subscribers.size) wireInputs(acc);
    };
    return wireInputs(acc);
  } catch (err) {
    pending = null;
    const s: MidiState = {
      ok: false,
      supported: true,
      inputs: [],
      error: err instanceof Error ? err.message : String(err || "MIDI access denied"),
    };
    broadcastState(s);
    return s;
  }
}

export function midiState(): MidiState {
  return lastState;
}
