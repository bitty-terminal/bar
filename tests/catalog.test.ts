/**
 * bar#2114 dogfood: the bar composes its band, pill row and tooltip/detail
 * fallback against the shipped extension component catalog.
 *
 * API-level truth is bitty `crates/bitty-lua/src/ui_catalog.rs` (module
 * `ui_catalog`): five typed descriptors built only from the accepted v1 node
 * set (`Text`/`Row`/`Column`/`List`) with inclusive caps. Core exposes no
 * Lua-visible surface for it, so the bar projects the entries it composes
 * (`lua/bar/init.lua`, section "Extension component catalog recipes") and the
 * assertions below pin the contract at the only place a host sees it: the
 * composed scene plus the mirrored cap table.
 *
 * Each test names the catalog rule it pins. The four declared deltas the bar
 * cannot adopt without changing shipped output (omission of a provider-less
 * region, no inter-region pad, the padded capsule pill spelling, and the three
 * measured-not-enforced item caps) are pinned as behaviour, not asserted away.
 */

import { afterEach, describe, expect, test } from "bun:test";

import type { WorkspaceInfo } from "bitty-plugin-sdk";

import {
  activateBar,
  BAR_CAPABILITIES,
  ENTRY_SOURCE,
  HOVER_COMMAND,
  leaves,
  type BarRun,
  type SceneNode,
  textOf,
  ws,
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

/** The catalog's closed emission set (`UI_V1_NODE_KINDS`). */
const NODE_KINDS = ["Text", "Row", "Column", "List"] as const;
/** The catalog's canonical region order (`compose_strip` declaration order). */
const REGION_ORDER = ["left", "center", "right"] as const;
/** Root fields a `band` root may carry: none (no anchor, style, or binding). */
const ROOT_DECORATION = [
  "anchor",
  "align",
  "fg",
  "bg",
  "bold",
  "on_click",
  "on_scroll",
  "on_hover",
] as const;
/** Bar bounds the catalog caps are compared against. */
const BAR_BOUNDS = {
  lineBytes: 1024,
  nameChars: 32,
  detailBytes: 256,
  workspaces: 16,
} as const;

/** Byte length of a UTF-8 string (the catalog's unit for every item cap). */
function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Source slice of one top-level `--` section or assignment, up to `closer`
 * (`}` for a table literal, `\nend\n` for a function). Used to read the
 * mirrored cap table and to pin the composition sites.
 */
function sourceSlice(open: string, closer = "}"): string {
  const start = ENTRY_SOURCE.indexOf(open);
  expect(start).toBeGreaterThan(-1);
  const end = ENTRY_SOURCE.indexOf(closer, start);
  expect(end).toBeGreaterThan(start);
  return ENTRY_SOURCE.slice(start, end);
}

interface BandShape {
  readonly regions: readonly {
    readonly anchor: string;
    readonly leaves: readonly SceneNode[];
  }[];
  readonly problems: readonly string[];
}

/**
 * Strict `band` recogniser: exactly the tree `M.catalog_band_node` emits. Any
 * divergence -- a root that carries placement or style, a child that is not an
 * anchored `Row`, an out-of-order or repeated region, an empty region `Row`, a
 * non-`Text` leaf, or an inter-region separator leaf -- is reported instead of
 * being read leniently.
 */
function bandShape(node: SceneNode): BandShape {
  const problems: string[] = [];
  if (node.kind !== "Row") problems.push(`root is ${node.kind}, not Row`);
  const fields = node as unknown as Record<string, unknown>;
  for (const field of ROOT_DECORATION) {
    if (fields[field] !== undefined) problems.push(`root carries ${field}`);
  }
  const regions: { anchor: string; leaves: readonly SceneNode[] }[] = [];
  let cursor = -1;
  for (const child of node.children ?? []) {
    if (child.kind !== "Row") {
      problems.push(`region child is ${child.kind}, not Row`);
      continue;
    }
    const anchor = child.anchor;
    if (anchor === undefined) problems.push("region child carries no anchor");
    const position = REGION_ORDER.indexOf(anchor as never);
    if (position < 0) problems.push(`region anchor ${String(anchor)} unknown`);
    if (position <= cursor) {
      problems.push(`region ${String(anchor)} repeated or out of order`);
    }
    cursor = Math.max(cursor, position);
    for (const field of [
      "fg",
      "bg",
      "bold",
      "on_click",
      "on_scroll",
    ] as const) {
      if (child[field] !== undefined) {
        problems.push(`region ${String(anchor)} carries ${field}`);
      }
    }
    const regionLeaves = child.children ?? [];
    if (regionLeaves.length === 0) {
      problems.push(`region ${String(anchor)} painted as an empty Row`);
    }
    for (const leaf of regionLeaves) {
      if (leaf.kind !== "Text") {
        problems.push(`leaf under ${String(anchor)} is ${leaf.kind}`);
      }
      if ((leaf.children?.length ?? 0) > 0) {
        problems.push(`leaf under ${String(anchor)} has children`);
      }
    }
    regions.push({ anchor: String(anchor), leaves: regionLeaves });
  }
  if (regions.length === 0) problems.push("band declares no region");
  return { regions, problems };
}

interface SceneWalk {
  nodes: number;
  depth: number;
  textBytes: number;
  kinds: Set<string>;
}

/** Iterative scene walk (`check_scene_bounds`): kinds, nodes, depth, bytes. */
function walkScene(node: SceneNode): SceneWalk {
  const state: SceneWalk = {
    nodes: 0,
    depth: 0,
    textBytes: 0,
    kinds: new Set(),
  };
  const pending: { node: SceneNode; depth: number }[] = [{ node, depth: 1 }];
  while (pending.length > 0) {
    const frame = pending.pop()!;
    state.nodes += 1;
    state.depth = Math.max(state.depth, frame.depth);
    state.kinds.add(frame.node.kind);
    if (frame.node.kind === "Text") {
      state.textBytes += bytes(frame.node.text ?? "");
    }
    for (const child of frame.node.children ?? []) {
      pending.push({ node: child, depth: frame.depth + 1 });
    }
  }
  return state;
}

/** Fields of a node other than `kind`/`text`, sorted (decoration surface). */
function fieldsOf(node: SceneNode): string[] {
  return Object.keys(node)
    .filter((key) => key !== "kind" && key !== "text")
    .sort();
}

describe("the mirrored cap table is the shipped catalog's", () => {
  /**
   * One place pins every mirrored value against
   * `crates/bitty-lua/src/ui_catalog.rs`; a drift on either side fails here
   * instead of silently diverging (the duplicate-catalog mistake of PR #3189).
   */
  test("every cap equals its `ui_catalog` constant", () => {
    const block = sourceSlice("M.CATALOG_CAPS = {");
    const cap = (name: string): number => {
      const match = new RegExp(`\\b${name} = (\\d+)`).exec(block);
      expect(match).not.toBeNull();
      return Number(match![1]);
    };
    expect(cap("segments")).toBe(64); // CATALOG_MAX_SEGMENTS
    expect(cap("pills")).toBe(64); // CATALOG_MAX_PILLS
    expect(cap("rows")).toBe(64); // CATALOG_MAX_ROWS
    expect(cap("segment_bytes")).toBe(64); // CATALOG_MAX_SEGMENT_BYTES
    expect(cap("pill_label_bytes")).toBe(32); // CATALOG_MAX_PILL_LABEL_BYTES
    expect(cap("detail_bytes")).toBe(128); // CATALOG_MAX_DETAIL_BYTES
    expect(cap("text_bytes")).toBe(256 * 1024); // CATALOG_MAX_TEXT_BYTES
    expect(cap("nodes")).toBe(2048); // CATALOG_MAX_NODES
    expect(cap("depth")).toBe(16); // CATALOG_MAX_DEPTH
  });

  /** Closed entry set, canonical order, exact ids (`CatalogEntry::ALL`). */
  test("the entry set is the catalog's five ids in canonical order", () => {
    const block = sourceSlice("M.CATALOG_ENTRIES = {");
    const ids = [...block.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual([
      "band",
      "pill-row",
      "tooltip-detail-fallback",
      "modal-sheet",
      "status-strip",
    ]);
  });

  /** The projection names its source module, so the next lane extends it. */
  test("the projection names the shipped module it mirrors", () => {
    expect(ENTRY_SOURCE).toContain("crates/bitty-lua/src/ui_catalog.rs");
    expect(ENTRY_SOURCE).toContain("extend `ui_catalog`");
  });
});

describe("band recipe (bitty#2114 C-1)", () => {
  test("the root is one plain Row of anchored region Rows", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["workspaces"],
        modules_center: ["clock"],
        modules_right: [],
      },
    });
    const shape = bandShape(run.component());
    expect(shape.problems).toEqual([]);
    expect(shape.regions.map((region) => region.anchor)).toEqual([
      "left",
      "center",
    ]);
    expect(fieldsOf(run.component())).toEqual(["children"]);
  });

  /**
   * Delta D1, and the assertion the catalog's own canonical composer would
   * fail: `compose_strip` always emits three region Rows. A reverted
   * hand-rolled band that pads the missing group -- or emits it empty -- turns
   * `problems` non-empty and changes `anchors`.
   */
  test("a provider-less region is omitted, never painted empty", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["workspaces"],
        modules_center: [],
        // `cpu` has no sensor provider here, so the group hides.
        modules_right: ["cpu"],
      },
    });
    const shape = bandShape(run.component());
    expect(shape.problems).toEqual([]);
    expect(shape.regions.map((region) => region.anchor)).toEqual(["left"]);
    // No region Row exists to paint, and no edge pad is added for it (D2).
    expect(textOf(run.component())).toBe(" 1   4*   9 ");
  });

  /**
   * Delta D2: two non-empty regions are adjacent with no separator leaf
   * between them. The catalog's `compose_strip` emits a single-space region
   * separator; adopting it would shift every centered/right-flush group.
   */
  test("regions are adjacent with no inter-region separator leaf", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["workspaces"],
        modules_center: ["clock"],
        modules_right: [],
      },
      fakeNow: 1700000000,
    });
    const shape = bandShape(run.component());
    const [left, center] = shape.regions;
    // The only leaves that are a bare space sit *inside* the pill row, between
    // two capsules; the center region's first leaf is the clock text.
    expect(left!.leaves.map((leaf) => leaf.text)).toEqual([
      " 1 ",
      " ",
      " 4* ",
      " ",
      " 9 ",
    ]);
    expect(center!.leaves.map((leaf) => leaf.text)).toEqual([
      expect.stringMatching(/^\d\d:\d\d$/),
    ]);
    expect(textOf(run.component())).toBe(
      ` 1   4*   9 ${center!.leaves[0]!.text}`,
    );
  });

  /** Emitted kinds stay inside the accepted v1 set, at the v1 depth. */
  test("the scene stays inside the catalog's kind set and aggregate caps", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["workspaces"],
        modules_center: ["clock"],
        modules_right: [],
      },
    });
    const walk = walkScene(run.component());
    for (const kind of walk.kinds) {
      expect(NODE_KINDS).toContain(kind as never);
    }
    expect(walk.depth).toBeLessThanOrEqual(16);
    expect(walk.nodes).toBeLessThanOrEqual(2048);
    expect(walk.textBytes).toBeLessThanOrEqual(256 * 1024);
    // The bar's own, tighter line bound still governs the painted band.
    expect(walk.textBytes).toBeLessThanOrEqual(BAR_BOUNDS.lineBytes);
  });

  /** Worst shipped case: 16 capsules, still far inside MAX_PILLS/MAX_NODES. */
  test("a full 16-workspace band is inside the pill and node caps", async () => {
    const rows = Array.from({ length: BAR_BOUNDS.workspaces }, (_, index) =>
      ws(index + 1, `workspace-${index + 1}`, index === 5),
    );
    const run = await bar({ workspaces: rows });
    const shape = bandShape(run.component());
    expect(shape.problems).toEqual([]);
    const pills = shape.regions[0]!.leaves.filter((leaf) => leaf.text !== " ");
    const separators = shape.regions[0]!.leaves.filter(
      (leaf) => leaf.text === " ",
    );
    expect(pills).toHaveLength(BAR_BOUNDS.workspaces);
    expect(separators).toHaveLength(BAR_BOUNDS.workspaces - 1);
    expect(pills.length).toBeLessThanOrEqual(64);
    const walk = walkScene(run.component());
    expect(walk.nodes).toBeLessThanOrEqual(2048);
    expect(walk.textBytes).toBeLessThanOrEqual(BAR_BOUNDS.lineBytes);
  });
});

describe("pill-row recipe (bitty#2114 C-2)", () => {
  /**
   * Delta D3: the bar's spelling is the padded capsule, not the catalog's
   * bracketed `[label]`. A revert to the catalog spelling changes every
   * capsule leaf text and fails here.
   */
  test("each pill is one padded Text leaf, never bracketed", async () => {
    const run = await bar({ workspaces: THREE });
    const shape = bandShape(run.component());
    const texts = shape.regions[0]!.leaves.map((leaf) => leaf.text);
    expect(texts).toEqual([" 1 ", " ", " 4* ", " ", " 9 "]);
    for (const text of texts) {
      expect(text).not.toContain("[");
      expect(text).not.toContain("]");
    }
    // Active state rides as redundant emphasis (`Pill::active` -> bold).
    const active = shape.regions[0]!.leaves.find(
      (leaf) => leaf.text === " 4* ",
    );
    expect(active?.bold).toBe(true);
    expect(active?.fg).toBe("background");
    expect(active?.bg).toBe("accent");
  });

  /**
   * The recipe's separators are bare single spaces: a pill's own decoration
   * (fill, emphasis, click, wheel) never leaks onto its separator. Only the
   * module-level hover region rides them, because the group owns that region.
   */
  test("separators are bare single spaces with no pill decoration", async () => {
    const run = await bar({ workspaces: THREE });
    const shape = bandShape(run.component());
    const separators = shape.regions[0]!.leaves.filter(
      (leaf) => leaf.text === " ",
    );
    expect(separators).toHaveLength(2);
    for (const separator of separators) {
      expect(fieldsOf(separator)).toEqual(["on_hover"]);
      expect(separator.on_hover?.command).toBe(HOVER_COMMAND);
    }
  });

  /**
   * Delta D4 (pill label): the bar bounds a name at 32 *characters*
   * (`M.NAME_MAX_CHARS`), so a 32-character CJK name is a 96-byte label --
   * three times `CATALOG_MAX_PILL_LABEL_BYTES`. The recipe reports it instead
   * of cutting it, so the pill keeps all 32 characters. Enforcing the catalog
   * cap would shorten this pill (or drop it) and fail this assertion.
   */
  test("a non-ASCII label keeps the bar's char bound, past the byte cap", async () => {
    const name = "界".repeat(BAR_BOUNDS.nameChars);
    const run = await bar({
      workspaces: [ws(1, name)],
      settings: {
        label: "name",
        show_single: true,
        modules_center: [],
        modules_right: [],
      },
    });
    const shape = bandShape(run.component());
    const pill = shape.regions[0]!.leaves.find((leaf) => leaf.text !== " ");
    expect(pill).toBeDefined();
    const label = (pill!.text ?? "").trim();
    expect([...label].filter((char) => char === "界")).toHaveLength(
      BAR_BOUNDS.nameChars,
    );
    expect(bytes(label)).toBe(BAR_BOUNDS.nameChars * 3);
    expect(bytes(label)).toBeGreaterThan(32);
  });
});

describe("tooltip-detail-fallback recipe (bitty#2114 C-3 rungs 1-2)", () => {
  /**
   * The overlay body is the entry's one plain `Text` leaf: no style token, no
   * binding, no children. A revert to a decorated or nested body fails the
   * field list.
   */
  test("the overlay body is one plain Text leaf", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["workspaces"],
        modules_center: ["clock"],
        modules_right: [],
      },
      fakeNow: 1700000000,
    });
    const clock = bandShape(run.component()).regions[1]!.leaves[0]!;
    run.host.dispatchCommand(HOVER_COMMAND, {
      region: clock.on_hover!.region!.id,
      phase: "enter",
    });
    const overlay = run.overlay();
    expect(overlay?.kind).toBe("Text");
    expect(fieldsOf(overlay!)).toEqual([]);
    expect(run.overlayText()).not.toBe("");
  });

  /**
   * Delta D4 (detail): the bar's own bound is 256 bytes
   * (`M.HOVER_DETAIL_MAX_BYTES`), twice `CATALOG_MAX_DETAIL_BYTES`. A detail
   * longer than the catalog cap still paints in full, so the cap is measured.
   */
  test("a detail past the catalog cap still paints, up to the bar's bound", async () => {
    const windows = Array.from(
      { length: 6 },
      (_, index) => `window-${index}-${"d".repeat(20)}`,
    );
    const run = await bar({
      workspaces: [{ ...ws(1, "dev", false, 6), windows } as WorkspaceInfo],
      settings: { show_single: true, modules_center: [], modules_right: [] },
    });
    const capsule = bandShape(run.component()).regions[0]!.leaves[0]!;
    run.host.dispatchCommand(HOVER_COMMAND, {
      region: capsule.on_hover!.region!.id,
      phase: "enter",
    });
    const text = run.overlayText();
    expect(bytes(text)).toBeGreaterThan(128);
    expect(bytes(text)).toBeLessThanOrEqual(BAR_BOUNDS.detailBytes);
    expect(run.overlay()?.text).toBe(text);
  });

  /**
   * The other spelling of the fallback: a read-only atom binds the registered
   * `detail` command (the explicit notification) instead of a control click.
   */
  test("a read-only module binds the detail command, not a control", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: {
        modules_left: ["workspaces"],
        modules_center: [],
        modules_right: ["cpu"],
      },
      grants: [...BAR_CAPABILITIES, "platform.cpu-read"],
      services: {
        "system.cpu": {
          snapshot: { total_pct: 42.4, per_core: [50, 30], stale_age_ms: 0 },
        },
      },
    });
    const cpu = bandShape(run.component()).regions[1]!.leaves[0]!;
    expect(cpu.text).toBe("42%");
    expect(cpu.on_click?.command).toBe("bitty-terminal.bar:detail");
    expect(cpu.on_click?.args?.["text"]).toBeTypeOf("string");
  });
});

describe("the recipes are the composition sites", () => {
  /**
   * These pin the call graph, not just the shape: reverting to the inline
   * hand-rolled Row/Text assembly (the pre-dogfood composer) leaves the shape
   * assertions above green but fails here. That is the discriminating pair --
   * shape guards the contract, these guard that the contract is composed by
   * the catalog recipes.
   */
  test("the band root comes from M.catalog_band_node", () => {
    const body = sourceSlice("function M.render_bar(", "\nend\n");
    expect(body).toContain("M.catalog_band_node(regions)");
    expect(body).not.toContain('{ kind = "Row", children = children }');
  });

  test("the pill row comes from M.catalog_pill_row", () => {
    const body = sourceSlice("function M.segments(", "\nend\n");
    expect(body).toContain(
      "M.catalog_pill_row(pills, M.CATALOG_PILL_SPELLING)",
    );
    expect(body).not.toContain("M.CAPSULE_PAD .. label");
  });

  test("the tooltip and detail fallback come from the detail recipe", () => {
    expect(sourceSlice("local function show_tooltip(", "\nend\n")).toContain(
      "M.catalog_detail_node(text)",
    );
    expect(sourceSlice("function M.atom_node(", "\nend\n")).toContain(
      "M.catalog_detail_binding(atom.tooltip, atom.region)",
    );
  });
});

describe("the declared capabilities are unchanged", () => {
  /**
   * The dogfood is a composition change, never a capability widening: the
   * manifest requests the same set the harness grants.
   */
  test("the plugin still requests only the declared capability set", async () => {
    const run = await bar({ workspaces: THREE });
    expect(run.host.handlerViolations).toEqual([]);
    expect([...BAR_CAPABILITIES]).toEqual([
      "ui.rich",
      "ui.overlay",
      "workspace.read",
      "workspace.control",
      "platform.notify",
    ]);
    expect(leaves(run.component()).length).toBeGreaterThan(0);
  });
});
