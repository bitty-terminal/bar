/**
 * Per-button pointer actions (bar#30): every region-aware span dispatches a
 * registered command with the host-injected `button` (`left`/`right`/`middle`)
 * or wheel `delta`. No shell string is a vehicle, and a direct palette
 * invocation without a button reads as the primary button.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  activateBar,
  leaves,
  MANIFEST_SOURCE,
  textOf,
  ws,
  type BarRun,
  type WorkspaceInfo,
} from "./harness.js";

const ACTION = "bitty-terminal.bar:workspace-action";
const CLOCK = "bitty-terminal.bar:clock-action";
const NETWORK = "bitty-terminal.bar:network-action";
const AUDIO_TOGGLE = "bitty-terminal.bar:audio-toggle";
const AUDIO_STEP = "bitty-terminal.bar:audio-step";
const MICROPHONE = "bitty-terminal.bar:microphone-action";
const MICROPHONE_STEP = "bitty-terminal.bar:microphone-step";
const DETAIL = "bitty-terminal.bar:detail";

const THREE: WorkspaceInfo[] = [
  ws(1, "ws1"),
  ws(4, "code", true),
  ws(9, "logs"),
];

const WORKSPACE_ONLY = { modules_center: [], modules_right: [] } as const;
const runs: BarRun[] = [];

async function bar(
  options: Parameters<typeof activateBar>[0] = {},
): Promise<BarRun> {
  const run = await activateBar({
    ...options,
    settings: { ...WORKSPACE_ONLY, ...options.settings },
  });
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

function leafFor(run: BarRun, text: string) {
  const leaf = leaves(run.component()).find((entry) => entry.text === text);
  if (leaf === undefined) {
    throw new Error(`no leaf with text ${JSON.stringify(text)}`);
  }
  return leaf;
}

const NETWORK_STATE = {
  get: () => ({
    link: "wifi",
    down_bps: 8000,
    up_bps: 4000,
    stale_age_ms: 0,
  }),
};

const NETWORK_ESSID = { get: () => ({ essid: "Home" }) };

describe("workspace buttons", () => {
  test("left focuses, active-left is a no-op, right/middle show detail", async () => {
    const run = await bar({ workspaces: THREE });
    expect(run.host.dispatchCommand(ACTION, { id: 9 })).toBe(true);
    expect(run.host.drainWorkspaceRequests()).toEqual([
      { kind: "focus_id", id: 9 },
    ]);

    expect(run.host.dispatchCommand(ACTION, { id: 4 })).toBe(false);
    expect(run.host.drainWorkspaceRequests()).toEqual([]);

    expect(run.host.dispatchCommand(ACTION, { id: 9, button: "right" })).toBe(
      true,
    );
    expect(run.host.dispatchCommand(ACTION, { id: 4, button: "middle" })).toBe(
      true,
    );
    expect(run.host.notifications.map((entry) => entry.body)).toEqual([
      "Workspace 9: logs",
      "Workspace 4: code (active)",
    ]);
    expect(run.host.drainWorkspaceRequests()).toEqual([]);
  });

  test("the wheel cycles previous on wheel-up and next on wheel-down", async () => {
    const run = await bar({ workspaces: THREE });
    expect(run.host.dispatchCommand(ACTION, { delta: 1 })).toBe(true);
    expect(run.host.drainWorkspaceRequests()).toEqual([
      { kind: "focus_id", id: 1 },
    ]);
    expect(run.host.dispatchCommand(ACTION, { delta: -1 })).toBe(true);
    expect(run.host.drainWorkspaceRequests()).toEqual([
      { kind: "focus_id", id: 9 },
    ]);
    expect(run.host.dispatchCommand(ACTION, { delta: 0 })).toBe(false);
  });

  test("every capsule exposes the item region and both bindings", async () => {
    const run = await bar({ workspaces: THREE });
    for (const id of [1, 4, 9]) {
      const leaf = leafFor(run, id === 4 ? " 4* " : ` ${id} `);
      expect(leaf.on_click?.command).toBe(ACTION);
      expect(leaf.on_click?.region).toEqual({
        id: `workspace.${id}`,
        kind: "item",
      });
      expect(leaf.on_scroll?.command).toBe(ACTION);
      expect(leaf.on_scroll?.region).toEqual({
        id: `workspace.${id}`,
        kind: "item",
      });
    }
  });
});

describe("clock buttons", () => {
  test("right cycles short -> date -> calendar and middle shows detail", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["clock"] },
    });
    expect(textOf(run.component())).toMatch(/^\d\d:\d\d$/);
    expect(run.host.dispatchCommand(CLOCK, { button: "right" })).toBe(true);
    expect(textOf(run.component())).toMatch(/^\w{3} \d\d \w{3}$/);
    expect(run.host.dispatchCommand(CLOCK, { button: "right" })).toBe(true);
    expect(textOf(run.component())).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(run.host.dispatchCommand(CLOCK, { button: "right" })).toBe(true);
    expect(textOf(run.component())).toMatch(/^\d\d:\d\d$/);

    expect(run.host.dispatchCommand(CLOCK, { button: "middle" })).toBe(true);
    expect(run.host.notifications).toHaveLength(1);
    expect(run.host.notifications[0]!.body).toMatch(
      /^\w+, \d\d \w+ \d{4} \d\d:\d\d:\d\d$/,
    );
    expect(run.host.dispatchCommand(CLOCK, { button: "left" })).toBe(false);
  });

  test("the atom carries the clock region", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["clock"] },
    });
    expect(leaves(run.component())[0]!.on_click).toEqual({
      command: CLOCK,
      args: {},
      region: { id: "clock", kind: "module" },
    });
  });
});

describe("network buttons", () => {
  test("left and middle show the link detail", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network"] },
      services: {
        "network.state": { version: "1.0.0", impl: NETWORK_STATE },
        "network.essid": { version: "1.0.0", impl: NETWORK_ESSID },
      },
    });
    expect(run.host.dispatchCommand(NETWORK, { button: "left" })).toBe(true);
    expect(run.host.dispatchCommand(NETWORK, { button: "middle" })).toBe(true);
    expect(run.host.notifications.map((entry) => entry.body)).toEqual([
      "wifi 8.0K/4.0K (Home)",
      "wifi 8.0K/4.0K (Home)",
    ]);
  });

  test("right falls back to detail without a control head", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network"] },
      services: {
        "network.state": { version: "1.0.0", impl: NETWORK_STATE },
      },
    });
    expect(run.host.dispatchCommand(NETWORK, { button: "right" })).toBe(true);
    expect(run.host.notifications.map((entry) => entry.body)).toEqual([
      "wifi 8.0K/4.0K",
    ]);
  });

  test("right toggles the radio when a control head resolves", async () => {
    const calls: unknown[] = [];
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network"] },
      services: {
        "network.state": { version: "1.0.0", impl: NETWORK_STATE },
        "network.control": {
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
    expect(run.host.dispatchCommand(NETWORK, { button: "right" })).toBe(true);
    expect(calls).toEqual([false]);
    expect(run.host.notifications).toEqual([]);
  });

  test("the atom carries the network region", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["network"] },
      services: { "network.state": { version: "1.0.0", impl: NETWORK_STATE } },
    });
    expect(leaves(run.component())[0]!.on_click).toEqual({
      command: NETWORK,
      args: {},
      region: { id: "network", kind: "module" },
    });
  });
});

describe("audio buttons", () => {
  const AUDIO = { volume_pct: 50, muted: false, port: "p" };

  test("left and middle toggle mute; right shows detail; wheel steps", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio"] },
      audioState: AUDIO,
      audioControl: true,
    });
    expect(run.host.dispatchCommand(AUDIO_TOGGLE, { button: "left" })).toBe(
      true,
    );
    expect(run.host.dispatchCommand(AUDIO_TOGGLE, { button: "middle" })).toBe(
      true,
    );
    expect(run.audioControl().toggles).toBe(2);
    expect(run.host.dispatchCommand(AUDIO_TOGGLE, { button: "right" })).toBe(
      true,
    );
    expect(run.audioControl().toggles).toBe(2);
    expect(run.host.notifications.map((entry) => entry.body)).toEqual([
      "Volume 50%, p",
    ]);
    expect(
      run.host.dispatchCommand(AUDIO_STEP, { delta: 4, region: "pulseaudio" }),
    ).toBe(true);
    expect(run.audioControl().steps).toEqual([4]);
  });

  test("without the control head the click is the detail fallback", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio"] },
      audioState: AUDIO,
    });
    const leaf = leaves(run.component())[0]!;
    expect(leaf.on_click).toEqual({
      command: DETAIL,
      args: { text: "p" },
      region: { id: "pulseaudio", kind: "module" },
    });
    expect(leaf.on_scroll).toBeUndefined();
    expect(
      run.host.dispatchCommand(DETAIL, {
        text: "p",
        button: "middle",
        region: "pulseaudio",
      }),
    ).toBe(true);
  });
});

describe("microphone buttons", () => {
  const SOURCE = {
    volume_pct: 50,
    muted: false,
    port: "p",
    source_volume_pct: 70,
    source_muted: false,
  };

  test("the module is hidden when the provider reports no source fields", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["microphone", "workspaces"] },
      audioState: { volume_pct: 50, muted: false, port: "p" },
      audioControl: true,
      audioSourceControl: true,
    });
    expect(textOf(run.component())).toBe(" 1   4*   9 ");
  });

  test("left/right toggle source mute, middle shows detail, wheel steps input", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["microphone"] },
      audioState: SOURCE,
      audioControl: true,
      audioSourceControl: true,
    });
    expect(textOf(run.component())).toBe("mic 70%");
    expect(run.host.dispatchCommand(MICROPHONE, { button: "left" })).toBe(true);
    expect(run.host.dispatchCommand(MICROPHONE, { button: "right" })).toBe(
      true,
    );
    expect(run.audioControl().sourceToggles).toBe(2);
    expect(run.audioControl().toggles).toBe(0);
    expect(run.host.dispatchCommand(MICROPHONE, { button: "middle" })).toBe(
      true,
    );
    expect(run.host.notifications.map((entry) => entry.body)).toEqual([
      "Microphone 70%",
    ]);
    expect(
      run.host.dispatchCommand(MICROPHONE_STEP, {
        delta: 3,
        region: "microphone",
      }),
    ).toBe(true);
    expect(run.audioControl().sourceSteps).toEqual([3]);
    expect(run.audioControl().steps).toEqual([]);
  });

  test("without source control the atom is read-only and buttons show detail", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["microphone"] },
      audioState: SOURCE,
      audioControl: true,
    });
    const leaf = leaves(run.component())[0]!;
    expect(leaf.on_click).toEqual({
      command: DETAIL,
      args: { text: "Microphone 70%" },
      region: { id: "microphone", kind: "module" },
    });
    expect(leaf.on_scroll).toBeUndefined();
    expect(run.host.dispatchCommand(MICROPHONE, { button: "left" })).toBe(
      false,
    );
    expect(run.audioControl().sourceToggles).toBe(0);
  });

  test("a muted source paints the muted icon", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["microphone"], icons: "nerd" },
      audioState: { ...SOURCE, source_muted: true },
      audioControl: true,
      audioSourceControl: true,
    });
    expect(textOf(run.component())).toBe("󰍭 70%");
  });
});

describe("command schema and registration", () => {
  test("an unknown button spelling is rejected by the host schema", async () => {
    const run = await bar({ workspaces: THREE });
    expect(() =>
      run.host.dispatchCommand(ACTION, { button: "back" }),
    ).toThrow();
    expect(() =>
      run.host.dispatchCommand(ACTION, { button: "left", x: 1 }),
    ).toThrow();
    expect(() =>
      run.host.dispatchCommand(ACTION, { region: "x".repeat(65) }),
    ).toThrow();
  });

  test("every binding command is declared in the manifest lazy triggers", async () => {
    const declared = new Set(
      [...MANIFEST_SOURCE.matchAll(/"bitty-terminal\.bar:([a-z-]+)"/g)].map(
        (match) => match[1],
      ),
    );
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["workspaces", "clock", "network"] },
      services: { "network.state": { version: "1.0.0", impl: NETWORK_STATE } },
    });
    for (const leaf of leaves(run.component())) {
      for (const binding of [leaf.on_click, leaf.on_scroll]) {
        if (binding === undefined) continue;
        const verb = binding.command.split(":").at(-1)!;
        expect(declared.has(verb)).toBe(true);
      }
    }
  });
});
