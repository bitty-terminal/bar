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

/** Workspace row with the defaults the bridge fills in. */
export function ws(id: number, name: string, active = false): WorkspaceInfo {
  return {
    id,
    name,
    active,
    panel_count: 1,
    attention: { bell: false, activity: false, exited: false },
  };
}

export interface BarRun {
  readonly host: MockHost;
  readonly lua: LuaEngine;
  readonly mounts: MountRecord[];
  /** Last component of the single bar block. */
  component(): SceneNode;
  close(): void;
}

export interface BarRunOptions {
  readonly workspaces?: readonly WorkspaceInfo[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly grants?: readonly string[];
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
  host.setWorkspaces(options.workspaces ?? []);
  host.beginActivation();
  for (const [key, value] of Object.entries(options.settings ?? {})) {
    host.bitty.settings.set(key, value as never);
  }

  const mounts: MountRecord[] = [];
  const ui = host.bitty.ui;
  const bitty = {
    ...nilSafe(host.bitty),
    ui: {
      mount: (slot: string, component: SceneNode): number => {
        const handle = ui.mount(slot, component as never);
        mounts.push({ slot, handle, component });
        return handle;
      },
      update: (handle: number, component: SceneNode): boolean => {
        const updated = ui.update(handle, component as never);
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
