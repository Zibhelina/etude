// Etude's mark: a Computer Modern epsilon, the mathematician's "small quantity".
export const EPSILON_PATH = "M428 393Q428 378 416.0 367.0Q404 356 391 356Q382 356 369 365Q333 392 283 392Q198 392 149 359Q116 339 116 308Q116 289 133 272Q142 263 145.0 262.0Q148 261 157 264Q188 278 238 278Q256 278 265.5 277.5Q275 277 286.5 274.0Q298 271 303.0 264.5Q308 258 308 247Q308 225 287 215Q270 206 223.0 206.0Q176 206 142 219L132 212Q68 169 68 112Q68 39 201 39Q315 39 348 99Q351 105 362 105Q376 103 376 88Q376 81 372 73Q350 29 302.0 3.5Q254 -22 190 -22Q108 -22 63 23Q27 57 27 107Q27 150 59 194Q72 211 97 232L107 239L99 248Q76 273 76 304Q76 338 97 364Q123 399 171.0 423.0Q219 447 275 452H290Q359 452 405 421Q428 406 428 393Z";

export function Logo({ className, tile = false }: { className?: string; tile?: boolean }) {
  return tile ? (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#000000" />
      <path d={EPSILON_PATH} className="fill-highlight" transform="translate(5.809 18.532) scale(0.03038 -0.03038)" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d={EPSILON_PATH} className="fill-highlight" transform="translate(2.324 21.144) scale(0.04253 -0.04253)" />
    </svg>
  );
}

/** The wordmark: "εtude" in Computer Modern, with the epsilon in the accent color. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className} style={{ fontFamily: "KaTeX_Main, 'Latin Modern Roman', serif" }} aria-label="Etude">
      <span className="text-highlight" style={{ fontFamily: "KaTeX_Math, 'Latin Modern Math', serif" }}>ε</span>tude
    </span>
  );
}
