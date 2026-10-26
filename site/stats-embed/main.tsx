// The live Stats panels on the website: the app's own components, fed by snapshots of a demo
// collection (site/tools/stats-snapshot.mjs). Each `[data-live]` element on the page gets one panel.
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ForgettingCurve, Histogram, StudyClock, useWidth } from "@/components/stats-viz";
import { Forecast, Overview, PracticePanel, Schedulers, WeakTags } from "@/pages/stats";
import type { Stats } from "@/lib/api";
import demoSnap from "../src/assets/stats-data/demo.json";
import drillSnap from "../src/assets/stats-data/drill.json";
import "./embed.css";

const demo = demoSnap.stats as unknown as Stats;
const drill = drillSnap.stats as unknown as Stats;
const target = demo.desiredRetention ?? 0.9;

/** The room a panel has: its width, and the height every No. 5 panel is drawn to so tabs don't jump. */
type Room = { w: number; h: number; phone: boolean };

function Fit({ children }: { children: (r: Room) => ReactNode }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const phone = w > 0 && w < 560;
  const h = phone ? 420 : 420;
  return <div ref={ref}>{w > 0 && children({ w, h, phone })}</div>;
}

function Memory({ h }: Room) {
  const s = demo;
  return (
    <Histogram
      label="Studied cards by stability"
      height={h - 92}
      bars={s.stability.map((b, i) => {
        const lo = i ? s.stability[i - 1].upTo! : 0;
        const name = b.upTo == null ? `${lo}d+` : i === 0 ? "<1d" : `${lo}–${b.upTo}d`;
        return { key: name, value: b.cards, label: name.replace(/d\+?$/, (m) => (m === "d+" ? "+" : "")), color: "var(--review)", tip: `${b.cards} card${b.cards === 1 ? "" : "s"} · stability ${name}` };
      })}
    />
  );
}

const PANELS: Record<string, () => ReactNode> = {
  overview: () => <Fit>{({ phone }) => <Overview stats={demo} deck="Demo" ring={phone ? 148 : 204} />}</Fit>,
  curve: () => <Fit>{({ h, phone }) => <ForgettingCurve curve={demo.curve} target={target} height={h - (phone ? 90 : 76)} />}</Fit>,
  memory: () => <Fit>{(r) => <Memory {...r} />}</Fit>,
  clock: () => <Fit>{({ w, h, phone }) => <StudyClock hours={demo.hours} target={target} size={phone ? Math.min(w - 16, 320) : Math.min(h - 40, 380)} />}</Fit>,
  tags: () => <Fit>{({ phone }) => <WeakTags tree={demo.tagTree} target={target} limit={phone ? 5 : 7} />}</Fit>,
  forecast: () => <Fit>{({ h, phone }) => <Forecast stats={demo} deck="Demo" height={h - (phone ? 130 : 110)} />}</Fit>,
  drill: () => <PracticePanel card={drill.practice[0]} />,
  schedulers: () => <Schedulers list={drill.schedulers} />,
};

for (const el of document.querySelectorAll<HTMLElement>("[data-live]")) {
  const panel = PANELS[el.dataset.live!];
  if (!panel) continue;
  el.classList.add("lv", "dark");
  el.replaceChildren();
  createRoot(el).render(<StrictMode>{panel()}</StrictMode>);
  el.dataset.ready = "";
}
