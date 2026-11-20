// Types for dock.js (the app shows a card's one text field at the bottom of a phone screen).
export interface DockField {
  placeholder: string;
  value: string;
  type: string;
  inputMode: string;
  autocapitalize: string;
  autocomplete: string;
  spellcheck: boolean;
  maxLength: number | null;
  label: string;
}
export interface DockPrompt {
  kicker: string;
  kickerColor: string;
  question: string;
}
export function dockableField(root: any, visible?: (el: any) => boolean): any;
export function inSentence(el: any, root: any): boolean;
export function wrapperOf(el: any, root: any): any;
export function describe(el: any): DockField;
export function pictureOf(root: any, field: any, visible?: (el: any) => boolean): { el: any; box: any } | null;
export function promptOf(root: any, skip?: any[], visible?: (el: any) => boolean, until?: any): DockPrompt;
export function installDock(
  api: { root: any; mode: string },
  send: (type: string, data?: Record<string, unknown>) => void,
  visible?: (el: any) => boolean,
): { check(): void; stop(): void; readonly docked: boolean; setValue(value: unknown): void; stage(height: number | null): void };
