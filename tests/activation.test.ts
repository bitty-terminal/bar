/**
 * Phase B activation (CTX-1226, post-SDK#152): the manifest declares
 * `[services.required]` (all 14 provider interfaces with versions), the 14
 * capability heads, and `[settings]` for every key the Lua reads, so the
 * merged cpu/memory/battery, network/bluetooth/backlight/idle, and
 * pulseaudio/spectrum modules negotiate → grant → poll → render live instead
 * of hiding. Ungranted/absent providers still hide fail closed.
 *
 * No Lua logic changes: these tests prove the declarations travel from
 * `bitty-plugin.toml` through the SDK manifest model into the mock host and
 * that each provider family renders with grants and hides without them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { HostError, loadManifestModel } from "bitty-plugin-sdk";

import {
  activateBar,
  BAR_CAPABILITIES,
  type BarRun,
  MANIFEST_SOURCE,
  textOf,
  ws,
  type WorkspaceInfo,
} from "./harness.js";

const runs: BarRun[] = [];

/**
 * These tests pin the workspace-only center (`modules_center: []`) so the
 * provider assertions stay focused on their module; the shipped default plan
 * (workspaces left, clock center) is covered in modules.test.ts.
 */
const NO_CENTER = { modules_center: [] } as const;

async function bar(
  options: Parameters<typeof activateBar>[0] = {},
): Promise<BarRun> {
  const run = await activateBar({
    ...options,
    settings: { ...NO_CENTER, ...options.settings },
  });
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

function painted(run: BarRun): string | undefined {
  const text = textOf(run.component());
  return text === "" ? undefined : text;
}

const THREE: WorkspaceInfo[] = [
  ws(1, "ws1"),
  ws(4, "code", true),
  ws(9, "logs"),
];

/** Every provider interface the Phase B Lua negotiates, with its version. */
const REQUIRED_SERVICES: Readonly<Record<string, string>> = {
  "system.cpu": "^1.0",
  "system.memory": "^1.0",
  "system.battery": "^1.0",
  "network.state": "^1.0",
  "network.essid": "^1.0",
  "bluetooth.state": "^1.0",
  "bluetooth.control": "^1.0",
  "backlight.state": "^1.0",
  "backlight.control": "^1.0",
  "idle.state": "^1.0",
  "idle.control": "^1.0",
  "audio.state": ">=1.0",
  "audio.control": ">=1.0",
  "audio.spectrum": ">=1.0",
};

/** Every head the activation declares, spelling-verified against bitty main
 * `crates/bitty-plugin-host/src/capability.rs` and the SDK#152 closed set. */
const ACTIVATION_HEADS: readonly string[] = [
  "platform.cpu-read",
  "platform.memory-read",
  "platform.battery-read",
  "platform.network.read",
  "platform.essid.read",
  "platform.bluetooth.read",
  "platform.bluetooth.control",
  "platform.backlight.read",
  "platform.backlight.control",
  "platform.idle.read",
  "platform.idle.control",
  "audio.state.read",
  "audio.state.control",
  "audio.spectrum",
];

describe("activation manifest declarations", () => {
  test("[services.required] carries all 14 provider interfaces", () => {
    const model = loadManifestModel(MANIFEST_SOURCE);
    expect(model.requiredServices.size).toBe(14);
    for (const [iface, version] of Object.entries(REQUIRED_SERVICES)) {
      expect(model.requiredServices.get(iface)).toBe(version);
    }
  });

  test("[capabilities] carries the chassis plus all 14 Phase B heads", () => {
    const model = loadManifestModel(MANIFEST_SOURCE);
    for (const head of [...BAR_CAPABILITIES, ...ACTIVATION_HEADS]) {
      expect(model.capabilities).toContain(head);
    }
  });

  test("[settings] declares every key the Lua reads, with v1 types", () => {
    const model = loadManifestModel(MANIFEST_SOURCE);
    expect(model.hasSettingsTable).toBe(true);
    const expected: Readonly<Record<string, { kind: string; def: unknown }>> = {
      show: { kind: "bool", def: true },
      edge: { kind: "string", def: "bottom" },
      show_single: { kind: "bool", def: false },
      name_max_chars: { kind: "int", def: 32 },
      label: { kind: "string", def: "index" },
      modules_left: { kind: "string-array", def: ["workspaces"] },
      modules_center: { kind: "string-array", def: ["clock"] },
      modules_right: { kind: "string-array", def: [] },
      // Per-module option collections (v1 has no table form: declared
      // string-array with an empty default so reads fail to module
      // defaults instead of aborting activation; see bitty-plugin.toml).
      workspaces: { kind: "string-array", def: [] },
      clock: { kind: "string-array", def: [] },
      network: { kind: "string-array", def: [] },
      bluetooth: { kind: "string-array", def: [] },
      backlight: { kind: "string-array", def: [] },
      idle: { kind: "string-array", def: [] },
      pulseaudio: { kind: "string-array", def: [] },
      spectrum: { kind: "string-array", def: [] },
      cpu: { kind: "string-array", def: [] },
      memory: { kind: "string-array", def: [] },
      battery: { kind: "string-array", def: [] },
    };
    expect(model.settings.size).toBe(Object.keys(expected).length);
    for (const [key, decl] of Object.entries(expected)) {
      const entry = model.settings.get(key);
      expect(entry?.kind).toBe(decl.kind);
      expect(entry?.default).toEqual(decl.def);
    }
  });

  test("the declared-keys gate is armed (undeclared reads fail closed)", async () => {
    const run = await bar({ workspaces: THREE });
    let code: unknown;
    try {
      run.host.bitty.settings.get("undeclared_key_xyz");
    } catch (error) {
      code = error instanceof HostError ? error.diagnostic.code : String(error);
    }
    expect(code).toBe("E_SETTINGS_UNDECLARED");
  });
});

describe("Phase B liveness (negotiate → grant → poll → render)", () => {
  const SENSOR_GRANTS = [
    ...BAR_CAPABILITIES,
    "platform.cpu-read",
    "platform.memory-read",
    "platform.battery-read",
  ] as const;

  test("sensor family: a granted cpu provider renders, ungranted hides", async () => {
    const live = await bar({
      workspaces: THREE,
      settings: { modules_left: ["cpu", "workspaces"] },
      grants: [...SENSOR_GRANTS],
      services: {
        "system.cpu": {
          snapshot: { total_pct: 42.4, per_core: [50, 30], stale_age_ms: 0 },
        },
      },
    });
    expect(painted(live)).toBe("42% [1] [4*] [9]");
    expect(live.host.handlerViolations).toEqual([]);

    const dark = await bar({
      workspaces: THREE,
      settings: { modules_left: ["cpu", "workspaces"] },
      grants: [...SENSOR_GRANTS],
    });
    expect(painted(dark)).toBe("[1] [4*] [9]");
    expect(dark.host.handlerViolations).toEqual([]);
  });

  test("device family: a granted network provider renders, ungranted hides", async () => {
    const live = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network", "workspaces"] },
      services: {
        "network.state": {
          version: "1.0.0",
          impl: {
            get: () => ({
              link: "wifi",
              down_bps: 8000,
              up_bps: 4000,
              stale_age_ms: 0,
            }),
          },
        },
      },
    });
    expect(painted(live)).toBe("wifi 8.0K/4.0K [1] [4*] [9]");
    expect(live.host.handlerViolations).toEqual([]);

    const dark = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network", "workspaces"] },
    });
    expect(painted(dark)).toBe("[1] [4*] [9]");
    expect(dark.host.handlerViolations).toEqual([]);
  });

  test("device family: a version-mismatched provider hides (no silent downgrade)", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network", "workspaces"] },
      services: {
        "network.state": {
          version: "2.0.0",
          impl: {
            get: () => ({ link: "wifi", stale_age_ms: 0 }),
          },
        },
      },
    });
    expect(painted(run)).toBe("[1] [4*] [9]");
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("audio family: a granted monitor renders, an absent one hides", async () => {
    const live = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio", "workspaces"] },
      audioState: { volume_pct: 50, muted: false, port: " speakers " },
    });
    expect(painted(live)).toContain("MED 50%");
    expect(live.host.handlerViolations).toEqual([]);

    const dark = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio", "workspaces"] },
    });
    expect(painted(dark)).toBe("[1] [4*] [9]");
    expect(dark.host.handlerViolations).toEqual([]);
  });
});
