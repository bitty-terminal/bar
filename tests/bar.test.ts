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
    workspaces: rows.map((row) => ({ name: row.name })),
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

describe("rendering", () => {
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
    test(`${name}: output is bounded and stable`, async () => {
      const run = await bar({ workspaces: rows });
      const text = painted(run) ?? "";
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
        core.WORKSPACELINE_MAX_CHARS,
      );
      expect(text).toBe(painted(run));
    });

    test(`${name}: only inactive capsules carry stable-id clicks`, async () => {
      const run = await bar({ workspaces: rows });
      for (const leaf of leaves(run.component())) {
        if (leaf.text?.startsWith("[") && leaf.text.endsWith("]")) {
          const row = rows.find((candidate) =>
            leaf.text?.startsWith(`[${candidate.id}:`),
          );
          if (row?.active) expect(leaf.on_click).toBeUndefined();
          else expect(leaf.on_click?.args).toEqual({ id: row?.id });
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
    expect(text.endsWith("]")).toBe(true);
    expect(
      leaves(run.component()).every(
        (leaf) =>
          leaf.text === " " ||
          leaf.text.startsWith("[") ||
          leaf.text.endsWith("]"),
      ),
    ).toBe(true);
    expect(
      leaves(run.component()).some(
        (leaf) => leaf.text !== " " && !leaf.text.endsWith("]"),
      ),
    ).toBe(false);
  });

  test("active and inactive workspaces render as distinct capsules", async () => {
    const run = await bar({ workspaces: THREE });
    expect(leaves(run.component()).map((leaf) => leaf.text)).toEqual([
      "[1:ws1]",
      " ",
      "[4:code*]",
      " ",
      "[9:logs]",
    ]);
    expect(leaves(run.component())[0]?.on_click?.args).toEqual({ id: 1 });
    expect(leaves(run.component())[2]).toEqual({
      kind: "Text",
      text: "[4:code*]",
      fg: "background",
      bg: "accent",
      bold: true,
    });
  });

  test("occupied and attention states are restrained capsule markers", async () => {
    const rows = [
      ws(1, "idle"),
      ws(4, "busy", true, 2),
      ws(9, "urgent", false, 0, {
        bell: true,
        activity: false,
        exited: false,
      }),
    ];
    const run = await bar({ workspaces: rows });
    expect(leaves(run.component()).map((leaf) => leaf.text)).toEqual([
      "[1:idle]",
      " ",
      "[4:busy*+]",
      " ",
      "[9:urgent!]",
    ]);
    expect(leaves(run.component())[2]?.bold).toBe(true);
    expect(leaves(run.component())[4]?.fg).toBe("cursor");
  });

  test("capsules use stable numeric id order independent of input order", async () => {
    const run = await bar({
      workspaces: [ws(9, "logs"), ws(1, "shell"), ws(4, "code", true)],
    });
    expect(leaves(run.component()).map((leaf) => leaf.text)).toEqual([
      "[1:shell]",
      " ",
      "[4:code*]",
      " ",
      "[9:logs]",
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
    expect(painted(run)).toBe("[1:ws1*]");
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
    expect(painted(run)).toBe("[1:ws1] [4:code*] [9:logs]");
  });

  test("name_max_chars shortens pill labels", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { name_max_chars: 2 },
    });
    expect(painted(run)).toBe("[1:ws] [4:co*] [9:lo]");
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

  test("edge = left/right fall back to the painted bottom band", async () => {
    for (const edge of ["left", "right"]) {
      const run = await bar({ workspaces: THREE, settings: { edge } });
      expect(run.mounts.map((mount) => mount.slot)).toEqual(["bottom"]);
    }
  });
});

describe("live updates", () => {
  test("workspace events re-render from bitty.workspace.list", async () => {
    const run = await bar({ workspaces: [ws(1, "ws1", true)] });
    expect(painted(run)).toBeUndefined();

    run.host.setWorkspaces([ws(1, "ws1"), ws(2, "ws2", true)]);
    run.host.publish("workspace.created", { id: 2, name: "ws2" });
    expect(painted(run)).toBe("[1:ws1] [2:ws2*]");

    run.host.setWorkspaces([ws(1, "build", true), ws(2, "ws2")]);
    run.host.publish("workspace.renamed", { id: 1, name: "build" });
    expect(painted(run)).toBe("[1:build*] [2:ws2]");

    run.host.setWorkspaces([ws(1, "build"), ws(2, "ws2", true)]);
    run.host.publish("workspace.focused", { id: 2 });
    expect(painted(run)).toBe("[1:build] [2:ws2*]");

    run.host.setWorkspaces([ws(2, "ws2", true)]);
    run.host.publish("workspace.closed", { id: 1 });
    expect(painted(run)).toBeUndefined();
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
    expect(painted(run)).toBe("[1:w] [4:c*] [9:l]");
  });

  test("an edge change waits for the next generation (mounts are activation-only)", async () => {
    const run = await bar({ workspaces: THREE });
    run.host.bitty.settings.set("edge", "top");
    run.host.publish("config.reloaded", {});
    expect(run.mounts.map((mount) => mount.slot)).toEqual(["bottom"]);
    expect(painted(run)).toBe("[1:ws1] [4:code*] [9:logs]");
    expect(run.host.handlerViolations).toEqual([]);
  });
});

describe("click to focus", () => {
  test("clicking an inactive pill queues focus by stable id", async () => {
    const run = await bar({ workspaces: THREE });
    const pill = leaves(run.component()).find(
      (leaf) => leaf.text === "[9:logs]",
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
    expect(painted(run)).toBe("[1:ws1] [4:code*] [9:logs]");
    expect(() => run.host.dispatchCommand(FOCUS_COMMAND, { id: 1 })).toThrow(
      HostError,
    );
    expect(run.host.drainWorkspaceRequests()).toEqual([]);
  });
});
