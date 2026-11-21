/**
 * Runs `lua/bar/init.lua` in a real Lua 5.4 VM (wasmoon) against the SDK
 * mock host (bitty-plugin-sdk `MockHost`).
 *
 * The mock host owns every contract check: manifest linting, capability
 * gates, the activation registration window, scene-node validation, command
 * argument schemas, event declaration, and the bounded workspace request
 * queue. The harness only bridges the injected `bitty` table into Lua and
 * records the last component each block received so tests can read what the
 * host would paint.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MockHost, type WorkspaceInfo } from "bitty-plugin-sdk";
import { LuaFactory, type LuaEngine } from "wasmoon";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MANIFEST_SOURCE = readFileSync(
  join(REPO_ROOT, "bitty-plugin.toml"),
  "utf8",
);
export const ENTRY_SOURCE = readFileSync(
  join(REPO_ROOT, "lua/bar/init.lua"),
  "utf8",
);

/** Capabilities the manifest requests; tests grant all of them by default. */
export const BAR_CAPABILITIES = [
  "ui.rich",
  "ui.overlay",
  "workspace.read",
  "workspace.control",
  "platform.notify",
] as const;

export const FOCUS_COMMAND = "bitty-terminal.bar:focus";
export const HOVER_COMMAND = "bitty-terminal.bar:hover";

/** One command binding, with the optional Core #2248/#2411 region identity. */
export interface Binding {
  readonly command: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly region?: {
    readonly id: string;
    readonly kind: string;
  };
}

/** Scene node shape the plugin emits (v1 Text/Row subset plus #2411). */
export interface SceneNode {
  readonly kind: string;
  readonly text?: string;
  readonly children?: readonly SceneNode[];
  readonly anchor?: string;
  readonly bold?: boolean;
  readonly fg?: string;
  readonly bg?: string;
  readonly on_click?: Binding;
  readonly on_scroll?: Binding;
  readonly on_hover?: Binding;
}

export interface MountRecord {
  readonly slot: string;
  readonly handle: number;
  component: SceneNode;
}

/** Scratchpad occupancy snapshot (Core CTX-0954, bitty PR #1671). */
export interface ScratchpadState {
  readonly count?: unknown;
  readonly occupied?: unknown;
}

/** Workspace row with the defaults the bridge fills in. */
export function ws(
  id: number,
  name: string,
  active = false,
  panelCountOrScratchpad: number | ScratchpadState = 0,
  attention: WorkspaceInfo["attention"] = {
    bell: false,
    activity: false,
    exited: false,
  },
  scratchpad: ScratchpadState = {},
): WorkspaceInfo {
  const panelCount =
    typeof panelCountOrScratchpad === "number" ? panelCountOrScratchpad : 0;
  if (typeof panelCountOrScratchpad === "object") {
    scratchpad = panelCountOrScratchpad;
  }
  const row: Record<string, unknown> = {
    id,
    name,
    active,
    panel_count: panelCount,
    attention,
  };
  // Rows without scratchpad fields model a host without the CTX-0954
  // surface; the plugin must read them as an empty slot (fail closed).
  if (scratchpad.count !== undefined) row.scratchpad_count = scratchpad.count;
  if (scratchpad.occupied !== undefined) {
    row.scratchpad_occupied = scratchpad.occupied;
  }
  return row as WorkspaceInfo;
}

export interface BarRun {
  readonly host: MockHost;
  readonly lua: LuaEngine;
  readonly mounts: MountRecord[];
  /** Last component of the single bar block. */
  component(): SceneNode;
  /** Last component of the `overlay` tooltip block, if mounted. */
  overlay(): SceneNode | undefined;
  /** Painted text of the overlay tooltip block ("" when absent). */
  overlayText(): string;
  /** Sets the fake `os.time` epoch (`fakeNow` option required). */
  setNow(seconds: number): void;
  /** Number of `bitty.ui.update` calls the plugin issued on any block. */
  updates(): number;
  /** Number of `bitty.ui.update` calls that targeted the overlay block. */
  overlayUpdates(): number;
  /**
   * `bitty.ui.catalog` constructor spellings the plugin attempted, in call
   * order, including attempts the constructor rejected. Empty when the
   * harness models a host below the surface (`withoutCatalog`).
   */
  catalogCalls(): readonly string[];
  /** Audio control calls the plugin issued through the stubbed broker. */
  audioControl(): {
    readonly toggles: number;
    readonly steps: readonly unknown[];
    readonly sourceToggles: number;
    readonly sourceSteps: readonly unknown[];
  };
  /** Number of `audio.spectrum.spectrum()` calls the plugin issued. */
  audioSpectrumCalls(): number;
  close(): void;
}

/** Audio state snapshot served by the stubbed `audio.state` broker. */
export interface AudioStateFixture {
  readonly volume_pct: number;
  readonly muted: boolean;
  readonly port: string;
  /** Optional source (microphone) fields; absent models the live reader. */
  readonly source_volume_pct?: number;
  readonly source_muted?: boolean;
  readonly stale_age_ms?: number;
}

export interface BarRunOptions {
  readonly workspaces?: readonly WorkspaceInfo[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly grants?: readonly string[];
  /**
   * Fixture broker providers keyed by short interface name, in one of two
   * stub shapes (one entry per interface). The harness serves these from the
   * bridged `bitty.services.get` before the mock's own directory (which
   * stays empty in bar tests, so an unlisted interface resolves exactly like
   * an ungranted or absent provider: nil with `optional = true`,
   * `E_SERVICE_RESOLUTION` otherwise).
   * - Device fixtures (Phase B device modules) carry `version` + `impl`: a
   *   plain service implementation served when the fixture version satisfies
   *   the requested range. Versions are checked with a minimal `^`/`>=`
   *   comparison, documented as a test-only approximation of the SDK range
   *   grammar.
   * - Sensor stubs (Phase B sensor modules: `system.cpu`, `system.memory`,
   *   `system.battery`) carry `snapshot` / `resolutionError` / `callError`.
   *   The pinned SDK mock predates the sensor providers: it has no host-side
   *   provider injection and its manifest model rejects the production
   *   `[services.required]` + `platform.*-read` declarations, so the harness
   *   overrides the bridged `bitty.services.get` with these stubs.
   *   `snapshot` is the table `get()` serves, or a function returning it (a
   *   fresh call per poll, so tests can mutate readings between ticks);
   *   `null`/missing models a stale-past-horizon provider (hide).
   *   `resolutionError` makes `services.get` itself throw, modeling the
   *   host's undeclared-manifest resolution failure (hide, never a
   *   violation). `callError` makes `get()` throw, modeling a revoked grant
   *   mid-generation (hide, never a violation).
   *
   * Interfaces without a stub delegate to the mock's real `services.get`,
   * which serves nil for an optional lookup with no provider (the
   * absent-provider hide path).
   */
  readonly services?: Readonly<Record<string, ServiceStub>>;
  /** Present = stub `audio.state.get()` serves this; absent = no state provider. */
  readonly audioState?: AudioStateFixture;
  /** Present = stub `audio.spectrum.spectrum()` serves these levels; absent = no meter. */
  readonly audioSpectrum?: readonly number[];
  /**
   * True = the bridged host serves no `bitty.ui.catalog` table, modeling a
   * host below the bitty #3288 surface (the manifest's 0.0.24 compat floor
   * predates it). The plugin must feature-detect and compose locally.
   */
  readonly withoutCatalog?: boolean;
  /**
   * Initial epoch for a fake `os.time`, so timer-driven clock tests advance
   * time deterministically instead of depending on the host wall clock.
   * `BarRun.setNow` moves it.
   */
  readonly fakeNow?: number;
  /**
   * Number of band `bitty.ui.update` calls that throw before succeeding,
   * modeling a transient host fault (budget/wall abort or bridge rejection).
   * The timer chain must survive it: the refresh cadence is armed before the
   * render runs (bitty#2530).
   */
  readonly failBandUpdates?: number;
  /** True = stub `audio.control` serves toggle/step and records calls. */
  readonly audioControl?: boolean;
  /**
   * True = the `audio.control` stub also serves the optional source
   * (microphone) methods `toggle_source_mute` / `set_source_volume`. The live
   * provider exposes sink control only, so this models a future head.
   */
  readonly audioSourceControl?: boolean;
  /**
   * Which optional source methods the stub serves when `audioSourceControl`
   * is true. Defaults to both; a subset models a partial head that must stay
   * read-only under `microphone_control_present`.
   */
  readonly audioSourceMethods?: readonly ("toggle" | "step")[];
  /**
   * Result object returned by the optional source methods (default
   * `{ ok: true }`). Use `{ ok: false }` or `false` to model a non-throwing
   * denial and prove the plugin checks the result shape.
   */
  readonly audioSourceResult?: unknown;
}

/** Plain service implementation: method name to function. */
export type ServiceImpl = Record<string, (...args: never[]) => unknown>;

/**
 * One broker provider stub: a device fixture (`version` + `impl`), a sensor
 * stub (`snapshot` / `resolutionError` / `callError`), or an unlisted
 * interface (absent-provider path). Fields from the unused shape stay absent;
 * the `get` override below routes entries carrying `impl` to the device
 * fixture path and every other entry to the sensor stub path.
 */
export interface ServiceStub {
  readonly version?: string;
  readonly impl?: ServiceImpl;
  readonly snapshot?:
    | Record<string, unknown>
    | null
    | (() => Record<string, unknown> | null | undefined);
  readonly resolutionError?: boolean;
  readonly callError?: boolean;
}

/** Minimal `^`/`>=` version check (test-only approximation). */
function versionOk(version: string, requirement: unknown): boolean {
  if (typeof requirement !== "string" || requirement === "") return false;
  const parts = version.split(".").map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    return false;
  }
  let range = requirement;
  let operator = "=";
  if (range.startsWith("^") || range.startsWith(">=")) {
    operator = range.startsWith("^") ? "^" : ">=";
    range = range.slice(operator.length);
  }
  const wanted = range.split(".").map(Number);
  if (wanted.some((n) => !Number.isInteger(n) || n < 0)) return false;
  const major = wanted[0] ?? 0;
  const minor = wanted[1] ?? 0;
  if (operator === "^") {
    return parts[0] === major && (parts[1]! > minor || parts[1] === minor);
  }
  if (parts[0]! !== major) return parts[0]! > major;
  if ((parts[1] ?? 0) !== minor) return (parts[1] ?? 0) > minor;
  return (parts[2] ?? 0) >= (wanted[2] ?? 0);
}

const factory = new LuaFactory();

/**
 * The shipped `bitty.ui.catalog` constructor table (bitty #3288, mirroring
 * bitty `crates/bitty-lua/src/ui_catalog.rs`): five pure constructors, one
 * per catalog entry, each marshalling one descriptor table, validating it
 * with the catalog's caps (overflow is a typed rejection, never a clamp or
 * a truncation), composing the canonical tree, and lowering it back into
 * the accepted v1 node-table vocabulary. The marshalling validations the
 * host performs in Rust are reproduced shape for shape: a non-table
 * descriptor, an unknown field, a non-dense array, an empty declaration or
 * item, an over-cap item, a reserved bracket delimiter in a pill label, and
 * the aggregate node/depth/text budgets all throw, so the plugin's pcall
 * fallback paths exercise the same refusals the host bridge raises.
 */
const CATALOG_CAPS = {
  segments: 64, // CATALOG_MAX_SEGMENTS
  pills: 64, // CATALOG_MAX_PILLS
  rows: 64, // CATALOG_MAX_ROWS
  segmentBytes: 64, // CATALOG_MAX_SEGMENT_BYTES
  pillLabelBytes: 32, // CATALOG_MAX_PILL_LABEL_BYTES
  detailBytes: 128, // CATALOG_MAX_DETAIL_BYTES
  textBytes: 256 * 1024, // CATALOG_MAX_TEXT_BYTES (UI_MAX_TEXT_BYTES)
  nodes: 2048, // CATALOG_MAX_NODES (UI_MAX_NODES)
  depth: 16, // CATALOG_MAX_DEPTH (UI_MAX_DEPTH)
} as const;

/** Composed node table shape the constructors lower into (v1 vocabulary). */
interface CatalogNode {
  readonly kind: "Text" | "Row" | "Column" | "List";
  readonly text?: string;
  readonly bold?: boolean;
  readonly children?: readonly CatalogNode[];
}

/** Byte length of a UTF-8 string (the catalog's unit for every item cap). */
function catalogBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** One lowered plain `Text` leaf, exactly the host `text_node` shape. */
function catalogText(text: string, bold: boolean): CatalogNode {
  return bold ? { kind: "Text", text, bold: true } : { kind: "Text", text };
}

/** The host's `reject_unknown_keys`: a closed descriptor field set. */
function catalogRejectUnknown(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${context} has an unknown field '${key}'`);
    }
  }
}

/** The host's `descriptorTable` guard: the one argument must be a table. */
function catalogDescriptor(
  spelling: string,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`ui.catalog.${spelling} descriptor must be a table`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * The host's `dense_array`: a strict 1-based sequence. wasmoon hands a Lua
 * sequence over as a 0-based JS array, so a real array is the dense case;
 * anything else (a mixed or string-keyed table) fails closed here instead of
 * dropping the named or skipped entries.
 */
function catalogArray(context: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be a dense 1-based array`);
  }
  if (value.some((item) => item === undefined)) {
    throw new Error(`${context} must be a dense 1-based array`);
  }
  return value;
}

/** The host's `validate_item`: empty items and over-cap items fail closed. */
function catalogValidateItem(
  entry: string,
  index: number,
  text: string,
  cap: number,
): void {
  if (text === "") {
    throw new Error(`${entry} item ${index} is empty`);
  }
  if (catalogBytes(text) > cap) {
    throw new Error(
      `${entry} item ${index} is ${catalogBytes(text)} bytes, exceeding cap ${cap}`,
    );
  }
}

/** The host's `check_scene_bounds`: aggregate node/depth/text budgets. */
function catalogCheckBounds(entry: string, node: CatalogNode): void {
  const pending: { node: CatalogNode; depth: number }[] = [{ node, depth: 1 }];
  let nodes = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const frame = pending.pop()!;
    nodes += 1;
    if (nodes > CATALOG_CAPS.nodes) {
      throw new Error(
        `composed block has ${nodes} nodes, exceeding cap ${CATALOG_CAPS.nodes}`,
      );
    }
    if (frame.depth > CATALOG_CAPS.depth) {
      throw new Error(
        `composed block depth ${frame.depth} exceeds cap ${CATALOG_CAPS.depth}`,
      );
    }
    if (frame.node.kind === "Text") {
      bytes += catalogBytes(frame.node.text ?? "");
      if (bytes > CATALOG_CAPS.textBytes) {
        throw new Error(
          `${entry} text is ${bytes} bytes, exceeding cap ${CATALOG_CAPS.textBytes}`,
        );
      }
    }
    for (const child of frame.node.children ?? []) {
      pending.push({ node: child, depth: frame.depth + 1 });
    }
  }
}

/** One `band`/`status_strip` segment: a string, or `{ text, emphasis }`. */
function catalogSegment(
  context: string,
  value: unknown,
): { text: string; emphasis: boolean } {
  if (typeof value === "string") {
    return { text: value, emphasis: false };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const segment = value as Readonly<Record<string, unknown>>;
    catalogRejectUnknown(segment, ["text", "emphasis"], `${context} segment`);
    const text = segment.text;
    if (typeof text !== "string") {
      throw new Error(`${context} segment text must be a string`);
    }
    const emphasis = segment.emphasis;
    if (emphasis !== undefined && typeof emphasis !== "boolean") {
      throw new Error(`${context} segment emphasis must be a boolean`);
    }
    return { text, emphasis: emphasis === true };
  }
  throw new Error(`${context} segment must be a string or a table`);
}

/** The shared `band`/`status_strip` lowering (`compose_strip`). */
function catalogComposeStrip(
  spelling: string,
  entry: string,
  value: unknown,
): CatalogNode {
  const descriptor = catalogDescriptor(spelling, value);
  catalogRejectUnknown(
    descriptor,
    ["left", "center", "right"],
    `ui.catalog.${spelling} descriptor`,
  );
  const regions = (["left", "center", "right"] as const).map((region) => {
    const raw = descriptor[region];
    if (raw === undefined || raw === null) {
      return [] as { text: string; emphasis: boolean }[];
    }
    const context = `ui.catalog.${spelling} ${region}`;
    return catalogArray(context, raw).map((item) =>
      catalogSegment(context, item),
    );
  });
  const segments = regions.flat();
  if (segments.length === 0) {
    throw new Error(`${entry} block has no content`);
  }
  if (segments.length > CATALOG_CAPS.segments) {
    throw new Error(
      `${entry} has ${segments.length} items, exceeding cap ${CATALOG_CAPS.segments}`,
    );
  }
  for (const [index, segment] of segments.entries()) {
    catalogValidateItem(entry, index, segment.text, CATALOG_CAPS.segmentBytes);
  }
  const children: CatalogNode[] = [];
  for (const [position, region] of regions.entries()) {
    if (
      position > 0 &&
      regions[position - 1]!.length > 0 &&
      region.length > 0
    ) {
      children.push(catalogText(" ", false));
    }
    const group: CatalogNode[] = [];
    for (const [index, segment] of region.entries()) {
      if (index > 0) {
        group.push(catalogText(" ", false));
      }
      group.push(catalogText(segment.text, segment.emphasis));
    }
    children.push({ kind: "Row", children: group });
  }
  const node: CatalogNode = { kind: "Row", children };
  catalogCheckBounds(entry, node);
  return node;
}

/** One `pill_row` pill: a string, or `{ label, active }`. */
function catalogPill(
  context: string,
  value: unknown,
): { label: string; active: boolean } {
  if (typeof value === "string") {
    return { label: value, active: false };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const pill = value as Readonly<Record<string, unknown>>;
    catalogRejectUnknown(pill, ["label", "active"], `${context} entry`);
    const label = pill.label;
    if (typeof label !== "string") {
      throw new Error(`${context} entry label must be a string`);
    }
    const active = pill.active;
    if (active !== undefined && typeof active !== "boolean") {
      throw new Error(`${context} entry active must be a boolean`);
    }
    return { label, active: active === true };
  }
  throw new Error(`${context} entry must be a string or a table`);
}

/** The `pill_row` lowering (`compose_pill_row`): bracketed, styled only by
 * the redundant bold of an active pill. */
function catalogComposePillRow(spelling: string, value: unknown): CatalogNode {
  const descriptor = catalogDescriptor(spelling, value);
  catalogRejectUnknown(
    descriptor,
    ["pills"],
    `ui.catalog.${spelling} descriptor`,
  );
  const raw = descriptor.pills;
  if (raw === undefined || raw === null) {
    throw new Error(
      `ui.catalog.${spelling} pills must be a dense 1-based array`,
    );
  }
  const context = `ui.catalog.${spelling} pills`;
  const items = catalogArray(context, raw);
  const pills = items.map((item) => catalogPill(context, item));
  const entry = "pill-row";
  if (pills.length === 0) {
    throw new Error(`${entry} block has no content`);
  }
  if (pills.length > CATALOG_CAPS.pills) {
    throw new Error(
      `${entry} has ${pills.length} items, exceeding cap ${CATALOG_CAPS.pills}`,
    );
  }
  for (const [index, pill] of pills.entries()) {
    catalogValidateItem(entry, index, pill.label, CATALOG_CAPS.pillLabelBytes);
    if (pill.label.includes("[") || pill.label.includes("]")) {
      throw new Error(
        `${entry} pill ${index} contains a reserved bracket delimiter`,
      );
    }
  }
  const children: CatalogNode[] = [];
  for (const [index, pill] of pills.entries()) {
    if (index > 0) {
      children.push(catalogText(" ", false));
    }
    children.push(catalogText(`[${pill.label}]`, pill.active));
  }
  const node: CatalogNode = { kind: "Row", children };
  catalogCheckBounds(entry, node);
  return node;
}

/** The `tooltip_detail_fallback` lowering: one plain `Text` leaf. */
function catalogComposeDetail(spelling: string, value: unknown): CatalogNode {
  const descriptor = catalogDescriptor(spelling, value);
  catalogRejectUnknown(
    descriptor,
    ["text"],
    `ui.catalog.${spelling} descriptor`,
  );
  const text = descriptor.text;
  if (typeof text !== "string") {
    throw new Error(`ui.catalog.${spelling} text must be a string`);
  }
  const entry = "tooltip-detail-fallback";
  catalogValidateItem(entry, 0, text, CATALOG_CAPS.detailBytes);
  const node = catalogText(text, false);
  catalogCheckBounds(entry, node);
  return node;
}

/** The `modal_sheet` lowering (`compose_modal_sheet`): title row first. */
function catalogComposeModalSheet(
  spelling: string,
  value: unknown,
): CatalogNode {
  const descriptor = catalogDescriptor(spelling, value);
  catalogRejectUnknown(
    descriptor,
    ["title", "rows"],
    `ui.catalog.${spelling} descriptor`,
  );
  const title = descriptor.title;
  if (typeof title !== "string") {
    throw new Error(`ui.catalog.${spelling} title must be a string`);
  }
  const entry = "modal-sheet";
  catalogValidateItem(entry, 0, title, CATALOG_CAPS.detailBytes);
  const context = `ui.catalog.${spelling} rows`;
  const items = catalogArray(context, descriptor.rows ?? []);
  const rows: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      throw new Error(`${context} must hold strings`);
    }
    rows.push(item);
  }
  if (rows.length === 0) {
    throw new Error(`${entry} block has no content`);
  }
  if (rows.length > CATALOG_CAPS.rows) {
    throw new Error(
      `${entry} has ${rows.length} items, exceeding cap ${CATALOG_CAPS.rows}`,
    );
  }
  for (const [index, row] of rows.entries()) {
    catalogValidateItem(entry, index + 1, row, CATALOG_CAPS.detailBytes);
  }
  const children: CatalogNode[] = [
    { kind: "Row", children: [catalogText(title, true)] },
  ];
  for (const row of rows) {
    children.push({ kind: "Row", children: [catalogText(row, false)] });
  }
  const node: CatalogNode = { kind: "Column", children };
  catalogCheckBounds(entry, node);
  return node;
}

/**
 * Build the read-only constructor table the host registers under
 * `bitty.ui.catalog` (bitty #3288). `record` is invoked for every attempted
 * call, before validation, so tests can prove the plugin attempted host
 * composition even when the constructor rejects the descriptor.
 */
function makeCatalogSurface(
  record: (spelling: string) => void,
): Record<string, (value: unknown) => CatalogNode> {
  const constructors: Record<string, (value: unknown) => CatalogNode> = {
    band: (value: unknown) => {
      record("band");
      return catalogComposeStrip("band", "band", value);
    },
    pill_row: (value: unknown) => {
      record("pill_row");
      return catalogComposePillRow("pill_row", value);
    },
    tooltip_detail_fallback: (value: unknown) => {
      record("tooltip_detail_fallback");
      return catalogComposeDetail("tooltip_detail_fallback", value);
    },
    modal_sheet: (value: unknown) => {
      record("modal_sheet");
      return catalogComposeModalSheet("modal_sheet", value);
    },
    status_strip: (value: unknown) => {
      record("status_strip");
      return catalogComposeStrip("status_strip", "status-strip", value);
    },
  };
  return constructors;
}

/**
 * Map JS `null` results to `undefined` so they reach Lua as `nil` (the
 * mock host models Lua `nil` as `null`; wasmoon cannot push `null`).
 */
function nilSafe<T>(table: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (typeof value === "function") {
      out[key] = (...args: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown)(...args);
        return result === null ? undefined : result;
      };
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = nilSafe(value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Activate the plugin once: grants, settings, init.lua, end activation. */
export async function activateBar(
  options: BarRunOptions = {},
): Promise<BarRun> {
  const host = new MockHost({ manifestSource: MANIFEST_SOURCE });
  for (const capability of options.grants ?? BAR_CAPABILITIES) {
    host.grant(capability);
  }
  // The pinned SDK mock predates the CTX-0954 surface: `setWorkspaces`
  // validates the known fields and drops `scratchpad_count` /
  // `scratchpad_occupied`. The sidecar below carries those fields past the
  // mock (keyed by row index, like the host's window-global snapshot) and
  // merges them back into every `workspace.list()` result the plugin sees,
  // including rows set later via `host.setWorkspaces` in live-update tests.
  // Capability gating still runs inside the mock: a denied `workspace.read`
  // throws before the merge, exactly like the host bridge.
  let scratchSidecar: ReadonlyArray<{
    readonly count: unknown;
    readonly occupied: unknown;
    readonly windows?: unknown;
    readonly panels?: unknown;
    readonly window?: unknown;
    readonly title?: unknown;
  }> = [];
  const captureScratch = (rows: readonly WorkspaceInfo[]): void => {
    scratchSidecar = rows.slice(0, 16).map((row) => {
      const record = row as unknown as Record<string, unknown>;
      return {
        count: record.scratchpad_count ?? 0,
        occupied: record.scratchpad_occupied ?? false,
        windows: record.windows,
        panels: record.panels,
        window: record.window,
        title: record.title,
      };
    });
  };
  const originalSetWorkspaces = host.setWorkspaces.bind(host);
  host.setWorkspaces = ((rows: readonly WorkspaceInfo[]): void => {
    captureScratch(rows);
    originalSetWorkspaces(rows);
  }) as MockHost["setWorkspaces"];
  host.setWorkspaces(options.workspaces ?? []);
  host.beginActivation();
  for (const [key, value] of Object.entries(options.settings ?? {})) {
    host.bitty.settings.set(key, value as never);
  }

  const mounts: MountRecord[] = [];
  let updateCount = 0;
  let bandUpdateFailures = options.failBandUpdates ?? 0;
  let overlayUpdateCount = 0;
  const catalogCalls: string[] = [];
  const ui = host.bitty.ui;
  // The pinned SDK mock predates plugin overlay hosting (`host-surface.ts`
  // still rejects the `overlay` slot with `E_UI_UNAVAILABLE`), while the
  // current Core host presents it as the non-modal tooltip surface
  // (Core #2411). Until the SDK pin advances, the harness stands in for that
  // host path: capability-gate the mount exactly like the host, then retain
  // the component so tests can read what the tooltip would paint. Every other
  // slot still runs through the mock's real validation and budgets.
  const grants = options.grants ?? BAR_CAPABILITIES;
  const overlayHandles = new Set<number>();
  let nextOverlayHandle = -1;
  const bridged = nilSafe(host.bitty);
  const bridgedServices = bridged.services as {
    readonly get: (iface: string, opts: unknown) => unknown;
  };
  const fixtureGet = (iface: string, opts: unknown): unknown => {
    const fixture = options.services?.[iface];
    if (fixture === undefined) return bridgedServices.get(iface, opts);
    const settings = (opts ?? {}) as { version?: unknown; optional?: unknown };
    if (!versionOk(fixture.version ?? "1.0.0", settings.version)) {
      if (settings.optional === true) return undefined;
      throw new Error(
        `E_SERVICE_RESOLUTION: provider for ${iface} does not satisfy version`,
      );
    }
    return fixture.impl;
  };
  const workspaceList = (
    bridged.workspace as { readonly list: () => WorkspaceInfo[] }
  ).list;
  // Audio broker stubs (CTX-1220, bitty#2013): the pinned mock predates the
  // native `bitty-terminal.audio` provider, so the harness stubs the three
  // broker interfaces behind `bitty.services.get`. Absent fixtures resolve
  // nil for the optional negotiation (fail-closed hide, exactly like an
  // ungranted head on the real host). Control calls are recorded for the
  // click/scroll dispatch tests.
  const controlCalls: {
    toggles: number;
    steps: unknown[];
    sourceToggles: number;
    sourceSteps: unknown[];
    spectrum: number;
  } = {
    toggles: 0,
    steps: [],
    sourceToggles: 0,
    sourceSteps: [],
    spectrum: 0,
  };
  const audioState = options.audioState;
  const audioSpectrum = options.audioSpectrum;
  const audioControl = options.audioControl === true;
  const audioSourceControl = options.audioSourceControl === true;
  const audioSourceMethods = new Set(
    options.audioSourceMethods ?? ["toggle", "step"],
  );
  const audioSourceResult =
    options.audioSourceResult === undefined
      ? { ok: true }
      : options.audioSourceResult;
  const mockServicesGet = (
    bridged.services as { readonly get: (...args: unknown[]) => unknown }
  ).get;
  const stubbed = options.services ?? {};
  const servicesGet = (iface: string, opts?: unknown): unknown => {
    // Audio interfaces are served by the stubs above when their fixtures
    // are present; everything else falls through to the `services` map
    // (then the mock directory).
    if (iface === "audio.state") {
      if (audioState === undefined) return undefined;
      const snapshot: Record<string, unknown> = {
        volume_pct: audioState.volume_pct,
        muted: audioState.muted,
        port: audioState.port,
        stale_age_ms: audioState.stale_age_ms ?? 0,
      };
      if (audioState.source_volume_pct !== undefined) {
        snapshot.source_volume_pct = audioState.source_volume_pct;
      }
      if (audioState.source_muted !== undefined) {
        snapshot.source_muted = audioState.source_muted;
      }
      return {
        get: (): unknown => ({ ...snapshot }),
      };
    }
    if (iface === "audio.spectrum") {
      if (audioSpectrum === undefined) return undefined;
      const levels = [...audioSpectrum];
      return {
        spectrum: (args?: unknown): unknown => {
          controlCalls.spectrum += 1;
          const raw = (args as Record<string, unknown> | undefined)?.[
            "buckets"
          ];
          const buckets =
            typeof raw === "number" && Number.isInteger(raw) ? raw : 8;
          return {
            levels: levels.slice(0, Math.min(Math.max(buckets, 0), 32)),
            stale_age_ms: 0,
          };
        },
      };
    }
    if (iface === "audio.control") {
      if (!audioControl) return undefined;
      const control: Record<string, unknown> = {
        toggle_mute: (): unknown => {
          controlCalls.toggles += 1;
          return { ok: true };
        },
        set_volume: (args?: unknown): unknown => {
          controlCalls.steps.push(
            (args as Record<string, unknown> | undefined)?.["delta"],
          );
          return { ok: true };
        },
      };
      if (audioSourceControl) {
        if (audioSourceMethods.has("toggle")) {
          control.toggle_source_mute = (): unknown => {
            controlCalls.sourceToggles += 1;
            return audioSourceResult;
          };
        }
        if (audioSourceMethods.has("step")) {
          control.set_source_volume = (args?: unknown): unknown => {
            controlCalls.sourceSteps.push(
              (args as Record<string, unknown> | undefined)?.["delta"],
            );
            return audioSourceResult;
          };
        }
      }
      return control;
    }
    const stub = stubbed[iface];
    if (stub === undefined) {
      return mockServicesGet(iface, opts);
    }
    // Pin the negotiation spelling: an explicit version requirement is
    // mandatory for the SDK mock and accepted as an override by the host
    // bridge (whose fallback is the manifest `[services.required]` entry).
    // A regressed call without it fails here, hiding the module in tests
    // exactly as it would fail closed on the host.
    const requirement = (opts as Record<string, unknown> | undefined)?.version;
    if (typeof requirement !== "string" || requirement.length === 0) {
      throw new Error("services.get requires opts.version");
    }
    if (stub.resolutionError === true) {
      throw new Error(`no provider satisfies '${iface}' (available: none)`);
    }
    return {
      get: (): unknown => {
        if (stub.callError === true) {
          throw new Error(`service '${iface}.get' is unavailable`);
        }
        const snapshot =
          typeof stub.snapshot === "function" ? stub.snapshot() : stub.snapshot;
        if (snapshot === null || snapshot === undefined) return undefined;
        return { ...snapshot };
      },
    };
  };
  const bitty = {
    ...bridged,
    services: {
      ...(bridged.services as Record<string, unknown>),
      get: (iface: string, opts?: unknown): unknown => {
        const stub = (options.services ?? {})[iface];
        if (stub !== undefined && stub.impl !== undefined) {
          return fixtureGet(iface, opts);
        }
        return servicesGet(iface, opts);
      },
    },
    workspace: {
      ...(bridged.workspace as Record<string, unknown>),
      list: (): WorkspaceInfo[] =>
        (workspaceList() as Array<WorkspaceInfo & Record<string, unknown>>).map(
          (row, index) => {
            const scratch = scratchSidecar[index] ?? {
              count: 0,
              occupied: false,
            };
            const merged: Record<string, unknown> = {
              ...row,
              scratchpad_count: scratch.count,
              scratchpad_occupied: scratch.occupied,
            };
            if (scratch.windows !== undefined) merged.windows = scratch.windows;
            if (scratch.panels !== undefined) merged.panels = scratch.panels;
            if (scratch.window !== undefined) merged.window = scratch.window;
            if (scratch.title !== undefined) merged.title = scratch.title;
            return merged as unknown as WorkspaceInfo;
          },
        ),
    },
    ui: {
      mount: (slot: string, component: SceneNode): number => {
        if (slot === "overlay") {
          if (!grants.includes("ui.rich")) {
            throw new Error("E_CAPABILITY_DENIED: ui.rich");
          }
          if (!grants.includes("ui.overlay")) {
            throw new Error("E_CAPABILITY_DENIED: ui.overlay");
          }
          const handle = nextOverlayHandle;
          nextOverlayHandle -= 1;
          overlayHandles.add(handle);
          mounts.push({ slot, handle, component });
          return handle;
        }
        const handle = ui.mount(slot, component as never);
        mounts.push({ slot, handle, component });
        return handle;
      },
      update: (handle: number, component: SceneNode): boolean => {
        updateCount += 1;
        const record = mounts.find((entry) => entry.handle === handle);
        if (overlayHandles.has(handle)) {
          overlayUpdateCount += 1;
          if (record !== undefined) record.component = component;
          return true;
        }
        if (bandUpdateFailures > 0) {
          bandUpdateFailures -= 1;
          throw new Error("E_UI_UNAVAILABLE: injected band update fault");
        }
        const updated = ui.update(handle, component as never);
        if (updated && record !== undefined) record.component = component;
        return updated;
      },
      // The shipped read-only constructor table (bitty #3288): served on
      // every host at or past the surface, omitted entirely when the test
      // models a pre-surface host (`withoutCatalog`), exactly like the
      // feature-detect the plugin performs.
      ...(options.withoutCatalog === true
        ? {}
        : {
            catalog: makeCatalogSurface(catalogCalls.push.bind(catalogCalls)),
          }),
    },
  };

  const lua = await factory.createEngine({ injectObjects: false });
  lua.global.set("bitty", bitty);
  let fakeNow = options.fakeNow ?? null;
  if (fakeNow !== null) {
    lua.global.set("__bar_fake_now", fakeNow);
    await lua.doString("os.time = function() return __bar_fake_now end");
  }
  try {
    await lua.doString(ENTRY_SOURCE);
    host.endActivation();
  } catch (error) {
    lua.global.close();
    throw error;
  }
  return {
    host,
    lua,
    mounts,
    component(): SceneNode {
      const bands = mounts.filter((mount) => mount.slot !== "overlay");
      if (bands.length !== 1) {
        throw new Error(`expected exactly one bar block, got ${bands.length}`);
      }
      return bands[0]!.component;
    },
    overlay(): SceneNode | undefined {
      return mounts.find((mount) => mount.slot === "overlay")?.component;
    },
    overlayText(): string {
      const node = mounts.find((mount) => mount.slot === "overlay");
      return node === undefined ? "" : textOf(node.component);
    },
    setNow(seconds: number): void {
      fakeNow = seconds;
      lua.global.set("__bar_fake_now", fakeNow);
    },
    updates(): number {
      return updateCount;
    },
    overlayUpdates(): number {
      return overlayUpdateCount;
    },
    catalogCalls(): readonly string[] {
      return [...catalogCalls];
    },
    audioControl(): {
      readonly toggles: number;
      readonly steps: readonly unknown[];
      readonly sourceToggles: number;
      readonly sourceSteps: readonly unknown[];
    } {
      return {
        toggles: controlCalls.toggles,
        steps: [...controlCalls.steps],
        sourceToggles: controlCalls.sourceToggles,
        sourceSteps: [...controlCalls.sourceSteps],
      };
    },
    audioSpectrumCalls(): number {
      return controlCalls.spectrum;
    },
    close(): void {
      lua.global.close();
    },
  };
}

/** Concatenated painted text of a component (host `extract_text_from_node`). */
export function textOf(node: SceneNode): string {
  if (node.kind === "Text") return node.text ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/** Leaf Text nodes in paint order. */
export function leaves(node: SceneNode): SceneNode[] {
  if (node.kind === "Text") return [node];
  return (node.children ?? []).flatMap(leaves);
}

/** Leaf under character `column` of the painted text, if any. */
export function leafAt(node: SceneNode, column: number): SceneNode | undefined {
  let start = 0;
  for (const leaf of leaves(node)) {
    const width = [...(leaf.text ?? "")].length;
    if (column >= start && column < start + width) return leaf;
    start += width;
  }
  return undefined;
}
