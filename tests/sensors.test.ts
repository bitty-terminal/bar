/**
 * Phase B sensor modules (bitty#2019 cpu, bitty#2011 memory, bitty#2016
 * battery): negotiate → poll → render → fail-closed-hide over the broker
 * `system.*` providers served by the native `bitty-terminal.sensors`
 * component, with thresholds and icon buckets evaluated Lua-side.
 *
 * The pinned SDK mock predates the sensor providers (no host-side provider
 * injection, and its manifest model rejects the production
 * `[services.required]` + `platform.*-read` declarations), so these tests
 * inject providers through the harness `services` stubs. The Lua under test
 * uses the production negotiation spelling
 * (`services.get(iface, { version, optional = true })` inside pcall plus
 * `get({})`), which the stubs verify; the manifest delta that lights the
 * modules up on the host rides the SDK-support follow-up documented in the
 * README.
 */

import {
  afterEach,
  beforeAll,
  afterAll,
  describe,
  expect,
  test,
} from "bun:test";
import { LuaFactory, type LuaEngine } from "wasmoon";

import {
  activateBar,
  BAR_CAPABILITIES,
  type BarRun,
  ENTRY_SOURCE,
  leaves,
  textOf,
  ws,
  type WorkspaceInfo,
} from "./harness.js";

const CPU = "system.cpu";
const MEMORY = "system.memory";
const BATTERY = "system.battery";
const DETAIL_COMMAND = "bitty-terminal.bar:detail";

const SENSOR_GRANTS: readonly string[] = [
  ...BAR_CAPABILITIES,
  "platform.cpu-read",
  "platform.memory-read",
  "platform.battery-read",
];

const runs: BarRun[] = [];

async function bar(...args: Parameters<typeof activateBar>): Promise<BarRun> {
  const run = await activateBar(...args);
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

/** Leaf carrying the sensor atom, if the module rendered. */
function sensorLeaf(
  run: BarRun,
  text: string,
): { fg?: string; tooltip?: string } {
  const leaf = leaves(run.component()).find((entry) => entry.text === text);
  expect(leaf).toBeDefined();
  const click = leaf!.on_click;
  expect(click?.command).toBe(DETAIL_COMMAND);
  return { fg: leaf!.fg, tooltip: click?.args?.["text"] as string | undefined };
}

const THREE: WorkspaceInfo[] = [
  ws(1, "ws1"),
  ws(4, "code", true),
  ws(9, "logs"),
];

const CPU_SNAP = {
  total_pct: 42.4,
  per_core: [50, 30],
  stale_age_ms: 0,
};

const MEMORY_SNAP = {
  pct: 62.5,
  used_gib: 5,
  total_gib: 8,
  swap_pct: 0,
  swap_used_gib: 0,
  swap_total_gib: 0,
  stale_age_ms: 0,
};

const BATTERY_SNAP = {
  capacity_pct: 63.2,
  state: "discharging",
  stale_age_ms: 0,
};

describe("sensor pure helpers", () => {
  const factory = new LuaFactory();
  let lua: LuaEngine;
  let mod: Record<string, (...args: unknown[]) => unknown>;

  beforeAll(async () => {
    lua = await factory.createEngine({ injectObjects: false });
    mod = (await lua.doString(ENTRY_SOURCE)) as typeof mod;
  });

  afterAll(() => {
    lua.global.close();
  });

  test("hot thresholds default and validate directionally", async () => {
    expect(await mod["thresholds"]({}, 80, 90, true)).toEqual({
      warning: 80,
      critical: 90,
    });
    expect(
      await mod["thresholds"]({ warning: 70, critical: 95 }, 80, 90, true),
    ).toEqual({ warning: 70, critical: 95 });
    // Inverted or out-of-range marks fall back wholesale.
    expect(
      await mod["thresholds"]({ warning: 95, critical: 80 }, 80, 90, true),
    ).toEqual({ warning: 80, critical: 90 });
    expect(
      await mod["thresholds"]({ warning: "hot", critical: 95 }, 80, 90, true),
    ).toEqual({ warning: 80, critical: 95 });
    expect(
      await mod["thresholds"]({ warning: 70, critical: 101 }, 80, 90, true),
    ).toEqual({ warning: 70, critical: 90 });
  });

  test("low thresholds require warning above critical", async () => {
    expect(await mod["thresholds"]({}, 30, 15, false)).toEqual({
      warning: 30,
      critical: 15,
    });
    expect(
      await mod["thresholds"]({ warning: 25, critical: 10 }, 30, 15, false),
    ).toEqual({ warning: 25, critical: 10 });
    expect(
      await mod["thresholds"]({ warning: 10, critical: 25 }, 30, 15, false),
    ).toEqual({ warning: 30, critical: 15 });
  });

  test("hot/low states split on the marks", async () => {
    expect(await mod["hot_state"](79.9, 80, 90)).toBe("normal");
    expect(await mod["hot_state"](80, 80, 90)).toBe("warning");
    expect(await mod["hot_state"](90, 80, 90)).toBe("critical");
    expect(await mod["low_state"](31, 30, 15)).toBe("normal");
    expect(await mod["low_state"](30, 30, 15)).toBe("warning");
    expect(await mod["low_state"](15, 30, 15)).toBe("critical");
    expect(await mod["hot_state"]("hot", 80, 90)).toBeNil();
    expect(await mod["low_state"](undefined, 30, 15)).toBeNil();
  });

  test("battery buckets span the capacity range", async () => {
    expect(await mod["battery_bucket"](0)).toBe(1);
    expect(await mod["battery_bucket"](9.9)).toBe(1);
    expect(await mod["battery_bucket"](10)).toBe(2);
    expect(await mod["battery_bucket"](34.9)).toBe(2);
    expect(await mod["battery_bucket"](35)).toBe(3);
    expect(await mod["battery_bucket"](64.9)).toBe(3);
    expect(await mod["battery_bucket"](65)).toBe(4);
    expect(await mod["battery_bucket"](89.9)).toBe(4);
    expect(await mod["battery_bucket"](90)).toBe(5);
    expect(await mod["battery_bucket"](100)).toBe(5);
    expect(await mod["battery_bucket"]("full")).toBeNil();
  });

  test("battery icons carry the level plus the charging mark", async () => {
    expect(await mod["battery_icon"](50, "discharging")).toBe("[==  ]");
    expect(await mod["battery_icon"](50, "charging")).toBe("[==  ]+");
    expect(await mod["battery_icon"](5, "discharging")).toBe("[    ]");
    expect(await mod["battery_icon"](100, "full")).toBe("[====]");
    expect(await mod["battery_icon"]("full", "discharging")).toBe("");
  });

  test("display rounding and durations", async () => {
    expect(await mod["round_pct"](42.4)).toBe(42);
    expect(await mod["round_pct"](42.5)).toBe(43);
    expect(await mod["num1"](5)).toBe("5");
    expect(await mod["num1"](5.25)).toBe("5.3");
    expect(await mod["num1"]("5")).toBe("");
    expect(await mod["round1"](3.24)).toBe(3.2);
    expect(await mod["round1"](12.34)).toBe(12.3);
    expect(await mod["format_duration"](0)).toBe("0s");
    expect(await mod["format_duration"](45)).toBe("45s");
    expect(await mod["format_duration"](90)).toBe("1m");
    expect(await mod["format_duration"](4500)).toBe("1h15m");
    expect(await mod["format_duration"](-1)).toBeNil();
    expect(await mod["core_count"](undefined)).toBe(0);
    expect(await mod["core_count"](42)).toBe(0);
  });

  test("provider ceilings are the module cadences", async () => {
    const modules = (await mod["MODULES"]) as Record<
      string,
      { tick_ms: number; kind: string }
    >;
    expect(modules["cpu"].kind).toBe("timer");
    expect(modules["cpu"].tick_ms).toBe(2000);
    expect(modules["memory"].tick_ms).toBe(2000);
    expect(modules["battery"].tick_ms).toBe(5000);
  });
});

describe("cpu module", () => {
  test("renders the rounded aggregate beside the workspace strip", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["cpu", "workspaces"] },
      grants: SENSOR_GRANTS,
      services: { [CPU]: { snapshot: CPU_SNAP } },
    });
    expect(painted(run)).toBe("42% 1:ws1 4:code* 9:logs (3)");
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("thresholds switch the theme token, never a raw color", async () => {
    for (const [pct, fg] of [
      [42.4, undefined],
      [85, "warning"],
      [95, "critical"],
    ] as const) {
      const run = await bar({
        workspaces: THREE,
        settings: { modules_left: ["cpu"] },
        grants: SENSOR_GRANTS,
        services: {
          [CPU]: { snapshot: { ...CPU_SNAP, total_pct: pct } },
        },
      });
      const text = `${Math.round(pct)}%`;
      expect(sensorLeaf(run, text).fg).toBe(fg);
      expect(run.host.handlerViolations).toEqual([]);
    }
  });

  test("module option tables are inert under v1; shipped defaults render", async () => {
    // The `cpu` option table reads as [] under the v1 declared-keys gate
    // (see bitty-plugin.toml), so the custom format and marks below are
    // stored but never served: the module renders its defaults (72% is below
    // the default 80 warning mark). Threshold composition itself stays
    // covered by the pure suite above.
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["cpu"],
        cpu: { format: "[{total}]", warning: 70, critical: 75 },
      },
      grants: SENSOR_GRANTS,
      services: {
        [CPU]: { snapshot: { ...CPU_SNAP, total_pct: 72 } },
      },
    });
    expect(painted(run)).toBe("72%");
    expect(sensorLeaf(run, "72%").fg).toBeUndefined();
  });

  test("inverted thresholds fall back to the shipped defaults", async () => {
    // Under v1 settings the marks table below is inert (see bitty-plugin.toml),
    // so this renders the shipped defaults; inversion composition itself stays
    // covered by the pure thresholds suite above.
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["cpu"],
        cpu: { warning: 95, critical: 80 },
      },
      grants: SENSOR_GRANTS,
      services: {
        [CPU]: { snapshot: { ...CPU_SNAP, total_pct: 72 } },
      },
    });
    expect(painted(run)).toBe("72%");
    expect(sensorLeaf(run, "72%").fg).toBeUndefined();
  });

  test("the detail fallback carries aggregate and core count", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["cpu"] },
      grants: SENSOR_GRANTS,
      services: { [CPU]: { snapshot: CPU_SNAP } },
    });
    expect(sensorLeaf(run, "42%").tooltip).toBe("CPU 42% (2 cores)");
  });

  test("an absent provider hides the module but never the bar", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["cpu", "workspaces"] },
      grants: SENSOR_GRANTS,
    });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("a sensor-only plan with no provider hides the band", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["cpu"] },
      grants: SENSOR_GRANTS,
    });
    expect(painted(run)).toBeUndefined();
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("resolution, call, and shape failures all hide fail closed", async () => {
    for (const services of [
      { [CPU]: { resolutionError: true } },
      { [CPU]: { callError: true } },
      { [CPU]: { snapshot: null } },
      { [CPU]: { snapshot: {} } },
      { [CPU]: { snapshot: { total_pct: "42" } } },
    ] as const) {
      const run = await bar({
        workspaces: THREE,
        settings: { modules_left: ["cpu", "workspaces"] },
        grants: SENSOR_GRANTS,
        services,
      });
      expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
      expect(run.host.handlerViolations).toEqual([]);
    }
  });

  test("ticks re-poll and re-render with fresh values (bar#17)", async () => {
    let reading = 42.4;
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["cpu"] },
      grants: SENSOR_GRANTS,
      services: {
        [CPU]: {
          snapshot: () => ({ ...CPU_SNAP, total_pct: reading }),
        },
      },
    });
    expect(painted(run)).toBe("42%");
    reading = 87.6;
    run.host.advanceTimers(2000);
    expect(run.updates()).toBe(1);
    expect(painted(run)).toBe("88%");
    expect(sensorLeaf(run, "88%").fg).toBe("warning");
    // The pre-armed chain (not a post-activation re-arm, which v1 closes)
    // keeps repainting on later ticks with no violation.
    reading = 12.3;
    run.host.advanceTimers(2000);
    expect(run.updates()).toBe(2);
    expect(painted(run)).toBe("12%");
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("a baseline-missed first poll paints on the next tick (bar#17)", async () => {
    // The provider serves nil past no baseline yet (headed cpu stays hidden
    // at mount for one delta interval); the next chained tick re-polls the
    // negotiated handle and paints the live value autonomously.
    let calls = 0;
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["cpu", "workspaces"] },
      grants: SENSOR_GRANTS,
      services: {
        [CPU]: {
          snapshot: () => {
            calls += 1;
            if (calls < 2) return null;
            return { ...CPU_SNAP };
          },
        },
      },
    });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
    run.host.advanceTimers(2000);
    expect(run.updates()).toBe(1);
    expect(painted(run)).toBe("42% 1:ws1 4:code* 9:logs (3)");
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("the cpu ticks at its 2s default cadence", async () => {
    // Per-module tick_ms tables are inert under v1 settings (see
    // bitty-plugin.toml): the module arms its default 2 s ceiling.
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["cpu"], cpu: { tick_ms: 5000 } },
      grants: SENSOR_GRANTS,
      services: { [CPU]: { snapshot: CPU_SNAP } },
    });
    run.host.advanceTimers(1999);
    expect(run.updates()).toBe(0);
    run.host.advanceTimers(1);
    expect(run.updates()).toBe(1);
    expect(run.host.handlerViolations).toEqual([]);
  });
});

describe("memory module", () => {
  test("renders the rounded share with a GiB detail fallback", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["memory"] },
      grants: SENSOR_GRANTS,
      services: { [MEMORY]: { snapshot: MEMORY_SNAP } },
    });
    expect(painted(run)).toBe("63%");
    expect(sensorLeaf(run, "63%").tooltip).toBe("Memory 5/8 GiB (63%)");
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("a swapful source appends swap to the detail", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["memory"] },
      grants: SENSOR_GRANTS,
      services: {
        [MEMORY]: {
          snapshot: {
            ...MEMORY_SNAP,
            swap_pct: 25,
            swap_used_gib: 0.5,
            swap_total_gib: 2,
          },
        },
      },
    });
    expect(sensorLeaf(run, "63%").tooltip).toBe(
      "Memory 5/8 GiB (63%), swap 0.5/2 GiB",
    );
  });

  test("thresholds follow the share, and absence hides", async () => {
    const hot = await bar({
      workspaces: THREE,
      settings: { modules_left: ["memory"] },
      grants: SENSOR_GRANTS,
      services: {
        [MEMORY]: { snapshot: { ...MEMORY_SNAP, pct: 91 } },
      },
    });
    expect(sensorLeaf(hot, "91%").fg).toBe("critical");
    const absent = await bar({
      workspaces: THREE,
      settings: { modules_left: ["memory", "workspaces"] },
      grants: SENSOR_GRANTS,
    });
    expect(painted(absent)).toBe("1:ws1 4:code* 9:logs (3)");
    expect(absent.host.handlerViolations).toEqual([]);
  });
});

describe("battery module", () => {
  test("renders the icon bucket plus the rounded capacity", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["battery"] },
      grants: SENSOR_GRANTS,
      services: { [BATTERY]: { snapshot: BATTERY_SNAP } },
    });
    expect(painted(run)).toBe("[==  ] 63%");
    expect(sensorLeaf(run, "[==  ] 63%").tooltip).toBe(
      "Battery 63% discharging",
    );
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("charging appends the mark and never alarms", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["battery"] },
      grants: SENSOR_GRANTS,
      services: {
        [BATTERY]: {
          snapshot: { ...BATTERY_SNAP, capacity_pct: 12, state: "charging" },
        },
      },
    });
    expect(painted(run)).toBe("[=   ]+ 12%");
    expect(sensorLeaf(run, "[=   ]+ 12%").fg).toBeUndefined();
  });

  test("a discharging battery alarms low on the shipped marks", async () => {
    for (const [capacity, fg] of [
      [50, undefined],
      [25, "warning"],
      [12, "critical"],
    ] as const) {
      const run = await bar({
        workspaces: THREE,
        settings: { modules_left: ["battery"] },
        grants: SENSOR_GRANTS,
        services: {
          [BATTERY]: {
            snapshot: { ...BATTERY_SNAP, capacity_pct: capacity },
          },
        },
      });
      const icon = capacity < 35 ? "[=   ]" : "[==  ]";
      expect(sensorLeaf(run, `${icon} ${capacity}%`).fg).toBe(fg);
    }
    const custom = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["battery"],
        battery: { warning: 50, critical: 40 },
      },
      grants: SENSOR_GRANTS,
      services: {
        [BATTERY]: { snapshot: { ...BATTERY_SNAP, capacity_pct: 45 } },
      },
    });
    // The custom marks above are inert under v1 settings (see
    // bitty-plugin.toml): 45% discharging reads normal against the shipped
    // 30/15 defaults. Mark composition itself stays covered by the pure
    // low_state suite above.
    expect(sensorLeaf(custom, "[==  ] 45%").fg).toBeUndefined();
  });

  test("power and time-to-empty ride the detail fallback", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["battery"] },
      grants: SENSOR_GRANTS,
      services: {
        [BATTERY]: {
          snapshot: {
            ...BATTERY_SNAP,
            power_w: 12.34,
            seconds_to_empty: 4500,
          },
        },
      },
    });
    expect(sensorLeaf(run, "[==  ] 63%").tooltip).toBe(
      "Battery 63% discharging 12.3W 1h15m left",
    );
  });

  test("full and unknown states render without alarm", async () => {
    const full = await bar({
      workspaces: THREE,
      settings: { modules_left: ["battery"] },
      grants: SENSOR_GRANTS,
      services: {
        [BATTERY]: {
          snapshot: { capacity_pct: 100, state: "full", stale_age_ms: 0 },
        },
      },
    });
    expect(painted(full)).toBe("[====] 100%");
    expect(sensorLeaf(full, "[====] 100%").fg).toBeUndefined();
    const unknown = await bar({
      workspaces: THREE,
      settings: { modules_left: ["battery"] },
      grants: SENSOR_GRANTS,
      services: {
        [BATTERY]: {
          snapshot: { capacity_pct: 5, state: "unknown", stale_age_ms: 0 },
        },
      },
    });
    expect(painted(unknown)).toBe("[    ] 5%");
    expect(sensorLeaf(unknown, "[    ] 5%").fg).toBeUndefined();
  });

  test("a batteryless host hides the module", async () => {
    for (const services of [
      undefined,
      { [BATTERY]: { resolutionError: true } },
      { [BATTERY]: { snapshot: { capacity_pct: 63.2 } } },
    ] as const) {
      const run = await bar({
        workspaces: THREE,
        settings: { modules_left: ["battery", "workspaces"] },
        grants: SENSOR_GRANTS,
        services,
      });
      expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
      expect(run.host.handlerViolations).toEqual([]);
    }
  });

  test("the battery ticks at the 5s ceiling", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["battery"] },
      grants: SENSOR_GRANTS,
      services: { [BATTERY]: { snapshot: BATTERY_SNAP } },
    });
    run.host.advanceTimers(2000);
    expect(run.updates()).toBe(0);
    run.host.advanceTimers(5000);
    expect(run.updates()).toBe(1);
    expect(run.host.handlerViolations).toEqual([]);
  });
});

describe("sensor modules in the plan", () => {
  test("unknown names skip while sensors still render", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["nope", "cpu"] },
      grants: SENSOR_GRANTS,
      services: { [CPU]: { snapshot: CPU_SNAP } },
    });
    expect(painted(run)).toBe("42%");
  });

  test("the full trio renders left to right", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["cpu", "memory", "battery"] },
      grants: SENSOR_GRANTS,
      services: {
        [CPU]: { snapshot: CPU_SNAP },
        [MEMORY]: { snapshot: MEMORY_SNAP },
        [BATTERY]: { snapshot: BATTERY_SNAP },
      },
    });
    expect(painted(run)).toBe("42% 63% [==  ] 63%");
    expect(run.host.handlerViolations).toEqual([]);
  });
});
