// Pomodoro plugin controller: registers Ctrl/⌘K & right-click commands and coordinates timer state
// in plugin storage so it survives reloads and stays consistent across screens.
const MIN = 60_000;
const DEFAULT = {
  phase: "focus",
  running: false,
  endsAt: null,
  left: 25 * MIN,
  done: 0,
  mins: { focus: 25, short: 5, long: 15 },
  every: 4,
  auto: false,
  folded: false,
};

const total = (s, p = s.phase) => (s.mins?.[p] ?? 25) * MIN;
const remaining = (s, now) => (s.running && s.endsAt != null ? Math.max(0, s.endsAt - now) : s.left);

async function readState() {
  const saved = await etude.storage.get("state");
  if (!saved || typeof saved !== "object") return { ...DEFAULT, mins: { ...DEFAULT.mins } };
  return { ...DEFAULT, ...saved, mins: { ...DEFAULT.mins, ...(saved.mins ?? {}) } };
}

async function writeState(next) {
  await etude.storage.set("state", next);
  etude.floating.post({ type: "state", state: next });
  return next;
}

async function toggleTimer() {
  const s = await readState();
  const now = Date.now();
  const next = s.running
    ? { ...s, running: false, endsAt: null, left: remaining(s, now) }
    : { ...s, running: true, endsAt: now + (s.left > 0 ? s.left : total(s)) };
  await writeState(next);
  if (!(await etude.floating.isOpen())) {
    await etude.floating.open({ view: "timer", title: "Pomodoro", width: 272, height: 326 });
  }
}

async function resetTimer() {
  const s = await readState();
  await writeState({ ...s, running: false, endsAt: null, left: total(s) });
}

etude.commands.register({
  id: "toggle-view",
  label: "Pomodoro: Show / hide timer",
  shortcut: "Mod+Alt+P",
  contextMenu: true,
  async run() {
    if (await etude.floating.isOpen()) await etude.floating.close();
    else {
      const s = await readState();
      await etude.floating.open({ view: "timer", title: "Pomodoro", width: s.folded ? 156 : 272, height: s.folded ? 46 : 326 });
    }
  },
});

etude.commands.register({
  id: "start-pause",
  label: "Pomodoro: Start / pause",
  async run() {
    await toggleTimer();
  },
});

etude.commands.register({
  id: "reset",
  label: "Pomodoro: Reset current phase",
  async run() {
    await resetTimer();
  },
});

etude.onAction(async (actionId) => {
  if (actionId === "start-next") await toggleTimer();
});

// Keep timer running across reloads if a phase is active.
const initial = await readState();
if (initial.running) {
  await etude.floating.open({ view: "timer", title: "Pomodoro", width: initial.folded ? 156 : 272, height: initial.folded ? 46 : 326 });
}
