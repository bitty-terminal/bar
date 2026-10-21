/**
 * Workspace bar behavior against the SDK mock host, with parity checks
 * against the retired Core workspaceline (ADR-0014).
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  HostError,
  lintManifestSource,
  type WorkspaceInfo,
} from "bitty-plugin-sdk";

import * as core from "./core-workspaceline.js";
import { LuaFactory } from "wasmoon";

import {
  activateBar,
  type BarRun,
  ENTRY_SOURCE,
  FOCUS_COMMAND,
  leafAt,
  leaves,
  MANIFEST_SOURCE,
  textOf,
  ws,
} from "./harness.js";

const runs: BarRun[] = [];

/**
 * These tests pin a workspace-only plan (`modules_center: []`,
 * `modules_right: []`) so the
 * capsule and Core-parity assertions stay focused on the workspace bar. The
 * shipped default plan (workspaces left, clock center) is covered in
 * modules.test.ts.
 */
const WORKSPACE_ONLY = { modules_center: [], modules_right: [] } as const;

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

function coreState(
  rows: readonly WorkspaceInfo[],
  visible = true,
): core.CoreState {
  return {
    workspaces: rows.map((row) => ({ name: row.name, seq: row.id })),
    active: Math.max(
      0,
      rows.findIndex((row) => row.active),
    ),
    visible,
  };
}

/** Painted text, or undefined when the band paints nothing. */
function painted(run: BarRun): string | undefined {
  const text = textOf(run.component());
  return text === "" ? undefined : text;
}

const THREE = [ws(1, "ws1"), ws(4, "code", true), ws(9, "logs")];

describe("manifest", () => {
  test("passes the authoritative SDK linter with no diagnostics", () => {
    const result = lintManifestSource(MANIFEST_SOURCE);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("rendering parity with the Core workspaceline", () => {
  const cases: Record<string, WorkspaceInfo[]> = {
    empty: [],
    two: [ws(1, "ws1", true), ws(2, "ws2")],
    three: THREE,
    "sparse ids": [ws(3, "a"), ws(7, "b"), ws(12, "c", true)],
    "unicode names": [ws(1, "日本語", true), ws(2, "café"), ws(3, "🚀 deploy")],
    "long names": [ws(1, "x".repeat(40), true), ws(2, "é".repeat(33))],
    "sixteen workspaces": Array.from({ length: 16 }, (_, i) =>
      ws(i + 1, `workspace-${i + 1}`, i === 5),
    ),
    "byte bound": Array.from({ length: 16 }, (_, i) =>
      ws(i + 1, "界".repeat(32), i === 15),
    ),
  };

  for (const [name, rows] of Object.entries(cases)) {
    test(`${name}: capsule output is bounded and stable`, async () => {
      const run = await bar({ workspaces: rows });
      const text = painted(run) ?? "";
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
        core.WORKSPACELINE_MAX_CHARS,
      );
      expect(text).toBe(painted(run));
    });

    test(`${name}: every capsule carries a workspace-action region`, async () => {
      const run = await bar({ workspaces: rows });
      for (const leaf of leaves(run.component())) {
        const capsule = /^ (\d+)[*+!]* $/.exec(leaf.text ?? "");
        if (capsule !== null) {
          const row = rows.find(
            (candidate) => candidate.id === Number(capsule[1]),
          );
          expect(leaf.on_click?.command).toBe(
            "bitty-terminal.bar:workspace-action",
          );
          expect(leaf.on_click?.args).toEqual({ id: row?.id });
          expect(leaf.on_click?.region).toEqual({
            id: `workspace.${row?.id}`,
            kind: "item",
          });
          expect(leaf.on_scroll?.command).toBe(
            "bitty-terminal.bar:workspace-action",
          );
        } else {
          expect(leaf.on_click).toBeUndefined();
        }
      }
    });
  }

  test("the byte bound keeps the line within 1024 UTF-8 bytes", async () => {
    const rows = Array.from({ length: 16 }, (_, i) =>
      ws(i + 1, "界".repeat(32), i === 0),
    );
    const run = await bar({ workspaces: rows });
    const text = textOf(run.component());
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
      core.WORKSPACELINE_MAX_CHARS,
    );
    expect(text.endsWith(" ")).toBe(true);
    expect(
      leaves(run.component()).every(
        (leaf) => leaf.text === " " || /^ \S.* $/.test(leaf.text ?? ""),
      ),
    ).toBe(true);
  });

  test("active and inactive workspaces render as distinct capsules", async () => {
    const run = await bar({ workspaces: THREE });
    expect(leaves(run.component()).map((leaf) => leaf.text)).toEqual([
      " 1 ",
      " ",
      " 4* ",
      " ",
      " 9 ",
    ]);
    expect(leaves(run.component())[2]).toEqual({
      kind: "Text",
      text: " 4* ",
      fg: "background",
      bg: "accent",
      bold: true,
      on_click: {
        command: "bitty-terminal.bar:workspace-action",
        args: { id: 4 },
        region: { id: "workspace.4", kind: "item" },
      },
      on_scroll: {
        command: "bitty-terminal.bar:workspace-action",
        args: {},
        region: { id: "workspace.4", kind: "item" },
      },
    });
    expect(leaves(run.component())[0]?.bg).toBe("selection");
    expect(leaves(run.component())[0]?.fg).toBeUndefined();
  });

  test("occupied and attention states are restrained capsule markers", async () => {
    const rows = [
      ws(1, "idle"),
      ws(4, "busy", true, 2),
      ws(9, "urgent", false, 0, { bell: true, activity: false, exited: false }),
    ];
    const run = await bar({ workspaces: rows });
    expect(leaves(run.component()).map((leaf) => leaf.text)).toEqual([
      " 1 ",
      " ",
      " 4*+ ",
      " ",
      " 9! ",
    ]);
    expect(leaves(run.component())[2]?.bold).toBe(true);
    expect(leaves(run.component())[4]?.fg).toBe("cursor");
  });

  test("capsules use stable numeric id order independent of input order", async () => {
    const run = await bar({
      workspaces: [ws(9, "logs"), ws(1, "shell"), ws(4, "code", true)],
    });
    expect(leaves(run.component()).map((leaf) => leaf.text)).toEqual([
      " 1 ",
      " ",
      " 4* ",
      " ",
      " 9 ",
    ]);
  });
});

describe("workspace label modes", () => {
  const TWO = [ws(1, "ws1"), ws(2, "ws2", true)];

  test("the default renders the stable seq only, without a count suffix", async () => {
    const run = await bar({ workspaces: TWO });
    expect(painted(run)).toBe(" 1   2* ");
    expect(painted(run)).not.toContain("(");
  });

  test("name renders the truncated workspace name", async () => {
    const run = await bar({ workspaces: TWO, settings: { label: "name" } });
    expect(painted(run)).toBe(" ws1   ws2* ");
  });

  test("both restores the id:name pair", async () => {
    const run = await bar({ workspaces: TWO, settings: { label: "both" } });
    expect(painted(run)).toBe(" 1:ws1   2:ws2* ");
  });

  test("an empty name falls back to the seq, never a blank capsule", async () => {
    const run = await bar({
      workspaces: [ws(3, "", true)],
      settings: { label: "name", show_single: true },
    });
    expect(painted(run)).toBe(" 3* ");
  });

  test("the active marker and accent styling are mode-independent", async () => {
    for (const label of ["index", "name", "both"]) {
      const run = await bar({ workspaces: TWO, settings: { label } });
      const active = leaves(run.component()).filter(
        (leaf) => leaf.bold === true,
      );
      expect(active.length).toBe(1);
      expect(active[0]?.text?.endsWith("* ")).toBe(true);
      expect(active[0]?.fg).toBe("background");
      expect(active[0]?.bg).toBe("accent");
    }
  });

  test("click targets stay unchanged in every mode", async () => {
    for (const label of ["index", "name", "both"]) {
      const run = await bar({ workspaces: TWO, settings: { label } });
      const inactive = leaves(run.component()).find(
        (leaf) => leaf.on_click?.args?.id === 1,
      )!;
      expect(inactive).toBeDefined();
      const active = leaves(run.component()).find(
        (leaf) => leaf.text?.endsWith("* ") === true,
      )!;
      expect(active.on_click?.command).toBe(
        "bitty-terminal.bar:workspace-action",
      );
      expect(active.on_click?.args).toEqual({ id: 2 });
      expect(
        leaves(run.component())
          .filter((leaf) => leaf.text === " ")
          .every((leaf) => leaf.on_click === undefined),
      ).toBe(true);
    }
  });

  test("an unknown value falls back to index with one bounded diagnostic", async () => {
    const run = await bar({ workspaces: TWO, settings: { label: "short" } });
    expect(painted(run)).toBe(" 1   2* ");
    expect(run.host.notifications).toEqual([
      {
        title: "Unified Bar",
        body: "Unified Bar: unknown label 'short'; using 'index'.",
      },
    ]);
  });

  test("the diagnostic echoes at most 32 characters of the rejected value", async () => {
    const run = await bar({
      workspaces: TWO,
      settings: { label: "x".repeat(80) },
    });
    expect(painted(run)).toBe(" 1   2* ");
    expect(run.host.notifications).toEqual([
      {
        title: "Unified Bar",
        body: `Unified Bar: unknown label '${"x".repeat(32)}'; using 'index'.`,
      },
    ]);
  });

  test("a non-string value is rejected by read_settings itself", async () => {
    // A strict host fails a wrong-typed declared setting to its default before
    // Lua sees it, so the defensive branch is proven on the pure function.
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      const mod = (await lua.doString(ENTRY_SOURCE)) as {
        read_settings(get: (key: string) => unknown): {
          label: string;
          label_diagnostic?: string;
        };
      };
      const opts = mod.read_settings((key) =>
        key === "label" ? 7 : undefined,
      );
      expect(opts.label).toBe("index");
      expect(opts.label_diagnostic).toBe(
        "Unified Bar: unknown label number; using 'index'.",
      );
    } finally {
      lua.global.close();
    }
  });

  test("without platform.notify the fallback still paints (no report)", async () => {
    const run = await bar({
      workspaces: TWO,
      settings: { label: "short" },
      grants: ["ui.rich", "workspace.read", "workspace.control"],
    });
    expect(painted(run)).toBe(" 1   2* ");
    expect(run.host.notifications).toEqual([]);
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("the empty list and the byte bound are unchanged", async () => {
    const empty = await bar({ workspaces: [] });
    expect(painted(empty)).toBe("\u2014");

    const rows = Array.from({ length: 16 }, (_, i) =>
      ws(i + 1, "界".repeat(32), i === 15),
    );
    const run = await bar({ workspaces: rows });
    const text = textOf(run.component());
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
      core.WORKSPACELINE_MAX_CHARS,
    );
    expect(text).toBe(
      " 1   2   3   4   5   6   7   8   9   10   11   12   13   14   15   16* ",
    );
  });
});

describe("visibility", () => {
  test("a lone workspace hides the bar by default (Core CTX-0838)", async () => {
    const rows = [ws(1, "ws1", true)];
    const run = await bar({ workspaces: rows });
    expect(painted(run)).toBeUndefined();
    expect(core.statusBarText(coreState(rows))).toBeUndefined();
  });

  test("show_single opts into the lone-workspace bar", async () => {
    const run = await bar({
      workspaces: [ws(1, "ws1", true)],
      settings: { show_single: true },
    });
    expect(painted(run)).toBe(" 1* ");
  });

  test("show = false hides the bar like workspace.show_bar = false", async () => {
    const run = await bar({ workspaces: THREE, settings: { show: false } });
    expect(painted(run)).toBeUndefined();
    expect(core.statusBarText(coreState(THREE, false))).toBeUndefined();
  });

  test("invalid settings fall back to defaults", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        show: "no",
        edge: "left",
        show_single: 1,
        name_max_chars: 0,
        label: "id",
      },
    });
    expect(run.mounts.map((mount) => mount.slot)).toEqual(["bottom"]);
    expect(painted(run)).toBe(" 1   4*   9 ");
    expect(run.host.notifications).toEqual([
      {
        title: "Unified Bar",
        body: "Unified Bar: unknown label 'id'; using 'index'.",
      },
    ]);
  });

  test("name_max_chars shortens labels in name and both modes", async () => {
    const byName = await bar({
      workspaces: THREE,
      settings: { label: "name", name_max_chars: 2 },
    });
    expect(painted(byName)).toBe(" ws   co*   lo ");

    const byBoth = await bar({
      workspaces: THREE,
      settings: { label: "both", name_max_chars: 2 },
    });
    expect(painted(byBoth)).toBe(" 1:ws   4:co*   9:lo ");

    const byIndex = await bar({
      workspaces: THREE,
      settings: { name_max_chars: 2 },
    });
    expect(painted(byIndex)).toBe(" 1   4*   9 ");
  });
});

describe("edge", () => {
  test("defaults to the bottom band (workspace.bar.edge default)", async () => {
    const run = await bar({ workspaces: THREE });
    expect(run.mounts.map((mount) => mount.slot)).toEqual(["bottom"]);
  });

  test("edge = top mounts the top band", async () => {
    const run = await bar({ workspaces: THREE, settings: { edge: "top" } });
    expect(run.mounts.map((mount) => mount.slot)).toEqual(["top"]);
  });
});

describe("live updates", () => {
  test("workspace events re-render from bitty.workspace.list", async () => {
    const run = await bar({ workspaces: [ws(1, "ws1", true)] });
    expect(painted(run)).toBeUndefined();

    run.host.setWorkspaces([ws(1, "ws1"), ws(2, "ws2", true)]);
    run.host.publish("workspace.created", { id: 2, name: "ws2" });
    expect(painted(run)).toBe(" 1   2* ");

    run.host.setWorkspaces([ws(1, "build", true), ws(2, "ws2")]);
    run.host.publish("workspace.renamed", { id: 1, name: "build" });
    expect(painted(run)).toBe(" 1*   2 ");

    run.host.setWorkspaces([ws(1, "build"), ws(2, "ws2", true)]);
    run.host.publish("workspace.focused", { id: 2 });
    expect(painted(run)).toBe(" 1   2* ");

    run.host.setWorkspaces([ws(2, "ws2", true)]);
    run.host.publish("workspace.closed", { id: 1 });
    expect(painted(run)).toBeUndefined();
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("closing workspaces keeps stable-seq labels (W-104 R1 live proof)", async () => {
    const run = await bar({
      workspaces: [ws(1, "ws1"), ws(2, "ws2"), ws(3, "ws3", true)],
    });
    expect(painted(run)).toBe(" 1   2   3* ");

    // Live proof: closing #1 leaves the survivors at their stable seq
    // (` 2   3* `); a position-based plugin would paint ` 1   2* ` instead.
    run.host.setWorkspaces([ws(2, "ws2"), ws(3, "ws3", true)]);
    run.host.publish("workspace.closed", { id: 1 });
    expect(painted(run)).toBe(" 2   3* ");

    // Closing the middle never renumbers the tail either.
    run.host.setWorkspaces([ws(1, "ws1"), ws(2, "ws2"), ws(3, "ws3", true)]);
    run.host.publish("workspace.created", { id: 1, name: "ws1" });
    run.host.setWorkspaces([ws(1, "ws1"), ws(3, "ws3", true)]);
    run.host.publish("workspace.closed", { id: 2 });
    expect(painted(run)).toBe(" 1   3* ");
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("config.reloaded applies show, label, and name_max_chars live", async () => {
    const run = await bar({ workspaces: THREE });
    expect(painted(run)).toBe(" 1   4*   9 ");
    run.host.bitty.settings.set("show", false);
    run.host.publish("config.reloaded", {});
    expect(painted(run)).toBeUndefined();

    run.host.bitty.settings.set("show", true);
    run.host.bitty.settings.set("label", "both");
    run.host.bitty.settings.set("name_max_chars", 1);
    run.host.publish("config.reloaded", {});
    expect(painted(run)).toBe(" 1:w   4:c*   9:l ");

    run.host.bitty.settings.set("label", "name");
    run.host.publish("config.reloaded", {});
    expect(painted(run)).toBe(" w   c*   l ");
  });

  test("an edge change waits for the next generation (mounts are activation-only)", async () => {
    const run = await bar({ workspaces: THREE });
    run.host.bitty.settings.set("edge", "top");
    run.host.publish("config.reloaded", {});
    expect(run.mounts.map((mount) => mount.slot)).toEqual(["bottom"]);
    expect(painted(run)).toBe(" 1   4*   9 ");
    expect(run.host.handlerViolations).toEqual([]);
  });
});

describe("click to focus", () => {
  test("clicking an inactive pill queues focus by stable id", async () => {
    const run = await bar({ workspaces: THREE });
    const pill = leaves(run.component()).find((leaf) => leaf.text === " 9 ")!;
    const { command, args } = pill.on_click!;
    expect(run.host.dispatchCommand(command, args)).toBe(true);
    expect(run.host.drainWorkspaceRequests()).toEqual([
      { kind: "focus_id", id: 9 },
    ]);
  });

  test("the active workspace and unknown ids queue nothing", async () => {
    const run = await bar({ workspaces: THREE });
    expect(run.host.dispatchCommand(FOCUS_COMMAND, { id: 4 })).toBe(false);
    expect(run.host.dispatchCommand(FOCUS_COMMAND, { id: 42 })).toBe(false);
    expect(run.host.dispatchCommand(FOCUS_COMMAND, { id: 1.5 })).toBe(false);
    expect(run.host.drainWorkspaceRequests()).toEqual([]);
  });

  test("a click that went stale after a close queues nothing", async () => {
    const run = await bar({ workspaces: THREE });
    run.host.setWorkspaces([ws(1, "ws1"), ws(4, "code", true)]);
    expect(run.host.dispatchCommand(FOCUS_COMMAND, { id: 9 })).toBe(false);
    expect(run.host.drainWorkspaceRequests()).toEqual([]);
  });

  test("malformed click arguments are rejected by the host schema", () => {
    return bar({ workspaces: THREE }).then((run) => {
      expect(() => run.host.dispatchCommand(FOCUS_COMMAND, {})).toThrow(
        HostError,
      );
      expect(() => run.host.dispatchCommand(FOCUS_COMMAND, { id: 0 })).toThrow(
        HostError,
      );
      expect(() =>
        run.host.dispatchCommand(FOCUS_COMMAND, { id: 2, x: 1 }),
      ).toThrow(HostError);
    });
  });
});

describe("capability gates", () => {
  for (const missing of ["ui.rich", "workspace.read"]) {
    test(`activation fails closed without ${missing}`, async () => {
      const grants = ["ui.rich", "workspace.read", "workspace.control"].filter(
        (capability) => capability !== missing,
      );
      await expect(activateBar({ workspaces: THREE, grants })).rejects.toThrow(
        /E_CAPABILITY_DENIED/,
      );
    });
  }

  test("without workspace.control the bar renders but clicks are denied", async () => {
    const run = await bar({
      workspaces: THREE,
      grants: ["ui.rich", "workspace.read"],
    });
    expect(painted(run)).toBe(" 1   4*   9 ");
    expect(() => run.host.dispatchCommand(FOCUS_COMMAND, { id: 1 })).toThrow(
      HostError,
    );
    expect(run.host.drainWorkspaceRequests()).toEqual([]);
  });
});

describe("scratchpad indicator (W-104 R2-consumer, DEC-W104-1)", () => {
  const EMPTY = { count: 0, occupied: false };
  const OCCUPIED = { count: 1, occupied: true };
  const occupiedRows = (rows: readonly WorkspaceInfo[]): WorkspaceInfo[] =>
    rows.map((row) => ws(row.id, row.name, row.active, OCCUPIED));

  test("an empty slot renders no indicator (Core parity preserved)", async () => {
    const rows = THREE.map((row) => ws(row.id, row.name, row.active, EMPTY));
    const run = await bar({ workspaces: rows });
    expect(painted(run)).toBe(" 1   4*   9 ");
    expect(painted(run)).toBe(" 1   4*   9 ");
    expect(textOf(run.component())).not.toContain("scratchpad");
  });

  test("rows from a host without the surface render no indicator", async () => {
    const run = await bar({ workspaces: THREE });
    expect(painted(run)).toBe(" 1   4*   9 ");
    expect(textOf(run.component())).not.toContain("scratchpad");
  });

  test("an occupied slot appends the indicator after the Core text", async () => {
    const rows = occupiedRows(THREE);
    const run = await bar({ workspaces: rows });
    expect(painted(run)).toBe(" 1   4*   9  [scratchpad]");
    expect(painted(run)).toBe(" 1   4*   9  [scratchpad]");
    const active = leaves(run.component()).filter((leaf) => leaf.bold === true);
    expect(active).toEqual([
      {
        kind: "Text",
        text: " 4* ",
        bold: true,
        fg: "background",
        bg: "accent",
        on_click: {
          command: "bitty-terminal.bar:workspace-action",
          args: { id: 4 },
          region: { id: "workspace.4", kind: "item" },
        },
        on_scroll: {
          command: "bitty-terminal.bar:workspace-action",
          args: {},
          region: { id: "workspace.4", kind: "item" },
        },
      },
    ]);
  });

  test("indicator columns queue nothing (no panel capability involved)", async () => {
    const rows = occupiedRows(THREE);
    const run = await bar({ workspaces: rows });
    const text = textOf(run.component());
    const start = text.indexOf(" [scratchpad]");
    expect(start).toBeGreaterThanOrEqual(0);
    for (
      let column = start;
      column < start + " [scratchpad]".length;
      column += 1
    ) {
      expect(leafAt(run.component(), column)?.on_click).toBeUndefined();
    }
    expect(run.host.drainWorkspaceRequests()).toEqual([]);
  });

  test("a count above the single-slot ceiling renders defensively", async () => {
    const rows = THREE.map((row) =>
      ws(row.id, row.name, row.active, { count: 2, occupied: true }),
    );
    const run = await bar({ workspaces: rows });
    expect(painted(run)).toBe(" 1   4*   9  [scratchpad:2]");
  });

  test("invalid scratchpad fields read as empty (fail closed)", async () => {
    const rows = THREE.map(
      (row) =>
        ws(row.id, row.name, row.active, {
          count: "many",
          occupied: "yes",
        }) as WorkspaceInfo,
    );
    const run = await bar({ workspaces: rows });
    expect(painted(run)).toBe(" 1   4*   9 ");
    expect(textOf(run.component())).not.toContain("scratchpad");
  });

  test("workspace.changed flips the indicator live (put and take)", async () => {
    const run = await bar({ workspaces: THREE });
    expect(textOf(run.component())).not.toContain("scratchpad");

    run.host.setWorkspaces(occupiedRows(THREE));
    run.host.publish("workspace.changed", { id: 4 });
    expect(painted(run)).toBe(" 1   4*   9  [scratchpad]");

    run.host.setWorkspaces(THREE);
    run.host.publish("workspace.changed", { id: 4 });
    expect(painted(run)).toBe(" 1   4*   9 ");
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("a lone workspace with an occupied slot shows the bar", async () => {
    const rows = [ws(1, "ws1", true, OCCUPIED)];
    const run = await bar({ workspaces: rows });
    expect(painted(run)).toBe(" 1*  [scratchpad]");
  });

  test("occupancy needs no grant beyond workspace.read", async () => {
    const rows = occupiedRows(THREE);
    const run = await bar({
      workspaces: rows,
      grants: ["ui.rich", "workspace.read"],
    });
    expect(painted(run)).toBe(" 1   4*   9  [scratchpad]");
    expect(() => run.host.dispatchCommand(FOCUS_COMMAND, { id: 1 })).toThrow(
      HostError,
    );
  });

  test("the manifest requests no panel capability", () => {
    expect(MANIFEST_SOURCE).not.toMatch(/panel/);
  });
});

describe("headless activation regression (bar#6)", () => {
  test("two-row ASCII stub mounts (issue repro: main/alt)", async () => {
    const run = await bar({
      workspaces: [ws(1, "main", true), ws(2, "alt")],
    });
    expect(painted(run)).toBe(" 1*   2 ");
  });

  test("truncate_chars counts portably without pattern bytes", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      const mod = (await lua.doString(ENTRY_SOURCE)) as {
        truncate_chars(text: string, max: number): string;
      };
      expect(mod.truncate_chars("hello", 32)).toBe("hello");
      expect(mod.truncate_chars("hello", 2)).toBe("he");
      expect(mod.truncate_chars("日本語", 2)).toBe("日本");
      expect(mod.truncate_chars("🚀 deploy", 1)).toBe("🚀");
      expect(mod.truncate_chars("", 32)).toBe("");
      expect(mod.truncate_chars("hello", 0)).toBe("");
    } finally {
      lua.global.close();
    }
  });

  test("runtime code uses no phodopus-rejected pattern bytes", () => {
    const code = ENTRY_SOURCE.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/gmatch.*\\128/);
    expect(code).not.toMatch(/\[\^\\128/);
  });

  test("runtime code uses no phodopus-rejected gsub-with-function", () => {
    // Phodopus admits string/table gsub replacements and rejects function
    // replacements (`function replacement currently unsupported in gsub`).
    // Scan every gsub call with balanced parens; none may carry a function.
    const code = ENTRY_SOURCE.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const calls: string[] = [];
    let from = 0;
    for (;;) {
      const start = code.indexOf("gsub(", from);
      if (start === -1) break;
      let depth = 0;
      let i = start + "gsub".length;
      for (; i < code.length; i += 1) {
        const ch = code[i];
        if (ch === "(") {
          depth += 1;
        } else if (ch === ")") {
          depth -= 1;
          if (depth === 0) break;
        } else if (ch === '"' || ch === "'") {
          const quote = ch;
          i += 1;
          while (i < code.length && code[i] !== quote) {
            if (code[i] === "\\") i += 1;
            i += 1;
          }
        }
      }
      calls.push(code.slice(start, i + 1));
      from = i + 1;
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toMatch(/\bfunction\b/);
    }
  });
});

describe("template renderer (bar#15)", () => {
  interface TemplateMod {
    render_template(format: unknown, data: unknown, max?: number): string;
    CPU_DEFAULT_FORMAT: string;
    MEMORY_DEFAULT_FORMAT: string;
    BATTERY_DEFAULT_FORMAT: string;
  }

  test("renders the production template defaults", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      const mod = (await lua.doString(ENTRY_SOURCE)) as TemplateMod;
      expect(mod.render_template(mod.CPU_DEFAULT_FORMAT, { total: "12" })).toBe(
        "12%",
      );
      expect(
        mod.render_template(mod.MEMORY_DEFAULT_FORMAT, { pct: "42" }),
      ).toBe("42%");
      expect(
        mod.render_template(mod.BATTERY_DEFAULT_FORMAT, {
          icon: "H",
          capacity: "87",
        }),
      ).toBe("H 87%");
    } finally {
      lua.global.close();
    }
  });

  test("missing keys stay literal, values splice without %-escapes", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      const mod = (await lua.doString(ENTRY_SOURCE)) as TemplateMod;
      expect(mod.render_template("{a} {b}", { b: "B" })).toBe("{a} B");
      expect(mod.render_template("{a}{b}", { a: "x", b: "y" })).toBe("xy");
      expect(mod.render_template("{{x}}", { x: "1" })).toBe("{1}");
      expect(mod.render_template("{v}", { v: "100% done" })).toBe("100% done");
      expect(mod.render_template("{v}", { v: "%1 %0 %%" })).toBe("%1 %0 %%");
      expect(mod.render_template("{v}", { v: "{lit}" })).toBe("{lit}");
      expect(mod.render_template("hello", {})).toBe("hello");
      expect(mod.render_template("", { a: "x" })).toBe("");
    } finally {
      lua.global.close();
    }
  });

  test("rejects bad shapes and honors the byte cap", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      const mod = (await lua.doString(ENTRY_SOURCE)) as TemplateMod;
      expect(mod.render_template(undefined, { a: "x" })).toBe("");
      expect(mod.render_template(42, { a: "x" })).toBe("");
      expect(mod.render_template("{a}", undefined)).toBe("{a}");
      expect(mod.render_template("{total}%", { total: "12" }, 4)).toBe("{tot");
      expect(mod.render_template("{v}", { v: "日本語" }, 6)).toBe("日本");
    } finally {
      lua.global.close();
    }
  });
});
