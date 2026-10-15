/**
 * Compat-floor regression (bar#13, P0).
 *
 * The `>=0.5,<1.0` template default rejected host 0.0.22 with EXIT=4, so no
 * module could activate. The floor is now `>=0.0.21,<0.1` (composer parity).
 * These tests pin that decision: the manifest must keep admitting the
 * verified 0.0.x host line and keep the restrictive `<0.1` ceiling, so a
 * future floor bump that re-blocks the current host fails here instead of
 * in VM-headed verification.
 *
 * Range evaluation below mirrors the host resolver
 * (`bitty/crates/bitty-runtime/src/plugin_runtime/package.rs`
 * `evaluate_range`: Rust `semver` `VersionReq` over comma-conjoined
 * comparators) for the comparator subset this manifest uses. The host is
 * authoritative; this evaluator exists only because the SDK does not export
 * its `version-range.ts` matcher through the package root, and it covers
 * exactly `>=`, `<`, `^` plus comma conjunction. Syntax validity itself is
 * asserted through the authoritative SDK linter (`versionReqProblem`).
 */

import { describe, expect, test } from "bun:test";

import { MOCK_PLUGIN_API_VERSION, versionReqProblem } from "bitty-plugin-sdk";

import { MANIFEST_SOURCE } from "./harness.js";

/** Current host line the floor must admit (verify2: bitty@1982750e). */
const VERIFIED_HOSTS = ["0.0.21", "0.0.22"] as const;

/** Versions the floor/ceiling must keep rejecting. */
const REJECTED_BITTY = ["0.0.20", "0.5.0", "1.0.0"] as const;

type Triple = readonly [number, number, number];

function parseTriple(raw: string): Triple | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  if (
    (major.length > 1 && major.startsWith("0")) ||
    (minor.length > 1 && minor.startsWith("0")) ||
    (patch.length > 1 && patch.startsWith("0"))
  ) {
    return undefined;
  }
  return [Number(major), Number(minor), Number(patch)];
}

function compare(left: Triple, right: Triple): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

interface Clause {
  readonly operator: ">=" | "<=" | ">" | "<" | "=";
  readonly version: Triple;
}

/** Caret expansion per the host's Rust `semver` semantics. */
function expandCaret(version: Triple): readonly Clause[] {
  const [major, minor, patch] = version;
  if (major > 0) {
    return [
      { operator: ">=", version },
      { operator: "<", version: [major + 1, 0, 0] },
    ];
  }
  if (minor > 0) {
    return [
      { operator: ">=", version },
      { operator: "<", version: [0, minor + 1, 0] },
    ];
  }
  return [
    { operator: ">=", version },
    { operator: "<", version: [0, 0, patch + 1] },
  ];
}

function parseClause(raw: string): Clause | readonly Clause[] | undefined {
  const match =
    /^(>=|<=|==|=|>|<|\^|~)?[ \t]*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(
      raw.trim(),
    );
  if (match === null) return undefined;
  const [, operator = "=", major, minor = "0", patch = "0"] = match;
  const version: Triple = [Number(major), Number(minor), Number(patch)];
  if (operator === "^") return expandCaret(version);
  if (operator === "~") {
    return [
      { operator: ">=", version },
      // `~` pins major + minor on the host line (`~1.2.3` → `<1.3.0`).
      { operator: "<", version: [version[0], version[1] + 1, 0] },
    ];
  }
  return {
    operator: operator === "==" ? "=" : (operator as Clause["operator"]),
    version,
  };
}

function satisfies(version: string, range: string): boolean | undefined {
  const actual = parseTriple(version);
  if (actual === undefined) return undefined;
  const clauses: Clause[] = [];
  for (const part of range.split(",")) {
    const parsed = parseClause(part);
    if (parsed === undefined) return undefined;
    if (Array.isArray(parsed)) clauses.push(...parsed);
    else clauses.push(parsed);
  }
  for (const clause of clauses) {
    const order = compare(actual, clause.version);
    switch (clause.operator) {
      case ">=":
        if (!(order >= 0)) return false;
        break;
      case "<=":
        if (!(order <= 0)) return false;
        break;
      case ">":
        if (!(order > 0)) return false;
        break;
      case "<":
        if (!(order < 0)) return false;
        break;
      case "=":
        if (order !== 0) return false;
        break;
    }
  }
  return true;
}

function compatValue(key: "bitty" | "plugin-api"): string {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, "m").exec(
    MANIFEST_SOURCE,
  );
  if (match === null) throw new Error(`[compat] ${key} is missing`);
  return match[1];
}

describe("compat floor (bar#13)", () => {
  test("compat.bitty range is syntactically valid per the SDK linter", () => {
    expect(versionReqProblem(compatValue("bitty"))).toBeUndefined();
  });

  test("compat.bitty admits the verified 0.0.x host line", () => {
    const range = compatValue("bitty");
    for (const host of VERIFIED_HOSTS) {
      expect(satisfies(host, range)).toBe(true);
    }
  });

  test("compat.bitty keeps the sub-floor and <0.1-ceiling rejections", () => {
    const range = compatValue("bitty");
    for (const host of REJECTED_BITTY) {
      expect(satisfies(host, range)).toBe(false);
    }
  });

  test("compat plugin-api still admits the Plugin API v1 line", () => {
    const range = compatValue("plugin-api");
    expect(versionReqProblem(range)).toBeUndefined();
    expect(satisfies(MOCK_PLUGIN_API_VERSION, range)).toBe(true);
    expect(satisfies("2.0.0", range)).toBe(false);
  });
});
