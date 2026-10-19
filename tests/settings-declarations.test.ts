/**
 * Regression for bar#21: activation failed on Bitty 0.0.24 with
 * `E_SETTINGS_UNDECLARED` for `show` (and the sibling keys the entry point
 * reads). The host fails an undeclared `bitty.settings.get` closed, so a
 * manifest without the matching `[settings]` declarations aborts activation
 * before `bitty.ui.mount` and the workspace bar never appears.
 *
 * The fix declares every read key in the manifest. This suite keeps it fixed
 * three ways: the declarations must match exactly the key set the entry point
 * reads, their kinds and shipped defaults must match the Lua fallbacks, and
 * activation must succeed both with an empty settings file (defaults in
 * force) and with explicit user values.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { LuaFactory } from "wasmoon";

import {
  activateBar,
  ENTRY_SOURCE,
  leaves,
  MANIFEST_SOURCE,
  textOf,
  ws,
  type BarRun,
} from "./harness.js";

interface SettingDeclaration {
  readonly kind: string;
  readonly default: string;
}

/** Parse the manifest `[settings]` inline-table declarations. */
function declaredSettings(manifest: string): Map<string, SettingDeclaration> {
  const declarations = new Map<string, SettingDeclaration>();
  let inSettings = false;
  for (const line of manifest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[.+\]$/.test(trimmed)) {
      inSettings = trimmed === "[settings]";
      continue;
    }
    if (!inSettings || trimmed === "" || trimmed.startsWith("#")) continue;
    const match =
      /^([a-z][a-z0-9_]*)\s*=\s*\{\s*type\s*=\s*"([^"]+)"\s*,\s*default\s*=\s*(.+?)\s*\}$/.exec(
        trimmed,
      );
    if (match === null) {
      throw new Error(`unparsable [settings] declaration: ${trimmed}`);
    }
    declarations.set(match[1] as string, {
      kind: match[2] as string,
      default: match[3] as string,
    });
  }
  return declarations;
}

/** Module-level constants the entry point reads its settings through. */
interface BarModule {
  readonly DEFAULTS: Readonly<Record<string, unknown>>;
  readonly MODULE_GROUPS: readonly string[];
  readonly MODULES: Readonly<Record<string, unknown>>;
  readonly NAME_MAX_CHARS: number;
}

/** Load `lua/bar/init.lua` without a host (the pure policy surface). */
async function loadModule(): Promise<BarModule> {
  const factory = new LuaFactory();
  const lua = await factory.createEngine({ injectObjects: false });
  try {
    return (await lua.doString(ENTRY_SOURCE)) as BarModule;
  } finally {
    lua.global.close();
  }
}

const DECLARED = declaredSettings(MANIFEST_SOURCE);
const MODULE = await loadModule();

/** Every key the entry point passes to `bitty.settings.get`. */
const READ_KEYS = [
  ...Object.keys(MODULE.DEFAULTS),
  ...MODULE.MODULE_GROUPS,
  ...Object.keys(MODULE.MODULES),
];

/**
 * Per-case budget for a case that boots one or more Lua VMs. The work is
 * I/O-bound (wasmoon boot on a slow checkout), not CPU-bound, and bun's 5 s
 * default is too tight for the two-activation cases.
 */
const ACTIVATION_TIMEOUT_MS = 20_000;

const runs: BarRun[] = [];

async function activate(
  options: Parameters<typeof activateBar>[0],
): Promise<BarRun> {
  const run = await activateBar(options);
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

/** Painted text, or undefined when the band paints nothing. */
function painted(run: BarRun): string | undefined {
  const text = textOf(run.component());
  return text === "" ? undefined : text;
}

/**
 * Capsule texts in paint order. The shipped default plan also centers the
 * clock, whose reading is wall-clock dependent, so the workspace assertions
 * read the capsule leaves instead of the whole row.
 */
function capsules(run: BarRun): string[] {
  return leaves(run.component())
    .map((leaf) => leaf.text ?? "")
    .filter((text) => text.startsWith("["));
}

const TWO = [ws(1, "ws1", true), ws(4, "code")];

describe("bar#21 settings declarations match the entry point", () => {
  test("the manifest declares a [settings] table", () => {
    expect(MANIFEST_SOURCE).toContain("\n[settings]\n");
    expect(DECLARED.size).toBeGreaterThan(0);
  });

  test("every bitty.settings.get key is declared and nothing extra is", () => {
    expect(READ_KEYS.length).toBeGreaterThan(0);
    expect([...DECLARED.keys()].sort()).toEqual([...new Set(READ_KEYS)].sort());
  });

  test("declared kinds and defaults match the plugin fallbacks", () => {
    expect(DECLARED.get("show")).toEqual({ kind: "bool", default: "true" });
    expect(DECLARED.get("edge")).toEqual({
      kind: "string",
      default: '"bottom"',
    });
    expect(DECLARED.get("show_single")).toEqual({
      kind: "bool",
      default: "false",
    });
    expect(DECLARED.get("name_max_chars")).toEqual({
      kind: "int",
      default: String(MODULE.NAME_MAX_CHARS),
    });
    expect(DECLARED.get("label")).toEqual({
      kind: "string",
      default: '"index"',
    });

    for (const group of MODULE.MODULE_GROUPS) {
      expect(DECLARED.get(group)?.kind).toBe("string-array");
    }
    for (const name of Object.keys(MODULE.MODULES)) {
      expect(DECLARED.get(name)?.kind).toBe("string-array");
    }

    expect(MODULE.DEFAULTS.show).toBe(true);
    expect(MODULE.DEFAULTS.edge).toBe("bottom");
    expect(MODULE.DEFAULTS.show_single).toBe(false);
    expect(MODULE.DEFAULTS.name_max_chars).toBe(MODULE.NAME_MAX_CHARS);
    expect(MODULE.DEFAULTS.label).toBe("index");
  });

  test(
    "the host still fails an undeclared read closed",
    async () => {
      // Guards the regression itself: without the declarations above, the same
      // read aborts activation with E_SETTINGS_UNDECLARED.
      const run = await activate({ workspaces: TWO });
      expect(() => run.host.bitty.settings.get("show")).not.toThrow();
      expect(() => run.host.bitty.settings.get("unclaimed")).toThrow(
        /E_SETTINGS_UNDECLARED/,
      );
    },
    ACTIVATION_TIMEOUT_MS,
  );
});

describe("bar#21 activation with declared settings", () => {
  test(
    "an empty settings file activates with the shipped defaults",
    async () => {
      const run = await activate({ workspaces: TWO, settings: {} });
      // Exactly one mount, on the default bottom edge.
      expect(run.mounts.map((mount) => mount.slot)).toEqual(["bottom"]);
      // The four keys named by bar#21 are read and defaulted: capsules paint,
      // the lone-workspace rule stays off, and the label stays bounded.
      expect(capsules(run)).toEqual(["[1*]", "[4]"]);
      expect(painted(run)).toStartWith("[1*] [4]");
    },
    ACTIVATION_TIMEOUT_MS,
  );

  test(
    "activation without any settings bridge values also succeeds",
    async () => {
      // No `settings` argument at all: every declared key resolves to its
      // shipped manifest default on the host side.
      const run = await activate({ workspaces: TWO });
      expect(capsules(run)).toEqual(["[1*]", "[4]"]);
    },
    ACTIVATION_TIMEOUT_MS,
  );

  test(
    "explicit values are honored",
    async () => {
      const run = await activate({
        workspaces: TWO,
        settings: {
          show: true,
          edge: "top",
          show_single: false,
          name_max_chars: 4,
          label: "both",
        },
      });
      expect(run.mounts.map((mount) => mount.slot)).toEqual(["top"]);
      expect(capsules(run)).toEqual(["[1:ws1*]", "[4:code]"]);
    },
    ACTIVATION_TIMEOUT_MS,
  );

  test(
    "explicit visibility values are honored",
    async () => {
      const hidden = await activate({
        workspaces: TWO,
        settings: { show: false },
      });
      expect(painted(hidden)).toBeUndefined();

      const lone = await activate({
        workspaces: [ws(1, "ws1", true)],
        settings: { show_single: true },
      });
      expect(capsules(lone)).toEqual(["[1*]"]);
    },
    ACTIVATION_TIMEOUT_MS,
  );
});
