/**
 * Phase B device modules (bitty#2012 network, bitty#2017 bluetooth,
 * bitty#2020 backlight + idle-inhibit): broker `owner:iface@version`
 * providers render link/bandwidth, radio state, brightness, and inhibit
 * state through the declarative chassis — read vs control never mixed,
 * every denial fail-closed.
 *
 * Fixture providers mirror the exact host Lua table shapes
 * (`device_providers/{network,bluetooth,power}.rs`); an unlisted interface
 * resolves exactly like an ungranted or absent provider.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  activateBar,
  type BarRun,
  type ServiceImpl,
  textOf,
  ws,
  type WorkspaceInfo,
} from "./harness.js";

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

const NETWORK_STATE: ServiceImpl = {
  get: () => ({ link: "wifi", down_bps: 8000, up_bps: 4000, stale_age_ms: 0 }),
};

const ESSID: ServiceImpl = {
  get: () => ({ essid: "Home", stale_age_ms: 0 }),
};

function bluetoothState(powered: boolean): ServiceImpl {
  return {
    get: () => ({
      powered,
      connected_count: 1,
      total_count: 2,
      devices: [
        { address: "AA:BB:CC:DD:EE:01", alias: "Headphones", connected: true },
        { address: "AA:BB:CC:DD:EE:02", alias: "Keyboard", connected: false },
      ],
      truncated: false,
      stale_age_ms: 0,
    }),
  };
}

function backlightState(pct: number): ServiceImpl {
  return {
    get: () => ({ pct, max: 1200, stale_age_ms: 0 }),
  };
}

function idleState(inhibited: boolean): ServiceImpl {
  return {
    get: () => ({ inhibited, stale_age_ms: 0 }),
  };
}

describe("network module (bitty#2012)", () => {
  test("renders link plus humanized bandwidth", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network"] },
      services: { "network.state": { version: "1.0.0", impl: NETWORK_STATE } },
    });
    expect(painted(run)).toBe("wifi 8.0K/4.0K");
  });

  test("ESSID renders only when the sub-grant is held", async () => {
    const granted = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network"] },
      services: {
        "network.state": { version: "1.0.0", impl: NETWORK_STATE },
        "network.essid": { version: "1.0.0", impl: ESSID },
      },
    });
    expect(painted(granted)).toBe("wifi 8.0K/4.0K (Home)");

    const ungranted = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network"] },
      services: { "network.state": { version: "1.0.0", impl: NETWORK_STATE } },
    });
    expect(painted(ungranted)).toBe("wifi 8.0K/4.0K");
  });

  test("unmeasured rates are omitted, never fabricated", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network"] },
      services: {
        "network.state": {
          version: "1.0.0",
          impl: { get: () => ({ link: "ethernet", stale_age_ms: 0 }) },
        },
      },
    });
    expect(painted(run)).toBe("ethernet");
  });

  test("ungranted hides the module, the rest of the plan is unaffected", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network", "workspaces"] },
    });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("an invalid link or a failing read hides the module", async () => {
    const badLink = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network", "workspaces"] },
      services: {
        "network.state": {
          version: "1.0.0",
          impl: { get: () => ({ link: "satellite", stale_age_ms: 0 }) },
        },
      },
    });
    expect(painted(badLink)).toBe("1:ws1 4:code* 9:logs (3)");

    const failing = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network", "workspaces"] },
      services: {
        "network.state": {
          version: "1.0.0",
          impl: {
            get: () => {
              throw new Error("E_SERVICE_GONE: provider is gone");
            },
          },
        },
      },
    });
    expect(painted(failing)).toBe("1:ws1 4:code* 9:logs (3)");
    expect(failing.host.handlerViolations).toEqual([]);
  });

  test("a custom format overrides the whole text with clean gaps", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["network"],
        network: { format: "{link} down {down} up {up} {essid}" },
      },
      services: { "network.state": { version: "1.0.0", impl: NETWORK_STATE } },
    });
    expect(painted(run)).toBe("wifi down 8.0K up 4.0K");
  });

  test("the network poll floor is 3s", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["network"],
        network: { tick_ms: 1 },
      },
      services: { "network.state": { version: "1.0.0", impl: NETWORK_STATE } },
    });
    run.host.advanceTimers(2999);
    expect(run.updates()).toBe(0);
    run.host.advanceTimers(1);
    expect(run.updates()).toBe(1);
  });
});

describe("bluetooth module (bitty#2017)", () => {
  test("renders radio state plus device counts", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["bluetooth"] },
      services: {
        "bluetooth.state": { version: "1.0.0", impl: bluetoothState(true) },
      },
    });
    expect(painted(run)).toBe("bt on (1/2)");
  });

  test("read-only by default: device detail rides the tooltip fallback", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["bluetooth"] },
      services: {
        "bluetooth.state": { version: "1.0.0", impl: bluetoothState(true) },
      },
    });
    const node = run.component();
    const leaf = node.children![0]!;
    expect(leaf.on_click).toEqual({
      command: "bitty-terminal.bar:detail",
      args: {
        text: "Headphones (AA:BB:CC:DD:EE:01), Keyboard (AA:BB:CC:DD:EE:02)",
      },
    });
    expect(
      run.host.dispatchCommand("bitty-terminal.bar:detail", {
        text: "Headphones (AA:BB:CC:DD:EE:01), Keyboard (AA:BB:CC:DD:EE:02)",
      }),
    ).toBe(true);
    expect(run.host.notifications).toEqual([
      {
        title: "Unified Bar",
        body: "Headphones (AA:BB:CC:DD:EE:01), Keyboard (AA:BB:CC:DD:EE:02)",
      },
    ]);
  });

  test("toggle binds only with the control head and flips power", async () => {
    const calls: unknown[] = [];
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["bluetooth"], bluetooth: { toggle: true } },
      services: {
        "bluetooth.state": { version: "1.0.0", impl: bluetoothState(true) },
        "bluetooth.control": {
          version: "1.0.0",
          impl: {
            set_power: (on: unknown) => {
              calls.push(on);
              return true;
            },
          },
        },
      },
    });
    expect(run.component().children![0]!.on_click).toEqual({
      command: "bitty-terminal.bar:bluetooth-toggle",
    });
    expect(
      run.host.dispatchCommand("bitty-terminal.bar:bluetooth-toggle"),
    ).toBe(true);
    expect(calls).toEqual([false]);
  });

  test("toggle without the control head stays read-only", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["bluetooth"], bluetooth: { toggle: true } },
      services: {
        "bluetooth.state": { version: "1.0.0", impl: bluetoothState(false) },
      },
    });
    expect(painted(run)).toBe("bt off");
    expect(run.component().children![0]!.on_click?.command).toBe(
      "bitty-terminal.bar:detail",
    );
  });

  test("a denied toggle degrades to notify exactly once", async () => {
    let calls = 0;
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["bluetooth"], bluetooth: { toggle: true } },
      services: {
        "bluetooth.state": { version: "1.0.0", impl: bluetoothState(true) },
        "bluetooth.control": {
          version: "1.0.0",
          impl: {
            set_power: () => {
              calls += 1;
              throw new Error("E_NOT_PERMITTED: bluetooth control denied");
            },
          },
        },
      },
    });
    expect(
      run.host.dispatchCommand("bitty-terminal.bar:bluetooth-toggle"),
    ).toBe(false);
    expect(calls).toBe(1);
    expect(run.host.notifications).toEqual([
      { title: "Unified Bar", body: "Bluetooth control unavailable." },
    ]);
    expect(painted(run)).toBe("bt on (1/2)");
  });

  test("ungranted or misshapen hides the module", async () => {
    const ungranted = await bar({
      workspaces: THREE,
      settings: { modules_left: ["bluetooth", "workspaces"] },
    });
    expect(painted(ungranted)).toBe("1:ws1 4:code* 9:logs (3)");

    const misshapen = await bar({
      workspaces: THREE,
      settings: { modules_left: ["bluetooth", "workspaces"] },
      services: {
        "bluetooth.state": {
          version: "1.0.0",
          impl: { get: () => ({ powered: "yes", stale_age_ms: 0 }) },
        },
      },
    });
    expect(painted(misshapen)).toBe("1:ws1 4:code* 9:logs (3)");
  });
});

describe("backlight module (bitty#2020, DEC-0115)", () => {
  test("renders brightness and steps on click", async () => {
    const calls: unknown[] = [];
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["backlight"] },
      services: {
        "backlight.state": { version: "1.0.0", impl: backlightState(75) },
        "backlight.control": {
          version: "1.0.0",
          impl: {
            set_step: (delta: unknown) => {
              calls.push(delta);
              return 850;
            },
          },
        },
      },
    });
    expect(painted(run)).toBe("75%");
    expect(run.component().children![0]!.on_click).toEqual({
      command: "bitty-terminal.bar:backlight-step",
      args: { delta: 10 },
    });
    expect(
      run.host.dispatchCommand("bitty-terminal.bar:backlight-step", {
        delta: 10,
      }),
    ).toBe(true);
    expect(calls).toEqual([10]);
  });

  test("the step option drives the click delta", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["backlight"], backlight: { step: -5 } },
      services: {
        "backlight.state": { version: "1.0.0", impl: backlightState(75) },
        "backlight.control": {
          version: "1.0.0",
          impl: { set_step: () => 700 },
        },
      },
    });
    expect(run.component().children![0]!.on_click).toEqual({
      command: "bitty-terminal.bar:backlight-step",
      args: { delta: -5 },
    });
  });

  test("E_NOT_PERMITTED degrades to notify, never retries or escalates", async () => {
    let calls = 0;
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["backlight"] },
      services: {
        "backlight.state": { version: "1.0.0", impl: backlightState(75) },
        "backlight.control": {
          version: "1.0.0",
          impl: {
            set_step: () => {
              calls += 1;
              throw new Error(
                "E_NOT_PERMITTED: backlight control not permitted",
              );
            },
          },
        },
      },
    });
    expect(
      run.host.dispatchCommand("bitty-terminal.bar:backlight-step", {
        delta: 10,
      }),
    ).toBe(false);
    expect(calls).toBe(1);
    expect(run.host.notifications).toEqual([
      { title: "Unified Bar", body: "Backlight control unavailable." },
    ]);
    expect(painted(run)).toBe("75%");
  });

  test("without the control head the module is read-only", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["backlight"] },
      services: {
        "backlight.state": { version: "1.0.0", impl: backlightState(75) },
      },
    });
    expect(painted(run)).toBe("75%");
    expect(run.component().children![0]!.on_click).toBeUndefined();
  });

  test("an out-of-range brightness hides the module", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["backlight", "workspaces"] },
      services: {
        "backlight.state": { version: "1.0.0", impl: backlightState(500) },
      },
    });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
  });
});

describe("idle-inhibit module (bitty#2020)", () => {
  test("renders state and toggles through the control head", async () => {
    const calls: unknown[] = [];
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["idle"] },
      services: {
        "idle.state": { version: "1.0.0", impl: idleState(true) },
        "idle.control": {
          version: "1.0.0",
          impl: {
            set: (on: unknown) => {
              calls.push(on);
            },
          },
        },
      },
    });
    expect(painted(run)).toBe("inhibit:on");
    expect(run.component().children![0]!.on_click).toEqual({
      command: "bitty-terminal.bar:idle-toggle",
    });
    expect(run.host.dispatchCommand("bitty-terminal.bar:idle-toggle")).toBe(
      true,
    );
    expect(calls).toEqual([false]);
  });

  test("activated/deactivated glyphs stay config-side", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["idle"],
        idle: { on_text: "YES", off_text: "NO" },
      },
      services: {
        "idle.state": { version: "1.0.0", impl: idleState(false) },
      },
    });
    expect(painted(run)).toBe("NO");
  });

  test("a denied toggle degrades to notify", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["idle"] },
      services: {
        "idle.state": { version: "1.0.0", impl: idleState(false) },
        "idle.control": {
          version: "1.0.0",
          impl: {
            set: () => {
              throw new Error("E_NOT_PERMITTED: idle control denied");
            },
          },
        },
      },
    });
    expect(run.host.dispatchCommand("bitty-terminal.bar:idle-toggle")).toBe(
      false,
    );
    expect(run.host.notifications).toEqual([
      { title: "Unified Bar", body: "Idle control unavailable." },
    ]);
  });

  test("without the control head the module is read-only; ungranted hides", async () => {
    const readOnly = await bar({
      workspaces: THREE,
      settings: { modules_left: ["idle"] },
      services: {
        "idle.state": { version: "1.0.0", impl: idleState(true) },
      },
    });
    expect(painted(readOnly)).toBe("inhibit:on");
    expect(readOnly.component().children![0]!.on_click).toBeUndefined();

    const ungranted = await bar({
      workspaces: THREE,
      settings: { modules_left: ["idle", "workspaces"] },
    });
    expect(painted(ungranted)).toBe("1:ws1 4:code* 9:logs (3)");
  });
});
