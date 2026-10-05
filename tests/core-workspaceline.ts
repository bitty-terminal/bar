/**
 * Reference model of the Core workspaceline that ADR-0014 retires
 * (bitty@55f9d336 `crates/bitty-runtime/src/runtime/workspaces.rs`:
 * `workspaceline_text`, `workspaceline_tokens`, `bar_present`,
 * `status_bar_text`, `workspaceline_hit_test`, `workspaceline_click`).
 *
 * Kept deliberately literal so the parity tests compare the plugin against
 * the Core behavior, not against a restatement of the plugin.
 *
 * Re-verify: rebuild Core at bitty@55f9d336 and rerun the live-host parity
 * proof per the W-104 procedure before changing this model.
 */

export const WORKSPACE_NAME_MAX_CHARS = 32;
export const WORKSPACELINE_MAX_CHARS = 1024; // bytes, cut on a char boundary
export const MAX_WORKSPACES = 16;

export interface CoreSlot {
  readonly name: string;
  /** Stable workspace seq (Core `slot.seq`); labels never renumber on close. */
  readonly seq: number;
}

export interface CoreState {
  readonly workspaces: readonly CoreSlot[];
  /** 0-based active index. */
  readonly active: number;
  /** `workspace.show_bar`. */
  readonly visible: boolean;
}

function truncateWsName(name: string): string {
  const chars = [...name];
  return chars.length <= WORKSPACE_NAME_MAX_CHARS
    ? name
    : chars.slice(0, WORKSPACE_NAME_MAX_CHARS).join("");
}

function tokens(state: CoreState): string[] {
  return state.workspaces.map(
    (slot, idx) =>
      `${slot.seq}:${truncateWsName(slot.name)}${idx === state.active ? "*" : ""}`,
  );
}

/** Rust `String::truncate` at the last char boundary at or below `max`. */
function truncateBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end));
}

export function workspacelineText(state: CoreState): string {
  const out = `${tokens(state).join(" ")} (${state.workspaces.length})`;
  return truncateBytes(out, WORKSPACELINE_MAX_CHARS);
}

export function barPresent(state: CoreState): boolean {
  return state.visible && state.workspaces.length !== 1;
}

/** What chrome paints; `undefined` when the bar is hidden. */
export function statusBarText(state: CoreState): string | undefined {
  if (!barPresent(state)) return undefined;
  if (state.workspaces.length === 0) return "\u2014";
  return workspacelineText(state);
}

/** 0-based workspace index under bar `column` (characters), if any. */
export function hitTest(state: CoreState, column: number): number | undefined {
  if (!barPresent(state)) return undefined;
  let start = 0;
  const list = tokens(state);
  for (let idx = 0; idx < list.length; idx += 1) {
    const width = [...list[idx]!].length;
    if (column >= start && column < start + width) return idx;
    start += width + 1;
  }
  return undefined;
}

/** Index a click at `column` switches to; `undefined` when nothing changes. */
export function click(state: CoreState, column: number): number | undefined {
  const target = hitTest(state, column);
  if (target === undefined || target === state.active) return undefined;
  return target;
}
