/**
 * Declarative module chassis (bitty-terminal/bitty-plugins#86, Phase A):
 * an ordered module list in settings, per-module render cadence, and
 * command-only click dispatch — zero new Core API.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { LuaFactory, type LuaEngine } from "wasmoon";
import { V1_SURFACE_FUNCTIONS } from "bitty-plugin-sdk";

import {
  activateBar,
  type BarRun,
  ENTRY_SOURCE,
  leaves,
  textOf,
  ws,
  type WorkspaceInfo,
} from "./harness.js";

const DETAIL_COMMAND = "bitty-terminal.bar:detail";

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

const THREE: WorkspaceInfo[] = [
  ws(1, "ws1"),
  ws(4, "code", true),
  ws(9, "logs"),
];

describe("declarative module list", () => {
  test("the default plan renders the workspaces module (behavior preserving)", async () => {
    const run = await bar({ workspaces: THREE });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
  });

  test("modules_left order drives render order", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["clock", "workspaces"],
        clock: { format: "T" },
      },
    });
    expect(painted(run)).toBe("T 1:ws1 4:code* 9:logs (3)");
  });

  test("reordering the settings reorders the render", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["workspaces", "clock"],
        clock: { format: "T" },
      },
    });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3) T");
  });

  test("modules_right renders after the left group", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["workspaces"],
        modules_right: ["clock"],
        clock: { format: "T" },
      },
    });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3) T");
  });

  test("modules_center keeps its declared position (true centering is Phase C)", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["clock"],
        modules_center: ["workspaces"],
        clock: { format: "T" },
      },
    });
    expect(painted(run)).toBe("T 1:ws1 4:code* 9:logs (3)");
  });

  test("unknown module names are skipped", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["nope", "workspaces", "also-nope"] },
    });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
  });

  test("a malformed spec never hides the bar (falls back to the default plan)", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: "clock" },
    });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
  });

  test("a plan of only unknown names falls back to the default plan", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["rm -rf /"] },
    });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
  });

  test("non-name entries are skipped, the rest still render", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: [42, "clock"], clock: { format: "T" } },
    });
    expect(painted(run)).toBe("T");
  });

  test("any module count still mounts exactly one band", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["clock", "workspaces"],
        clock: { format: "T" },
      },
    });
    expect(run.mounts.length).toBe(1);
  });
});

describe("per-module cadence (timer modules)", () => {
  test("a timer module re-renders once on its tick", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["clock", "workspaces"],
        clock: { format: "T", tick_ms: 60000 },
      },
    });
    expect(painted(run)).toBe("T 1:ws1 4:code* 9:logs (3)");
    expect(run.updates()).toBe(0);

    run.host.advanceTimers(60000);
    expect(run.updates()).toBe(1);
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("v1 one-shot timers stay under the rate policy (no re-arm violation)", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["clock"],
        clock: { format: "T", tick_ms: 60000 },
      },
    });
    run.host.advanceTimers(60000);
    expect(run.updates()).toBe(1);
    // Plugin API v1 closes timer creation after activation, so the optimistic
    // re-arm fails closed: no second tick and no recorded violation.
    run.host.advanceTimers(60000);
    expect(run.updates()).toBe(1);
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("tick_ms is clamped to the rate-policy floor", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["clock"], clock: { format: "T", tick_ms: 1 } },
    });
    run.host.advanceTimers(999);
    expect(run.updates()).toBe(0);
    run.host.advanceTimers(1);
    expect(run.updates()).toBe(1);
  });

  test("a hidden bar pauses timer modules (pause-on-hidden)", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        show: false,
        modules_left: ["clock"],
        clock: { format: "T" },
      },
    });
    run.host.advanceTimers(60000);
    expect(run.updates()).toBe(0);
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("event modules create no timer (no timer where events suffice)", async () => {
    const run = await bar({ workspaces: THREE });
    run.host.advanceTimers(600000);
    expect(run.updates()).toBe(0);
    expect(run.host.handlerViolations).toEqual([]);
  });
});

describe("tooltip→notify fallback", () => {
  test("a module tooltip binds the detail command and shows a notification", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["clock"],
        clock: { format: "T", tooltip: "full date" },
      },
    });
    const node = leaves(run.component())[0]!;
    expect(node.on_click).toEqual({
      command: DETAIL_COMMAND,
      args: { text: "full date" },
    });
    expect(
      run.host.dispatchCommand(DETAIL_COMMAND, { text: "full date" }),
    ).toBe(true);
    expect(run.host.notifications).toEqual([
      { title: "Unified Bar", body: "full date" },
    ]);
  });

  test("without platform.notify the fallback fails closed", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["clock"],
        clock: { format: "T", tooltip: "full date" },
      },
      grants: ["ui.rich", "workspace.read", "workspace.control"],
    });
    expect(
      run.host.dispatchCommand(DETAIL_COMMAND, { text: "full date" }),
    ).toBe(false);
    expect(run.host.notifications).toEqual([]);
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("a module without a tooltip is not clickable", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["clock"], clock: { format: "T" } },
    });
    expect(leaves(run.component())[0]!.on_click).toBeUndefined();
  });
});

describe("no new Core API (grep the bridge surface)", () => {
  // Runtime code with `--` comments removed, so only real calls are checked.
  const code = ENTRY_SOURCE.split("\n")
    .map((line) => {
      const comment = line.indexOf("--");
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join("\n");
  const calls = [
    ...new Set(
      [...code.matchAll(/bitty\.([a-z_]+)\.([a-z_]+)/g)].map(
        (match) => `${match[1]}.${match[2]}`,
      ),
    ),
  ].sort();

  test("every bitty.<ns>.<fn> call is an accepted v1 surface function", () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(V1_SURFACE_FUNCTIONS).toContain(call);
    }
  });

  test("no process, exec, or load authority is used (clicks never shell out)", () => {
    expect(code).not.toMatch(
      /os\.execute|io\.popen|io\.open|process\.spawn|loadstring|os\.remove|os\.tmpname/,
    );
  });
});

describe("pure chassis helpers", () => {
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

  test("render_template substitutes {key} and keeps unknown keys", () => {
    expect(mod["render_template"]("{a}%", { a: 42 })).toBe("42%");
    expect(mod["render_template"]("cpu {pct}%", { pct: 7 })).toBe("cpu 7%");
    expect(mod["render_template"]("hi {missing}", {})).toBe("hi {missing}");
    expect(mod["render_template"]("plain", {})).toBe("plain");
    expect(mod["render_template"](7, {})).toBe("");
    expect(mod["render_template"]("abcdef", {}, 3)).toBe("abc");
  });

  test("state_token maps a module state to a theme token", () => {
    expect(mod["state_token"]("warning")).toBe("warning");
    expect(mod["state_token"]("critical")).toBe("critical");
    expect(mod["state_token"]("normal")).toBe("normal");
    expect(mod["state_token"]("bogus") ?? null).toBeNull();
    expect(mod["state_token"]() ?? null).toBeNull();
  });

  test("click_binding accepts a command id only", () => {
    const binding = mod["click_binding"]("p:go", { id: 1 }) as {
      command: string;
      args: { id: number };
    };
    expect(binding.command).toBe("p:go");
    expect(binding.args.id).toBe(1);
    expect(mod["click_binding"]("p:go")).toEqual({ command: "p:go" });
    expect(mod["click_binding"](5) ?? null).toBeNull();
    expect(mod["click_binding"]("") ?? null).toBeNull();
  });

  test("tooltip_payload builds a bounded notification or nil", () => {
    expect(mod["tooltip_payload"]("detail")).toEqual({
      title: "Unified Bar",
      body: "detail",
    });
    expect(mod["tooltip_payload"]("") ?? null).toBeNull();
    expect(mod["tooltip_payload"](5) ?? null).toBeNull();
  });

  test("clock_text reads os.date and fails closed", () => {
    expect(mod["clock_text"]("literal", 0)).toBe("literal");
    expect(String(mod["clock_text"]("%M", 0))).toMatch(/^\d\d$/);
    expect(mod["clock_text"]("", 0)).toBe("");
    expect(mod["clock_text"]("%H:%M")).toBe("");
    expect(mod["clock_text"]("%H:%M", "no")).toBe("");
  });

  test("tick_ms is nil for event modules and floor-clamped for timer modules", () => {
    expect(mod["tick_ms"]({ tick_ms: 60000 }, {})).toBe(60000);
    expect(mod["tick_ms"]({ tick_ms: 60000 }, { tick_ms: 1 })).toBe(1000);
    expect(mod["tick_ms"]({ tick_ms: 5000 }, { tick_ms: 200 })).toBe(1000);
    expect(mod["tick_ms"]({}) ?? null).toBeNull();
  });

  test("entry_module accepts a name string or a table entry", () => {
    expect(mod["entry_module"]("clock")).toBe("clock");
    expect(mod["entry_module"]({ module: "clock" })).toBe("clock");
    expect(mod["entry_module"]({ name: "clock" })).toBe("clock");
    expect(mod["entry_module"](5) ?? null).toBeNull();
    expect(mod["entry_module"]("") ?? null).toBeNull();
  });

  test("read_plan resolves group order and falls back to the default", () => {
    const cfg: Record<string, unknown> = {
      modules_left: ["clock", "workspaces"],
    };
    const get = (key: string): unknown => cfg[key];
    const plan = mod["read_plan"](get) as Array<{ name: string }>;
    expect(plan.map((spec) => spec.name)).toEqual(["clock", "workspaces"]);

    delete cfg["modules_left"];
    const fallback = mod["read_plan"](get) as Array<{ name: string }>;
    expect(fallback.map((spec) => spec.name)).toEqual(["workspaces"]);
  });

  test("the module registry exposes workspaces, clock, and the Phase B modules", () => {
    const modules = mod["MODULES"] as Record<string, { name: string }>;
    expect(Object.keys(modules).sort()).toEqual([
      "backlight",
      "battery",
      "bluetooth",
      "clock",
      "cpu",
      "idle",
      "memory",
      "network",
      "workspaces",
    ]);
    expect(modules["workspaces"]!.name).toBe("workspaces");
    expect(modules["clock"]!.name).toBe("clock");
    expect(modules["network"]!.name).toBe("network");
    expect(modules["bluetooth"]!.name).toBe("bluetooth");
    expect(modules["backlight"]!.name).toBe("backlight");
    expect(modules["idle"]!.name).toBe("idle");
    expect(modules["cpu"]!.name).toBe("cpu");
    expect(modules["memory"]!.name).toBe("memory");
    expect(modules["battery"]!.name).toBe("battery");
  });

  test("tick floors keep device modules at their contract cadence", () => {
    const modules = mod["MODULES"] as Record<string, { tick_ms: number }>;
    expect(modules["network"]!.tick_ms).toBe(3000);
    expect(modules["bluetooth"]!.tick_ms).toBe(5000);
    expect(modules["backlight"]!.tick_ms).toBe(5000);
    expect(modules["idle"]!.tick_ms).toBe(5000);
    expect(
      mod["tick_ms"]({ tick_ms: 3000, tick_floor_ms: 3000 }, { tick_ms: 1 }),
    ).toBe(3000);
    expect(mod["tick_ms"]({ tick_ms: 5000, tick_floor_ms: 5000 }, {})).toBe(
      5000,
    );
  });

  test("format_bps humanizes rates and rejects bad measurements", () => {
    expect(mod["format_bps"](0)).toBe("0B");
    expect(mod["format_bps"](999)).toBe("999B");
    expect(mod["format_bps"](8000)).toBe("8.0K");
    expect(mod["format_bps"](1500000)).toBe("1.5M");
    expect(mod["format_bps"]() ?? null).toBeNull();
    expect(mod["format_bps"]("x") ?? null).toBeNull();
    expect(mod["format_bps"](-1) ?? null).toBeNull();
  });

  test("network_text renders link, rates, and the granted ESSID only", () => {
    const data = { link: "wifi", down_bps: 8000, up_bps: 4000 };
    expect(mod["network_text"](data, "Home", {})).toBe("wifi 8.0K/4.0K (Home)");
    expect(mod["network_text"](data, undefined, {})).toBe("wifi 8.0K/4.0K");
    expect(mod["network_text"]({ link: "ethernet" }, undefined, {})).toBe(
      "ethernet",
    );
    expect(
      mod["network_text"]({ link: "satellite" }, undefined, {}) ?? null,
    ).toBeNull();
    expect(
      mod["network_text"](data, undefined, { format: "{link} {down}/{up}" }),
    ).toBe("wifi 8.0K/4.0K");
  });

  test("bluetooth_text and bluetooth_detail stay Lua-side", () => {
    const data = {
      powered: true,
      connected_count: 1,
      total_count: 2,
      devices: [
        { alias: "Headphones", address: "AA:BB:CC:DD:EE:01" },
        { alias: "Keyboard", address: "AA:BB:CC:DD:EE:02" },
      ],
    };
    expect(mod["bluetooth_text"](data, {})).toBe("bt on (1/2)");
    expect(mod["bluetooth_text"]({ powered: false }, {})).toBe("bt off");
    expect(mod["bluetooth_text"]({ powered: "yes" }, {}) ?? null).toBeNull();
    expect(mod["bluetooth_detail"](data)).toBe(
      "Headphones (AA:BB:CC:DD:EE:01), Keyboard (AA:BB:CC:DD:EE:02)",
    );
    expect(mod["bluetooth_detail"]({ devices: {} }) ?? null).toBeNull();
  });

  test("backlight_text, idle_text, valid_step, and compact", () => {
    expect(mod["backlight_text"]({ pct: 75 }, {})).toBe("75%");
    expect(mod["backlight_text"]({ pct: 500 }, {}) ?? null).toBeNull();
    expect(mod["backlight_text"]({ pct: "x" }, {}) ?? null).toBeNull();
    expect(mod["idle_text"]({ inhibited: true }, {})).toBe("inhibit:on");
    expect(mod["idle_text"]({ inhibited: false }, { off_text: "NO" })).toBe(
      "NO",
    );
    expect(mod["idle_text"]({}, {}) ?? null).toBeNull();
    expect(mod["valid_step"](10)).toBe(true);
    expect(mod["valid_step"](1.5)).toBe(false);
    expect(mod["valid_step"](101)).toBe(false);
    expect(mod["compact"]("a  b   c ")).toBe("a b c");
  });
});
