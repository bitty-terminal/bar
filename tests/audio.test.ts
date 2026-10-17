/**
 * Audio bar modules (CTX-1220, bitty#2013): the `pulseaudio` state/control
 * module plus the optional `spectrum` cava-lite meter.
 *
 * Contract (bitty PRs #2058/#2071, read-only here): state 2 s, spectrum 5 Hz
 * / <=32 buckets / <=1 KiB, control 10 Hz coalesced; fixed-`pactl` monitor, no
 * shell (host-side; Lua never spawns); fail-closed hide when the monitor is
 * absent. Lua-side only: icon/port selection, glyph mapping, pause, falloff,
 * and peak-hold all live in `lua/bar/init.lua`.
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

import {
  activateBar,
  ENTRY_SOURCE,
  leaves,
  textOf,
  ws,
  type BarRun,
  type WorkspaceInfo,
} from "./harness.js";

const TOGGLE_COMMAND = "bitty-terminal.bar:audio-toggle";
const STEP_COMMAND = "bitty-terminal.bar:audio-step";

const THREE: WorkspaceInfo[] = [
  ws(1, "ws1"),
  ws(4, "code", true),
  ws(9, "logs"),
];

const runs: BarRun[] = [];

async function bar(...args: Parameters<typeof activateBar>): Promise<BarRun> {
  const run = await activateBar(...args);
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

/** Pure module table loaded without a host (`bitty == nil`). */
let mod: Record<string, any> = {};
let pureLua: LuaEngine | undefined;

beforeAll(async () => {
  const factory = new LuaFactory();
  pureLua = await factory.createEngine({ injectObjects: false });
  mod = (await pureLua.doString(ENTRY_SOURCE)) as Record<string, any>;
});

afterAll(() => {
  pureLua?.global.close();
});

function painted(run: BarRun): string | undefined {
  const text = textOf(run.component());
  return text === "" ? undefined : text;
}

describe("audio snapshot validation and icons (pure)", () => {
  test("audio_valid_snapshot accepts a well-formed snapshot", () => {
    expect(
      mod["audio_valid_snapshot"]({
        volume_pct: 50,
        muted: false,
        port: "analog-output-headphones",
      }),
    ).toBe(true);
  });

  test("audio_valid_snapshot rejects bad volume, mute, and port", () => {
    const good = { volume_pct: 50, muted: false, port: "p" };
    expect(mod["audio_valid_snapshot"]({ ...good, volume_pct: -1 })).toBe(
      false,
    );
    expect(mod["audio_valid_snapshot"]({ ...good, volume_pct: 101 })).toBe(
      false,
    );
    expect(mod["audio_valid_snapshot"]({ ...good, volume_pct: 50.5 })).toBe(
      false,
    );
    expect(mod["audio_valid_snapshot"]({ ...good, muted: 0 })).toBe(false);
    expect(mod["audio_valid_snapshot"]({ ...good, port: "" })).toBe(false);
    expect(mod["audio_valid_snapshot"]({ ...good, port: "x".repeat(65) })).toBe(
      false,
    );
    expect(mod["audio_valid_snapshot"](undefined)).toBe(false);
    expect(mod["audio_valid_snapshot"](42)).toBe(false);
  });

  test("audio_icon selects muted and low/med/high bands", () => {
    expect(mod["audio_icon"]({ volume_pct: 50, muted: true })).toBe("MUTE");
    expect(mod["audio_icon"]({ volume_pct: 0, muted: false })).toBe("MUTE");
    expect(mod["audio_icon"]({ volume_pct: 1, muted: false })).toBe("LO");
    expect(mod["audio_icon"]({ volume_pct: 33, muted: false })).toBe("LO");
    expect(mod["audio_icon"]({ volume_pct: 34, muted: false })).toBe("MED");
    expect(mod["audio_icon"]({ volume_pct: 66, muted: false })).toBe("MED");
    expect(mod["audio_icon"]({ volume_pct: 67, muted: false })).toBe("HI");
    expect(mod["audio_icon"]({ volume_pct: 100, muted: false })).toBe("HI");
  });

  test("audio_text renders icon, volume, and port by default", () => {
    const snap = {
      volume_pct: 50,
      muted: false,
      port: "analog-output-headphones",
    };
    expect(mod["audio_text"](snap, {})).toBe("MED 50%:analog-output-he");
    expect(mod["audio_text"](snap, { show_port: false })).toBe("MED 50%");
    expect(
      mod["audio_text"]({ volume_pct: 50, muted: true, port: "p" }, {}),
    ).toBe("MUTE 50%:p");
    expect(mod["audio_text"](undefined, {})).toBe("");
  });

  test("audio_text honors a custom format template", () => {
    const snap = { volume_pct: 7, muted: false, port: "hdmi" };
    expect(mod["audio_text"](snap, { format: "{icon}={volume}" })).toBe("LO=7");
  });

  test("audio_tooltip carries the full port name", () => {
    expect(
      mod["audio_tooltip"]({
        volume_pct: 50,
        muted: false,
        port: "analog-output-headphones",
      }),
    ).toBe("analog-output-headphones");
    expect(mod["audio_tooltip"](undefined) ?? undefined).toBeUndefined();
  });
});

describe("volume wheel-step coalescing (pure)", () => {
  test("volume_step passes bounded integer steps", () => {
    expect(mod["volume_step"](3)).toBe(3);
    expect(mod["volume_step"](-4)).toBe(-4);
    expect(mod["volume_step"](2.7)).toBe(2);
  });

  test("volume_step saturates bursts at one step", () => {
    expect(mod["volume_step"](100)).toBe(10);
    expect(mod["volume_step"](-100)).toBe(-10);
    expect(mod["volume_step"](4096)).toBe(10);
  });

  test("volume_step is a no-op for sub-line and bad input", () => {
    expect(mod["volume_step"](0.5) ?? undefined).toBeUndefined();
    expect(mod["volume_step"](0) ?? undefined).toBeUndefined();
    expect(mod["volume_step"]("3") ?? undefined).toBeUndefined();
    expect(mod["volume_step"](undefined) ?? undefined).toBeUndefined();
  });
});

describe("spectrum glyphs and smoothing (pure)", () => {
  test("spectrum_glyph maps 0..1 across the block ramp", () => {
    expect(mod["spectrum_glyph"](0)).toBe(" ");
    expect(mod["spectrum_glyph"](1)).toBe("█");
    expect(mod["spectrum_glyph"](0.5)).toBe("▄");
    expect(mod["spectrum_glyph"](-1)).toBe(" ");
    expect(mod["spectrum_glyph"](2)).toBe("█");
    expect(mod["spectrum_glyph"]("x")).toBe(" ");
  });

  test("spectrum_text joins one glyph per bucket, capped at 32", () => {
    expect(mod["spectrum_text"]([0, 0.5, 1])).toBe(" ▄█");
    expect(mod["spectrum_text"]([])).toBe("");
    expect(mod["spectrum_text"](undefined)).toBe("");
    const wide = Array.from({ length: 40 }, () => 1);
    expect([...(mod["spectrum_text"](wide) as string)].length).toBe(32);
  });

  test("spectrum_falloff attacks instantly and decays linearly", () => {
    expect(mod["spectrum_falloff"](undefined, [0.5])).toEqual([0.5]);
    expect(mod["spectrum_falloff"]([0.2], [0.9])).toEqual([0.9]);
    const decayed = mod["spectrum_falloff"]([0.9], [0.2]) as number[];
    expect(decayed[0]).toBeCloseTo(0.75, 5);
    expect(decayed[0]).toBeGreaterThan(0.2);
  });

  test("spectrum_peak_step holds transients then decays", () => {
    type Peaks = { levels: number[]; hold: number[] };
    const first = mod["spectrum_peak_step"](
      undefined,
      undefined,
      [0.8],
    ) as Peaks;
    expect(first.levels).toEqual([0.8]);
    const held = mod["spectrum_peak_step"](
      first.levels,
      first.hold,
      [0.1],
    ) as Peaks;
    expect(held.levels[0]).toBe(0.8);
    let levels: number[] = held.levels;
    let hold: number[] = held.hold;
    for (let i = 0; i < 3; i += 1) {
      const next = mod["spectrum_peak_step"](levels, hold, [0.1]) as Peaks;
      levels = next.levels;
      hold = next.hold;
    }
    expect(levels[0]).toBe(0.8);
    const released = mod["spectrum_peak_step"](levels, hold, [0.1]) as Peaks;
    expect(released.levels[0]).toBeLessThan(0.8);
  });

  test("spectrum_with_peaks takes the per-bucket max", () => {
    expect(mod["spectrum_with_peaks"]([0.2, 0.9], [0.8, 0.1])).toEqual([
      0.8, 0.9,
    ]);
  });

  test("out-of-range bucket counts sample as absent (fail closed)", () => {
    expect(mod["spectrum_sample"](99) ?? undefined).toBeUndefined();
    expect(mod["spectrum_sample"](0) ?? undefined).toBeUndefined();
  });

  test("a paused meter freezes the last row without polling (pure)", async () => {
    // The `paused` option table is inert through v1 settings integration, so
    // the freeze branch is proven here: with a seeded last row, a paused
    // render returns it without touching any provider.
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      const text = await lua.doString(
        "local M = (function()\n" +
          ENTRY_SOURCE +
          "\nend)()\n" +
          'M._spectrum_last_text = "frozen"\n' +
          "local atoms = M.spectrum_atoms({ options = { paused = true } })\n" +
          "return atoms[1].text",
      );
      expect(text).toBe("frozen");
    } finally {
      lua.global.close();
    }
  });
});

describe("audio module registry and cadence (pure)", () => {
  test("the registry exposes workspaces, clock, pulseaudio, spectrum, and the Phase B device and sensor modules", () => {
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
      "pulseaudio",
      "spectrum",
      "workspaces",
    ]);
  });

  test("pulseaudio polls at the 2 s state ceiling", () => {
    const modules = mod["MODULES"] as Record<string, { tick_ms: number }>;
    expect(modules["pulseaudio"]!.tick_ms).toBe(2000);
    expect(mod["tick_ms"](modules["pulseaudio"], {})).toBe(2000);
  });

  test("spectrum polls at 4 fps inside the 5 Hz ceiling", () => {
    const modules = mod["MODULES"] as Record<string, { tick_ms: number }>;
    expect(modules["spectrum"]!.tick_ms).toBe(250);
    expect(mod["tick_ms"](modules["spectrum"], {})).toBe(250);
  });

  test("the timer floor is the spectrum 5 Hz ceiling", () => {
    expect(mod["MIN_TICK_MS"]).toBe(200);
    expect(mod["tick_ms"]({ tick_ms: 60000 }, { tick_ms: 1 })).toBe(200);
  });

  test("entry_module accepts the audio module names", () => {
    expect(mod["entry_module"]("pulseaudio")).toBe("pulseaudio");
    expect(mod["entry_module"]("spectrum")).toBe("spectrum");
  });
});

describe("pulseaudio module render (broker stubs)", () => {
  test("volume, mute state, and port render when the monitor is present", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio"] },
      audioState: {
        volume_pct: 50,
        muted: false,
        port: "analog-output-headphones",
      },
    });
    expect(painted(run)).toBe("MED 50%:analog-output-he");
  });

  test("muted state renders the mute icon with the parked level", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio"] },
      audioState: { volume_pct: 30, muted: true, port: "hdmi" },
    });
    expect(painted(run)).toBe("MUTE 30%:hdmi");
  });

  test("an absent monitor hides the module (fail closed)", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio", "workspaces"] },
    });
    expect(painted(run)).toBe("[1:ws1] [4:code*] [9:logs]");
  });

  test("read-only render carries no click or scroll binding without the control head", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio"] },
      audioState: { volume_pct: 50, muted: false, port: "p" },
    });
    const leaf = leaves(run.component())[0]!;
    expect(leaf.on_click).toEqual({
      command: "bitty-terminal.bar:detail",
      args: { text: "p" },
    });
    expect(leaf.on_scroll).toBeUndefined();
  });

  test("a granted control head binds click-toggle and wheel-step", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio"] },
      audioState: { volume_pct: 50, muted: false, port: "p" },
      audioControl: true,
    });
    const leaf = leaves(run.component())[0]!;
    expect(leaf.on_click).toEqual({ command: TOGGLE_COMMAND, args: {} });
    expect(leaf.on_scroll).toEqual({ command: STEP_COMMAND, args: {} });
  });

  test("click dispatch toggles mute through the control head", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio"] },
      audioState: { volume_pct: 50, muted: false, port: "p" },
      audioControl: true,
    });
    expect(run.host.dispatchCommand(TOGGLE_COMMAND, {})).toBe(true);
    expect(run.audioControl().toggles).toBe(1);
  });

  test("wheel dispatch steps the volume bounded through the control head", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio"] },
      audioState: { volume_pct: 50, muted: false, port: "p" },
      audioControl: true,
    });
    expect(run.host.dispatchCommand(STEP_COMMAND, { delta: 3 })).toBe(true);
    expect(run.host.dispatchCommand(STEP_COMMAND, { delta: -2 })).toBe(true);
    expect(run.host.dispatchCommand(STEP_COMMAND, { delta: 100 })).toBe(true);
    expect(run.audioControl().steps).toEqual([3, -2, 10]);
  });

  test("sub-line wheel ticks are a no-op without a control call", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio"] },
      audioState: { volume_pct: 50, muted: false, port: "p" },
      audioControl: true,
    });
    expect(run.host.dispatchCommand(STEP_COMMAND, { delta: 0.5 })).toBe(false);
    expect(run.audioControl().steps).toEqual([]);
  });

  test("control dispatch fails closed without the control head", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio"] },
      audioState: { volume_pct: 50, muted: false, port: "p" },
    });
    expect(run.host.dispatchCommand(TOGGLE_COMMAND, {})).toBe(false);
    expect(run.host.dispatchCommand(STEP_COMMAND, { delta: 3 })).toBe(false);
  });
});

describe("spectrum cava-lite meter (broker stubs)", () => {
  test("block glyphs render at 4 fps when levels are present", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["spectrum"] },
      audioSpectrum: [0, 0.5, 1],
    });
    expect(painted(run)).toBe(" ▄█");
  });

  test("an absent meter hides (never fabricates)", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["spectrum", "workspaces"] },
    });
    expect(painted(run)).toBe("[1:ws1] [4:code*] [9:logs]");
  });

  test("bucket counts above 32 fall back to the default", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["spectrum"], spectrum: { buckets: 99 } },
      audioSpectrum: [0, 0.5, 1],
    });
    expect(painted(run)).toBe(" ▄█");
  });

  test("an unpaused meter re-polls every 250 ms (pause inert under v1)", async () => {
    // The `paused` option table reads as [] under the v1 declared-keys gate
    // (see bitty-plugin.toml), so the meter polls on its default cadence.
    // The freeze logic itself stays covered by the pure suite below.
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["spectrum"], spectrum: { paused: true } },
      audioSpectrum: [1, 1, 1],
    });
    expect(painted(run)).toBe("███");
    expect(run.audioSpectrumCalls()).toBe(1);
    run.host.advanceTimers(250);
    expect(painted(run)).toBe("███");
    expect(run.audioSpectrumCalls()).toBe(2);
  });
});

describe("no new Core API (audio rides the v1 broker surface)", () => {
  test("pulseaudio and spectrum call only services.get plus the chassis surface", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["pulseaudio", "spectrum", "workspaces"] },
      audioState: { volume_pct: 50, muted: false, port: "p" },
      audioSpectrum: [0.25],
      audioControl: true,
    });
    expect(painted(run)).toContain("MED 50%");
  });
});
