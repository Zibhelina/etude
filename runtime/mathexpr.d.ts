// Types for mathexpr.js (math answers: parse, evaluate, LaTeX, equivalence).
export type MathNode = { t: string; [k: string]: unknown };
export interface CheckOptions {
  form?: "any" | "exact" | "same";
  ordered?: boolean;
  tolerance?: number;
}
export class MathSyntaxError extends Error {}
export function parse(input: string): MathNode;
export function evaluate(node: MathNode, env?: Record<string, number>): number;
export function variables(node: MathNode, out?: Set<string>): Set<string>;
export function toLatex(node: MathNode): string;
export function canonical(node: MathNode): string;
export function hasDecimal(node: MathNode): boolean;
export function equivalent(a: string | MathNode, b: string | MathNode, opts?: CheckOptions): { equal: boolean; score: number };
export function check(answer: string, accepted: string | string[], opts?: CheckOptions): { score: number; feedback?: string; latex: string | null };
declare const math: {
  parse: typeof parse;
  evaluate: typeof evaluate;
  variables: typeof variables;
  toLatex: typeof toLatex;
  canonical: typeof canonical;
  hasDecimal: typeof hasDecimal;
  equivalent: typeof equivalent;
  check: typeof check;
  MathSyntaxError: typeof MathSyntaxError;
};
export { math };
export default math;
