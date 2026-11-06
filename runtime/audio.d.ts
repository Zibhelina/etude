// Types for audio.js (etude.play and routing <audio> through Web Audio in card frames).
export interface Sound {
  /** Stops the sound, or keeps it from starting. */
  stop(): void;
  /** `true` once it played to the end, `false` if it was stopped, replaced or couldn't play. Never rejects. */
  finished: Promise<boolean>;
}
export function affected(win: any): boolean;
export function cardAudio(win?: any, opts?: { webAudio?: boolean }): { play(url: unknown): Sound; install(): void };
