/**
 * Core #2411 / bar#30: true left/center/right module groups and the hover
 * detail tooltip.
 *
 * The plugin emits one anchored Row per non-empty group and one `on_hover`
 * binding per module instance; Core owns the width-dependent placement,
 * clipping, and the overlay anchor. These tests pin everything the plugin
 * owns: the scene shape, unique stable region ids, the bounded overlay text,
 * enter/leave lifecycle (including stale leaves), preserved click/wheel
 * bindings, empty/hidden group safety, and both band edges.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { LuaFactory } from "wasmoon";

import { BAR_CAPABILITIES } from "./harness.js";

import {
  activateBar,
  ENTRY_SOURCE,
  HOVER_COMMAND,
  leaves,
  type BarRun,
  type SceneNode,
  textOf,
  ws,
  type WorkspaceInfo,
} from "./harness.js";

const runs: BarRun[] = [];

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

async function bar(
  options: Parameters<typeof activateBar>[0] = {},
): Promise<BarRun> {
  const run = await activateBar(options);
  runs.push(run);
  return run;
}

const THREE: WorkspaceInfo[] = [
  ws(1, "ws1"),
  ws(4, "code", true),
  ws(9, "logs"),
];

const CPU = "system.cpu";
const CPU_SNAP = {
  total_pct: 42.4,
  per_core: [50, 30],
  stale_age_ms: 0,
};

const SENSOR_GRANTS: readonly string[] = [
  ...BAR_CAPABILITIES,
  "platform.cpu-read",
];

const ALL_GROUPS = {
  modules_left: ["workspaces"],
  modules_center: ["clock"],
  modules_right: ["cpu"],
} as const;

/** Group rows of the bar root (Core resolves their anchors). */
function groups(run: BarRun): readonly SceneNode[] {
  return run.component().children ?? [];
}

/** Hover bindings in paint order. */
function hoverBindings(run: BarRun): NonNullable<SceneNode["on_hover"]>[] {
  return leaves(run.component())
    .map((leaf) => leaf.on_hover)
    .filter(
      (binding): binding is NonNullable<SceneNode["on_hover"]> =>
        binding !== undefined,
    );
}

function regionIds(run: BarRun): string[] {
  return hoverBindings(run).map((binding) => binding.region!.id);
}

/** Collect the group rows of one module, in paint order. */
function groupLeaves(run: BarRun, index: number): string[] {
  return leaves(groups(run)[index]!).map((leaf) => leaf.text ?? "");
}

describe("true module groups (Core #2411 anchors)", () => {
  test("the root is one anchored Row per populated group, in declared order", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: ALL_GROUPS,
      grants: SENSOR_GRANTS,
      services: { [CPU]: { snapshot: CPU_SNAP } },
    });
    const children = groups(run);
    expect(children).toHaveLength(3);
    expect(children.map((node) => node.kind)).toEqual(["Row", "Row", "Row"]);
    expect(children.map((node) => node.anchor)).toEqual([
      "left",
      "center",
      "right",
    ]);
    expect(groupLeaves(run, 0).join("")).toBe(" 1   4*   9 ");
    expect(groupLeaves(run, 1)).toEqual([expect.stringMatching(/^\d\d:\d\d$/)]);
    expect(groupLeaves(run, 2)).toEqual(["42%"]);
    expect(textOf(run.component())).toBe(
      ` 1   4*   9 ${groupLeaves(run, 1)[0]}42%`,
    );
  });

  test("module order inside a group is preserved", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["clock", "workspaces"],
        modules_center: [],
        modules_right: [],
      },
    });
    expect(groupLeaves(run, 0)).toEqual([
      expect.stringMatching(/^\d\d:\d\d$/),
      " ",
      " 1 ",
      " ",
      " 4* ",
      " ",
      " 9 ",
    ]);
  });

  test("empty and all-hidden groups are omitted without crashing", async () => {
    const centerOnly = await bar({
      workspaces: THREE,
      settings: {
        modules_left: [],
        modules_center: ["clock"],
        modules_right: [],
      },
    });
    expect(groups(centerOnly).map((node) => node.anchor)).toEqual(["center"]);

    // A plan whose only module hides (no provider) paints nothing at all.
    const hidden = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["cpu"],
        modules_center: [],
        modules_right: [],
      },
    });
    expect(textOf(hidden.component())).toBe("");
    expect(hidden.component().kind).toBe("Text");

    // Unknown-only lists fall back to the shipped plan instead of hiding.
    const fallback = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["nope"],
        modules_center: [],
        modules_right: [],
      },
    });
    expect(textOf(fallback.component())).toMatch(/^ 1   4\*   9 \d\d:\d\d$/);
    expect(fallback.host.handlerViolations).toEqual([]);
  });
});

describe("hover regions", () => {
  test("every module atom carries a unique, stable module region", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: ALL_GROUPS,
      grants: SENSOR_GRANTS,
      services: { [CPU]: { snapshot: CPU_SNAP } },
    });

    const bindings = hoverBindings(run);
    expect(bindings.length).toBeGreaterThan(0);
    // One region per module instance: every atom of a module shares it, and
    // no two modules share an id.
    const ids = [...new Set(bindings.map((binding) => binding.region!.id))];
    expect(ids).toHaveLength(3);

    const workspaceAtoms = leaves(groups(run)[0]!);
    expect(workspaceAtoms.length).toBeGreaterThan(0);
    for (const leaf of workspaceAtoms) {
      expect(leaf.on_hover).toEqual({
        command: HOVER_COMMAND,
        args: { region: "bar:module:workspaces" },
        region: { id: "bar:module:workspaces", kind: "module" },
      });
    }
    for (const binding of bindings) {
      expect(binding.command).toBe(HOVER_COMMAND);
      expect(binding.region!.kind).toBe("module");
      expect(binding.region!.id).toMatch(/^[a-z0-9._:-]{1,64}$/);
      expect(binding.args!["region"]).toBe(binding.region!.id);
    }
    expect(ids).toContain("bar:module:clock");
    expect(ids).toContain("bar:module:cpu");
  });

  test("a repeated module name gets a distinct region per instance", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["clock", "clock"],
        modules_center: [],
        modules_right: [],
      },
    });
    const ids = regionIds(run);
    expect(ids).toEqual(["bar:module:clock", "bar:module:clock:2"]);
    expect(textOf(run.component())).toMatch(/^\d\d:\d\d \d\d:\d\d$/);
  });

  test("a module with no detail still exposes a hover region", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["spectrum"],
        modules_center: [],
        modules_right: [],
      },
      audioSpectrum: [1, 2, 3],
    });
    expect(textOf(run.component())).not.toBe("");
    const ids = regionIds(run);
    expect(ids).toEqual(["bar:module:spectrum"]);
  });
});

describe("overlay tooltip lifecycle", () => {
  test("enter shows the module detail and leave clears it", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["cpu"],
        modules_center: [],
        modules_right: [],
      },
      grants: SENSOR_GRANTS,
      services: { [CPU]: { snapshot: CPU_SNAP } },
    });
    const leaf = leaves(run.component())[0]!;
    const region = leaf.on_hover!.region!.id;
    expect(run.overlay()).toEqual({ kind: "Text", text: "" });
    expect(run.overlayText()).toBe("");

    expect(
      run.host.dispatchCommand(HOVER_COMMAND, { region, phase: "enter" }),
    ).toBe(true);
    expect(run.overlayText()).toBe("CPU 42% (2 cores)");
    expect(run.overlay()!.kind).toBe("Text");
    expect(run.host.notifications).toEqual([]);

    expect(
      run.host.dispatchCommand(HOVER_COMMAND, { region, phase: "leave" }),
    ).toBe(true);
    expect(run.overlayText()).toBe("");
    expect(run.host.notifications).toEqual([]);
  });

  test("a stale leave never clears a newer tooltip", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: ALL_GROUPS,
      grants: SENSOR_GRANTS,
      services: { [CPU]: { snapshot: CPU_SNAP } },
    });
    const workspaceRegion = leaves(groups(run)[0]!)[0]!.on_hover!.region!.id;
    const cpuRegion = leaves(groups(run)[2]!)[0]!.on_hover!.region!.id;

    run.host.dispatchCommand(HOVER_COMMAND, {
      region: workspaceRegion,
      phase: "enter",
    });
    expect(run.overlayText()).toBe("Workspaces: 1, 4*, 9");
    run.host.dispatchCommand(HOVER_COMMAND, {
      region: cpuRegion,
      phase: "enter",
    });
    expect(run.overlayText()).toBe("CPU 42% (2 cores)");

    // The paired leave for the previous region arrives after the new enter:
    // it must not blank the live tooltip.
    run.host.dispatchCommand(HOVER_COMMAND, {
      region: workspaceRegion,
      phase: "leave",
    });
    expect(run.overlayText()).toBe("CPU 42% (2 cores)");
  });

  test("hover detail refreshes on a live module tick", async () => {
    let total = 42.4;
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["cpu"],
        modules_center: [],
        modules_right: [],
      },
      grants: SENSOR_GRANTS,
      services: {
        [CPU]: {
          snapshot: () => ({
            total_pct: total,
            per_core: [50, 30],
            stale_age_ms: 0,
          }),
        },
      },
    });
    const region = leaves(run.component())[0]!.on_hover!.region!.id;
    run.host.dispatchCommand(HOVER_COMMAND, { region, phase: "enter" });
    expect(run.overlayText()).toBe("CPU 42% (2 cores)");

    total = 71.6;
    run.host.advanceTimers(2000);
    expect(run.overlayText()).toBe("CPU 72% (2 cores)");
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("clock tooltip formats names and refreshes on the module tick", async () => {
    // bitty#2530: the hover detail must be formatted (never raw `%A`/`%B`)
    // and must keep updating while the tooltip is open. The fake clock makes
    // the cadence assertion deterministic; the default 60 s clock tick is the
    // refresh that moves the minute.
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["clock"],
        modules_center: [],
        modules_right: [],
      },
      fakeNow: 1792717763,
    });
    const region = leaves(run.component())[0]!.on_hover!.region!.id;
    run.host.dispatchCommand(HOVER_COMMAND, { region, phase: "enter" });
    const first = run.overlayText();
    expect(first).not.toContain("%");
    expect(first).toMatch(
      /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), \d\d (January|February|March|April|May|June|July|August|September|October|November|December) \d{4} \d\d:\d\d$/,
    );

    run.setNow(1792717763 + 60);
    run.host.advanceTimers(60000);
    const second = run.overlayText();
    expect(second).not.toBe(first);
    expect(second).toMatch(/:\d\d$/);
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("a transient band update fault does not freeze the tooltip", async () => {
    // bitty#2530: Core can abort a timer callback (wall budget) or the host
    // bridge can reject one `ui.update`. The timer chain re-arms before the
    // render, so one faulted frame must not stop the cadence and leave the
    // tooltip frozen; the host still records the fault.
    let total = 42.4;
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["cpu"],
        modules_center: [],
        modules_right: [],
      },
      grants: SENSOR_GRANTS,
      services: {
        [CPU]: {
          snapshot: () => ({
            total_pct: total,
            per_core: [50, 30],
            stale_age_ms: 0,
          }),
        },
      },
      failBandUpdates: 1,
    });
    const region = leaves(run.component())[0]!.on_hover!.region!.id;
    run.host.dispatchCommand(HOVER_COMMAND, { region, phase: "enter" });
    expect(run.overlayText()).toBe("CPU 42% (2 cores)");

    // First tick renders fresh text, then the injected band update fault is
    // contained by the host (one diagnostic, never a silent stall).
    total = 71.6;
    run.host.advanceTimers(2000);
    expect(run.overlayText()).toBe("CPU 72% (2 cores)");
    expect(run.host.handlerViolations).toHaveLength(1);

    // The next pre-armed tick still renders, so the tooltip keeps updating.
    total = 88.2;
    run.host.advanceTimers(2000);
    expect(run.overlayText()).toBe("CPU 88% (2 cores)");
    expect(run.host.handlerViolations).toHaveLength(1);
  });

  test("hiding the bar clears the tooltip", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["cpu"],
        modules_center: [],
        modules_right: [],
      },
      grants: SENSOR_GRANTS,
      services: { [CPU]: { snapshot: CPU_SNAP } },
    });
    const region = leaves(run.component())[0]!.on_hover!.region!.id;
    run.host.dispatchCommand(HOVER_COMMAND, { region, phase: "enter" });
    expect(run.overlayText()).not.toBe("");

    run.host.bitty.settings.set("show", false);
    run.host.publish("config.reloaded", {});
    expect(run.overlayText()).toBe("");
    expect(textOf(run.component())).toBe("");
  });

  test("the tooltip text is bounded and single-line", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["cpu"],
        modules_center: [],
        modules_right: [],
      },
      grants: SENSOR_GRANTS,
      services: { [CPU]: { snapshot: CPU_SNAP } },
    });
    const region = leaves(run.component())[0]!.on_hover!.region!.id;
    run.host.dispatchCommand(HOVER_COMMAND, { region, phase: "enter" });
    const tooltip = run.overlayText();
    expect(tooltip).not.toContain("\n");
    expect(new TextEncoder().encode(tooltip).length).toBeLessThanOrEqual(256);
    expect(tooltip).toBe(tooltip.trim());
  });

  test("hover_detail_text collapses control bytes and bounds the row", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      const mod = (await lua.doString(ENTRY_SOURCE)) as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      expect(await mod["hover_detail_text"]("a\nb\tc")).toBe("a b c");
      expect(await mod["hover_detail_text"]("  spaced  ")).toBe("spaced");
      expect(await mod["hover_detail_text"]("")).toBeNil();
      expect(await mod["hover_detail_text"](5)).toBeNil();
      const long = (await mod["hover_detail_text"]("x".repeat(1000))) as string;
      expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(256);
    } finally {
      lua.global.close();
    }
  });

  test("an unknown region enter is a no-op, not a notification", async () => {
    const run = await bar({ workspaces: THREE });
    expect(
      run.host.dispatchCommand(HOVER_COMMAND, {
        region: "bar:module:missing",
        phase: "enter",
      }),
    ).toBe(true);
    expect(run.overlayText()).toBe("");
    expect(run.host.notifications).toEqual([]);
  });
});

describe("clicks and wheel bindings survive hover", () => {
  test("a workspace capsule keeps its focus click and wheel target", async () => {
    const run = await bar({ workspaces: THREE });
    const pill = leaves(run.component()).find((leaf) => leaf.text === " 9 ")!;
    expect(pill.on_hover?.command).toBe(HOVER_COMMAND);
    expect(pill.on_click).toEqual({
      command: "bitty-terminal.bar:workspace-action",
      args: { id: 9 },
      region: { id: "workspace.9", kind: "item" },
    });
    expect(pill.on_scroll?.region).toEqual({
      id: "workspace.9",
      kind: "item",
    });
    expect(
      run.host.dispatchCommand("bitty-terminal.bar:workspace-action", {
        id: 9,
        button: "left",
        region: "workspace.9",
      }),
    ).toBe(true);
    expect(run.host.drainWorkspaceRequests()).toEqual([
      { kind: "focus_id", id: 9 },
    ]);
  });

  test("a control-bearing module keeps click and wheel beside hover", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["pulseaudio"],
        modules_center: [],
        modules_right: [],
      },
      audioState: { volume_pct: 50, muted: false, port: "p" },
      audioControl: true,
    });
    const leaf = leaves(run.component())[0]!;
    expect(leaf.on_hover?.region).toEqual({
      id: "bar:module:pulseaudio",
      kind: "module",
    });
    expect(leaf.on_click).toEqual({
      command: "bitty-terminal.bar:audio-toggle",
      args: {},
      region: { id: "pulseaudio", kind: "module" },
    });
    expect(leaf.on_scroll).toEqual({
      command: "bitty-terminal.bar:audio-step",
      args: {},
      region: { id: "pulseaudio", kind: "module" },
    });
  });
});

describe("edge mounts and capability fail-closed", () => {
  test.each(["top", "bottom"] as const)(
    "%s mounts the band and the overlay tooltip",
    async (edge) => {
      const run = await bar({
        workspaces: THREE,
        settings: { edge, modules_center: [], modules_right: [] },
      });
      expect(run.mounts.map((mount) => mount.slot)).toEqual([edge, "overlay"]);
      const region = leaves(run.component())[0]!.on_hover!.region!.id;
      run.host.dispatchCommand(HOVER_COMMAND, { region, phase: "enter" });
      expect(run.overlayText()).toBe("Workspaces: 1, 4*, 9");
    },
  );

  test("without ui.overlay the band renders and hover fails closed", async () => {
    const grants = BAR_CAPABILITIES.filter(
      (capability) => capability !== "ui.overlay",
    );
    const run = await bar({
      workspaces: THREE,
      settings: { modules_center: [], modules_right: [] },
      grants,
    });
    expect(run.mounts.map((mount) => mount.slot)).toEqual(["bottom"]);
    expect(run.overlay()).toBeUndefined();
    const region = leaves(run.component())[0]!.on_hover!.region!.id;
    expect(
      run.host.dispatchCommand(HOVER_COMMAND, { region, phase: "enter" }),
    ).toBe(false);
    expect(run.host.notifications).toEqual([]);
  });

  test("a hidden module exposes no hover region", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["cpu", "workspaces"],
        modules_center: [],
        modules_right: [],
      },
    });
    const ids = regionIds(run);
    expect(ids).not.toContain("bar:module:cpu");
    expect(new Set(ids)).toEqual(new Set(["bar:module:workspaces"]));
  });
});
