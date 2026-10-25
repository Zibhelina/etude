// FSRS weights fitted to a review history with fsrs-rs, the optimizer Anki uses, through the optional
// package @open-spaced-repetition/binding. It is loaded the first time someone optimizes.
import { generatorParameters } from "ts-fsrs";

export const OPTIMIZER_PACKAGE = "@open-spaced-repetition/binding";
/** Below this, fsrs-rs quietly returns the defaults and can't evaluate a fit. */
export const MIN_REVIEWS = 400;

export interface HistoryReview {
  cardId: number;
  ts: string;
  rating: number;
  /** The card's state before the review: 0 new, 1 learning, 2 review, 3 relearning. */
  state: number;
  durationMs: number | null;
}

export interface Fit {
  logLoss: number;
  /** RMSE over binned predictions, as Anki reports it. */
  rmse: number;
}

export class OptimizerMissing extends Error {}

let loaded: Promise<any> | null = null;
function binding(): Promise<any> {
  const name = OPTIMIZER_PACKAGE;
  return (loaded ??= import(name).catch(() => {
    loaded = null;
    throw new OptimizerMissing(`the FSRS optimizer isn't installed: run \`npm install ${OPTIMIZER_PACKAGE}\` in the Etude folder`);
  }));
}

export const defaultWeights = (): number[] => [...generatorParameters().w];

/** Minutes east of UTC in a time zone at an instant, which fsrs-rs needs to find day boundaries. */
function offsetMinutes(timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
  return (ms: number) => {
    const name = fmt.formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(name);
    return m ? (m[1] === "+" ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  };
}

export async function fitWeights(
  reviews: HistoryReview[],
  opts: { current: number[] | null | undefined; dayStartHour: number; timeZone: string; enableShortTerm: boolean; relearningSteps: number },
): Promise<{ weights: number[]; items: number; before: Fit; after: Fit }> {
  const b = await binding();
  // review_state uses the same codes Etude stores (the card's state before the review), not Anki's revlog kinds:
  // reading reviews as learning steps leaves fsrs-rs with too few long-term reviews and wildly long stabilities.
  const csv = "card_id,review_time,review_rating,review_state,review_duration\n" + reviews.map((r) => `${r.cardId},${Date.parse(r.ts)},${r.rating},${r.state},${r.durationMs ?? 0}`).join("\n");
  const items = b.convertCsvToFsrsItems(Buffer.from(csv), opts.dayStartHour, opts.timeZone, offsetMinutes(opts.timeZone));
  const weights: number[] = await b.computeParameters(items, { enableShortTerm: opts.enableShortTerm, numRelearningSteps: opts.relearningSteps });
  const fit = (w: number[]): Fit => {
    const e = new b.FSRSBinding(w).evaluate(items);
    return { logLoss: e.logLoss, rmse: e.rmseBins };
  };
  const current = opts.current?.length ? opts.current : defaultWeights();
  return { weights, items: items.length, before: fit(current), after: fit(weights) };
}
