// The holiday extras (lib/holiday): the trim on today's session (holly; Cozy adds a garland), the snow layer
// and the Holidays block in Settings → Appearance. Snow never falls on the study screen, and reduced motion
// keeps it off.
import { useMemo } from "react";
import { toast } from "sonner";
import holly from "@/assets/holiday/holly.webp";
import garland from "@/assets/holiday/garland.webp";
import { BigSwitch, Block } from "@/components/settings-ui";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { inSeason, setHoliday, useHoliday, type HolidayDecor, type HolidayMode, type HolidayPrefs } from "@/lib/holiday";
import { faceSrc } from "@/lib/minimi-face";

/** Sits inside a `relative` card: a garland along its top and a holly sprig on its corner. */
export function HolidayTrim() {
  const h = useHoliday();
  if (!h.active || h.holidayDecor === "none") return null;
  return (
    <>
      <img src={garland} alt="" aria-hidden draggable={false} className="holiday-garland" />
      <img src={holly} alt="" aria-hidden draggable={false} className="holiday-holly" />
    </>
  );
}

/** A few slow flakes over the page (never on the study screen). */
export function HolidaySnow({ hidden }: { hidden?: boolean }) {
  const h = useHoliday();
  const flakes = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => {
        const r = (n: number) => ((Math.sin((i + 1) * 9301 + n * 49297) * 233280) % 1 + 1) % 1; // stable per flake
        const z = 2 + r(1) * 3;
        return { left: `${r(2) * 100}%`, width: z, height: z, "--o": 0.35 + r(3) * 0.35, "--dx": `${(r(4) - 0.5) * 80}px`, animationDuration: `${14 + r(5) * 12}s`, animationDelay: `${-r(6) * 26}s` } as React.CSSProperties;
      }),
    [],
  );
  if (hidden || !h.active || !h.holidaySnow) return null;
  return (
    <div className="holiday-snow" aria-hidden>
      {flakes.map((s, i) => <i key={i} style={s} />)}
    </div>
  );
}

const save = async (patch: Partial<HolidayPrefs>, before: HolidayPrefs) => {
  try {
    await setHoliday(patch);
  } catch (e) {
    setHoliday(before, { save: false });
    toast.error("Couldn't save", { description: (e as Error).message });
  }
};

/** Settings → Appearance → Holidays. */
export function HolidayBlock() {
  const h = useHoliday();
  const before: HolidayPrefs = { holiday: h.holiday, holidayDecor: h.holidayDecor, holidaySnow: h.holidaySnow };
  const when = h.holiday === "auto" ? (inSeason() ? "On now, until Jan 6." : "Comes on by itself on Dec 1 and goes away after Jan 6.") : h.holiday === "on" ? "On until you set it back." : "Off all year.";
  const item = "phone:h-10 h-8 px-3 text-[13px]";
  return (
    <>
      <Block
        title="Holidays"
        description={<>Minimi wears a Santa hat and a scarf, and the extras below show up. {when}</>}
        stackAside
        aside={
          <div className="flex items-center gap-3">
            {h.active && <img src={faceSrc("deadpan")} alt="" className="size-9 rounded-full bg-muted object-cover" draggable={false} />}
            <ToggleGroup type="single" variant="outline" value={h.holiday} onValueChange={(v) => v && save({ holiday: v as HolidayMode }, before)} aria-label="Holidays">
              <ToggleGroupItem value="auto" className={item}>Auto</ToggleGroupItem>
              <ToggleGroupItem value="on" className={item}>On</ToggleGroupItem>
              <ToggleGroupItem value="off" className={item}>Off</ToggleGroupItem>
            </ToggleGroup>
          </div>
        }
      />
      {h.holiday !== "off" && (
        <>
          <Block
            title="Decorations"
            description="A garland and a holly sprig on today's session. A few and Cozy look the same for now."
            stackAside
            aside={
              <ToggleGroup type="single" variant="outline" value={h.holidayDecor} onValueChange={(v) => v && save({ holidayDecor: v as HolidayDecor }, before)} aria-label="Decorations">
                <ToggleGroupItem value="none" className={item}>None</ToggleGroupItem>
                <ToggleGroupItem value="few" className={item}>A few</ToggleGroupItem>
                <ToggleGroupItem value="cozy" className={item}>Cozy</ToggleGroupItem>
              </ToggleGroup>
            }
          />
          <Block
            title="Snow"
            description="A few slow flakes in the background. Never while you study."
            aside={<BigSwitch id="holiday-snow" checked={h.holidaySnow} onCheckedChange={(v) => save({ holidaySnow: v }, before)} aria-label="Snow" />}
          />
        </>
      )}
    </>
  );
}
