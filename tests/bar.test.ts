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
import {
  activateBar,
  type BarRun,
  FOCUS_COMMAND,
  leafAt,
  leaves,
  MANIFEST_SOURCE,
  textOf,
  ws,
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
    test(`${name}: painted text equals Core status_bar_text`, async () => {
      const run = await bar({ workspaces: rows });
      expect(painted(run)).toBe(core.statusBarText(coreState(rows)));
    });

    test(`${name}: every column clicks like Core workspaceline_click`, async () => {
      const run = await bar({ workspaces: rows });
      const state = coreState(rows);
      const text = textOf(run.component());
      for (let column = 0; column < [...text].length; column += 1) {
        const leaf = leafAt(run.component(), column);
        const expected = core.click(state, column);
        if (expected === undefined) {
          expect(leaf?.on_click).toBeUndefined();
        } else {
          expect(leaf?.on_click).toEqual({
            command: FOCUS_COMMAND,
            args: { id: rows[expected]!.id },
          });
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
    expect(text).toBe(core.workspacelineText(coreState(rows)));
  });

  test("the active pill is highlighted and marked", async () => {
    const run = await bar({ workspaces: THREE });
    const active = leaves(run.component()).filter((leaf) => leaf.bold === true);
    expect(active).toEqual([
      { kind: "Text", text: "4:code*", bold: true, fg: "accent" },
    ]);
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
    expect(painted(run)).toBe("1:ws1* (1)");
  });

  test("show = false hides the bar like workspace.show_bar = false", async () => {
    const run = await bar({ workspaces: THREE, settings: { show: false } });
    expect(painted(run)).toBeUndefined();
    expect(core.statusBarText(coreState(THREE, false))).toBeUndefined();
  });

  test("invalid settings fall back to defaults", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { show: "no", edge: "left", show_single: 1, name_max_chars: 0 },
    });
    expect(run.mounts.map((mount) => mount.slot)).toEqual(["bottom"]);
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
  });

  test("name_max_chars shortens pill labels", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { name_max_chars: 2 },
    });
    expect(painted(run)).toBe("1:ws 4:co* 9:lo (3)");
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
    expect(painted(run)).toBe("1:ws1 2:ws2* (2)");

    run.host.setWorkspaces([ws(1, "build", true), ws(2, "ws2")]);
    run.host.publish("workspace.renamed", { id: 1, name: "build" });
    expect(painted(run)).toBe("1:build* 2:ws2 (2)");

    run.host.setWorkspaces([ws(1, "build"), ws(2, "ws2", true)]);
    run.host.publish("workspace.focused", { id: 2 });
    expect(painted(run)).toBe("1:build 2:ws2* (2)");

    run.host.setWorkspaces([ws(2, "ws2", true)]);
    run.host.publish("workspace.closed", { id: 1 });
    expect(painted(run)).toBeUndefined();
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("closing workspaces keeps stable-seq labels (W-104 R1 live proof)", async () => {
    const run = await bar({
      workspaces: [ws(1, "ws1"), ws(2, "ws2"), ws(3, "ws3", true)],
    });
    expect(painted(run)).toBe("1:ws1 2:ws2 3:ws3* (3)");

    // Live proof: closing #1 leaves Core painting `2:ws2 3:ws3*`; the
    // position-based plugin painted `1:ws2 2:ws3*` instead.
    run.host.setWorkspaces([ws(2, "ws2"), ws(3, "ws3", true)]);
    run.host.publish("workspace.closed", { id: 1 });
    const afterFirstClose = [ws(2, "ws2"), ws(3, "ws3", true)];
    expect(painted(run)).toBe("2:ws2 3:ws3* (2)");
    expect(painted(run)).toBe(core.statusBarText(coreState(afterFirstClose)));

    // Closing the middle never renumbers the tail either.
    run.host.setWorkspaces([ws(1, "ws1"), ws(2, "ws2"), ws(3, "ws3", true)]);
    run.host.publish("workspace.created", { id: 1, name: "ws1" });
    run.host.setWorkspaces([ws(1, "ws1"), ws(3, "ws3", true)]);
    run.host.publish("workspace.closed", { id: 2 });
    const afterMiddleClose = [ws(1, "ws1"), ws(3, "ws3", true)];
    expect(painted(run)).toBe("1:ws1 3:ws3* (2)");
    expect(painted(run)).toBe(core.statusBarText(coreState(afterMiddleClose)));
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("config.reloaded applies show and label settings live", async () => {
    const run = await bar({ workspaces: THREE });
    run.host.bitty.settings.set("show", false);
    run.host.publish("config.reloaded", {});
    expect(painted(run)).toBeUndefined();

    run.host.bitty.settings.set("show", true);
    run.host.bitty.settings.set("name_max_chars", 1);
    run.host.publish("config.reloaded", {});
    expect(painted(run)).toBe("1:w 4:c* 9:l (3)");
  });

  test("an edge change waits for the next generation (mounts are activation-only)", async () => {
    const run = await bar({ workspaces: THREE });
    run.host.bitty.settings.set("edge", "top");
    run.host.publish("config.reloaded", {});
    expect(run.mounts.map((mount) => mount.slot)).toEqual(["bottom"]);
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
    expect(run.host.handlerViolations).toEqual([]);
  });
});

describe("click to focus", () => {
  test("clicking an inactive pill queues focus by stable id", async () => {
    const run = await bar({ workspaces: THREE });
    const pill = leaves(run.component()).find(
      (leaf) => leaf.text === "9:logs",
    )!;
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
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
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
    expect(painted(run)).toBe(core.statusBarText(coreState(rows)));
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
    expect(textOf(run.component())).not.toContain("scratchpad");
  });

  test("rows from a host without the surface render no indicator", async () => {
    const run = await bar({ workspaces: THREE });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
    expect(textOf(run.component())).not.toContain("scratchpad");
  });

  test("an occupied slot appends the indicator after the Core text", async () => {
    const rows = occupiedRows(THREE);
    const run = await bar({ workspaces: rows });
    expect(painted(run)).toBe(
      `${core.statusBarText(coreState(rows))} [scratchpad]`,
    );
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3) [scratchpad]");
    const active = leaves(run.component()).filter((leaf) => leaf.bold === true);
    expect(active).toEqual([
      { kind: "Text", text: "4:code*", bold: true, fg: "accent" },
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
    expect(painted(run)).toBe(
      `${core.statusBarText(coreState(rows))} [scratchpad:2]`,
    );
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
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
    expect(textOf(run.component())).not.toContain("scratchpad");
  });

  test("workspace.changed flips the indicator live (put and take)", async () => {
    const run = await bar({ workspaces: THREE });
    expect(textOf(run.component())).not.toContain("scratchpad");

    run.host.setWorkspaces(occupiedRows(THREE));
    run.host.publish("workspace.changed", { id: 4 });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3) [scratchpad]");

    run.host.setWorkspaces(THREE);
    run.host.publish("workspace.changed", { id: 4 });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3)");
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("a lone workspace with an occupied slot shows the bar", async () => {
    const rows = [ws(1, "ws1", true, OCCUPIED)];
    const run = await bar({ workspaces: rows });
    expect(painted(run)).toBe("1:ws1* (1) [scratchpad]");
  });

  test("occupancy needs no grant beyond workspace.read", async () => {
    const rows = occupiedRows(THREE);
    const run = await bar({
      workspaces: rows,
      grants: ["ui.rich", "workspace.read"],
    });
    expect(painted(run)).toBe("1:ws1 4:code* 9:logs (3) [scratchpad]");
    expect(() => run.host.dispatchCommand(FOCUS_COMMAND, { id: 1 })).toThrow(
      HostError,
    );
  });

  test("the manifest requests no panel capability", () => {
    expect(MANIFEST_SOURCE).not.toMatch(/panel/);
  });
});
