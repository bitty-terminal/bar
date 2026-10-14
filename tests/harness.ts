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
  "workspace.read",
  "workspace.control",
  "platform.notify",
] as const;

export const FOCUS_COMMAND = "bitty-terminal.bar:focus";

/** Scene node shape the plugin emits (v1 Text/Row subset). */
export interface SceneNode {
  readonly kind: string;
  readonly text?: string;
  readonly children?: readonly SceneNode[];
  readonly bold?: boolean;
  readonly fg?: string;
  readonly on_click?: {
    readonly command: string;
    readonly args?: Readonly<Record<string, unknown>>;
  };
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
  scratchpad: ScratchpadState = {},
): WorkspaceInfo {
  const row: Record<string, unknown> = {
    id,
    name,
    active,
    panel_count: 1,
    attention: { bell: false, activity: false, exited: false },
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
  /** Number of `bitty.ui.update` calls the plugin issued on the block. */
  updates(): number;
  close(): void;
}

export interface BarRunOptions {
  readonly workspaces?: readonly WorkspaceInfo[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly grants?: readonly string[];
  /**
   * Fixture broker providers keyed by short interface name. The harness
   * serves these from the bridged `bitty.services.get` before the mock's
   * own directory (which stays empty in bar tests, so an unlisted interface
   * resolves exactly like an ungranted or absent provider: nil with
   * `optional = true`, `E_SERVICE_RESOLUTION` otherwise). Versions are
   * checked with a minimal `^`/`>=` comparison, documented as a test-only
   * approximation of the SDK range grammar.
   */
  readonly services?: Readonly<
    Record<string, { readonly version?: string; readonly impl: ServiceImpl }>
  >;
}

/** Plain service implementation: method name to function. */
export type ServiceImpl = Record<string, (...args: never[]) => unknown>;

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
  }> = [];
  const captureScratch = (rows: readonly WorkspaceInfo[]): void => {
    scratchSidecar = rows.slice(0, 16).map((row) => {
      const record = row as unknown as Record<string, unknown>;
      return {
        count: record.scratchpad_count ?? 0,
        occupied: record.scratchpad_occupied ?? false,
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
  const ui = host.bitty.ui;
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
  const bitty = {
    ...bridged,
    services: {
      ...(bridged.services as Record<string, unknown>),
      get: fixtureGet,
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
            return {
              ...row,
              scratchpad_count: scratch.count,
              scratchpad_occupied: scratch.occupied,
            };
          },
        ),
    },
    ui: {
      mount: (slot: string, component: SceneNode): number => {
        const handle = ui.mount(slot, component as never);
        mounts.push({ slot, handle, component });
        return handle;
      },
      update: (handle: number, component: SceneNode): boolean => {
        const updated = ui.update(handle, component as never);
        updateCount += 1;
        const record = mounts.find((entry) => entry.handle === handle);
        if (updated && record !== undefined) record.component = component;
        return updated;
      },
    },
  };

  const lua = await factory.createEngine({ injectObjects: false });
  lua.global.set("bitty", bitty);
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
      if (mounts.length !== 1) {
        throw new Error(`expected exactly one bar block, got ${mounts.length}`);
      }
      return mounts[0]!.component;
    },
    updates(): number {
      return updateCount;
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
