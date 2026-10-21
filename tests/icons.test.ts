/**
 * Icon maps, format composition, and display-cell width (bar#24 extension,
 * bar#30). ASCII stays the default and must not change any historical output;
 * `pua` and `nerd` are opt-in glyph maps selected by the `icons` setting.
 *
 * The width suite pins the display-cell contract: PUA/Nerd glyphs are one
 * cell, CJK/emoji are two, combining marks are zero, and a malformed icon
 * falls back to its ASCII entry instead of corrupting column math.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
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

const runs: BarRun[] = [];
let mod: Record<string, any> = {};
let pureLua: LuaEngine | undefined;

beforeAll(async () => {
  const factory = new LuaFactory();
  pureLua = await factory.createEngine({ injectObjects: false });
  mod = (await pureLua.doString(ENTRY_SOURCE)) as Record<string, any>;
});

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

const THREE: WorkspaceInfo[] = [
  ws(1, "ws1"),
  ws(4, "code", true),
  ws(9, "logs"),
];

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

const ICON_KEYS = [
  "clock",
  "network_wifi",
  "network_ethernet",
  "network_disconnected",
  "network_disabled",
  "bluetooth_on",
  "bluetooth_off",
  "bluetooth_connected",
  "audio_muted",
  "audio_low",
  "audio_medium",
  "audio_high",
  "audio_speaker",
  "audio_headphones",
  "audio_headset",
  "audio_hdmi",
  "audio_usb",
  "audio_bluetooth",
  "microphone_on",
  "microphone_muted",
  "cpu",
  "memory",
  "battery",
  "battery_charging",
  "battery_full",
] as const;

describe("icon maps (pure)", () => {
  test("ascii is the shipped default", () => {
    expect(mod["DEFAULTS"].icons).toBe("ascii");
    expect(mod["icon_set"](undefined)).toEqual(mod["ICON_SETS"].ascii);
    expect(mod["icon_set"]("nope")).toEqual(mod["ICON_SETS"].ascii);
  });

  test("ascii reproduces the historical tokens exactly", () => {
    expect(mod["icon_glyph"]("ascii", "clock")).toBe("");
    expect(mod["icon_glyph"]("ascii", "network_wifi", 1)).toBe("");
    expect(mod["icon_glyph"]("ascii", "audio_low")).toBe("LO");
    expect(mod["icon_glyph"]("ascii", "audio_muted")).toBe("MUTE");
    expect(mod["icon_glyph"]("ascii", "microphone_on")).toBe("mic");
    expect(mod["icon_glyph"]("ascii", "microphone_muted")).toBe("mic:mute");
    expect(mod["icon_glyph"]("ascii", "battery", 5)).toBe("[====]");
    expect(mod["icon_glyph"]("ascii", "battery_charging", 5)).toBe("[====]+");
    expect(mod["icon_glyph"]("ascii", "battery_full")).toBe("[====]");
  });

  test("every opt-in set carries every key with a valid glyph", () => {
    for (const name of ["pua", "nerd"]) {
      const set = mod["ICON_SETS"][name] as Record<string, unknown>;
      for (const key of ICON_KEYS) {
        expect(set[key]).toBeDefined();
      }
      expect((set["network_wifi"] as unknown[]).length).toBe(4);
      expect((set["battery"] as unknown[]).length).toBe(5);
      expect((set["battery_charging"] as unknown[]).length).toBe(5);
    }
  });

  test("every PUA/Nerd glyph is UTF-8, bounded, and one cell unless documented", () => {
    for (const name of ["pua", "nerd"]) {
      const set = mod["ICON_SETS"][name] as Record<string, unknown>;
      for (const key of ICON_KEYS) {
        const raw = set[key];
        const entries = Array.isArray(raw) ? raw : [raw];
        for (const glyph of entries) {
          expect(mod["valid_icon"](glyph)).toBe(true);
          expect(mod["utf8_valid"](glyph)).toBe(true);
          const cells = mod["display_cells"](glyph) as number;
          // The PUA charging ladder is battery glyph + bolt (two cells) by
          // design; every other glyph is one display cell.
          const expectedMax =
            key === "battery_charging" && name === "pua" ? 2 : 1;
          expect(cells).toBeGreaterThan(0);
          expect(cells).toBeLessThanOrEqual(expectedMax);
        }
      }
    }
  });

  test("a malformed or over-long icon falls back to the ascii entry", async () => {
    expect(mod["valid_icon"]("x".repeat(25))).toBe(false);
    expect(mod["icon_glyph"]("nerd", "missing_key")).toBe("");
    expect(mod["icon_glyph"]("nerd", "network_wifi", 9)).toBe("");
    const fallback = await pureLua!.doString(
      [
        "local M = (function()",
        ENTRY_SOURCE,
        "end)()",
        "M.ICON_SETS.nerd.clock = '\\255'",
        "return M.icon_glyph('nerd', 'clock')",
      ].join("\n"),
    );
    // The ascii clock entry is the empty string.
    expect(fallback).toBe("");
  });
});

describe("display-cell width (pure)", () => {
  test("counts ASCII, wide, combining, and emoji cells, never bytes", () => {
    expect(mod["display_cells"]("abc")).toBe(3);
    expect(mod["display_cells"]("日本語")).toBe(6);
    expect(mod["display_cells"]("🚀")).toBe(2);
    expect(mod["display_cells"]("e\u0301")).toBe(1);
    expect(mod["display_cells"]("\u200b")).toBe(0);
    expect(mod["display_cells"]("")).toBe(0);
  });

  test("a PUA glyph is one cell even without the font", () => {
    expect(mod["display_cells"](mod["ICON_SETS"].nerd.clock)).toBe(1);
    expect(mod["display_cells"](mod["ICON_SETS"].pua.cpu)).toBe(1);
    // A replacement character is also one cell, so a fontless terminal cannot
    // shift the columns after the glyph.
    expect(mod["display_cells"]("\uFFFD")).toBe(1);
  });

  test("truncate_cells cuts on code-point boundaries and never splits a wide glyph", () => {
    expect(mod["truncate_cells"]("abcdef", 3)).toBe("abc");
    expect(mod["truncate_cells"]("日本語", 3)).toBe("日");
    expect(mod["truncate_cells"]("日本語", 2)).toBe("日");
    expect(mod["truncate_cells"]("日本語", 1)).toBe("");
    expect(mod["truncate_cells"]("abc", 0)).toBe("");
  });

  test("compose_icon joins with one space and bounds by cells", () => {
    expect(mod["compose_icon"]("", "42%")).toBe("42%");
    expect(mod["compose_icon"](mod["ICON_SETS"].nerd.clock, "12:00")).toBe(
      `${mod["ICON_SETS"].nerd.clock} 12:00`,
    );
    const bounded = mod["compose_icon"](
      mod["ICON_SETS"].nerd.clock,
      "x".repeat(300),
      4,
    ) as string;
    expect(mod["display_cells"](bounded)).toBe(4);
  });
});

describe("icon selection (pure)", () => {
  const NERD = () => mod["ICON_SETS"].nerd;

  test("network selects by link and uses the signal ladder when reported", () => {
    const rung = (signal: number | undefined) =>
      mod["network_icon"]({ link: "wifi", signal_pct: signal }, "nerd");
    expect(rung(10)).toBe(NERD().network_wifi[0]);
    expect(rung(40)).toBe(NERD().network_wifi[1]);
    expect(rung(70)).toBe(NERD().network_wifi[2]);
    expect(rung(95)).toBe(NERD().network_wifi[3]);
    // No signal field on the current provider: connected reads as full.
    expect(rung(undefined)).toBe(NERD().network_wifi[3]);
    expect(mod["network_icon"]({ link: "ethernet" }, "nerd")).toBe(
      NERD().network_ethernet,
    );
    expect(mod["network_icon"]({ link: "disconnected" }, "nerd")).toBe(
      NERD().network_disconnected,
    );
    expect(mod["network_icon"]({ link: "disabled" }, "nerd")).toBe(
      NERD().network_disabled,
    );
    expect(mod["network_icon"]({ link: "wifi" }, "ascii")).toBe("");
  });

  test("bluetooth selects off, on, and connected", () => {
    expect(
      mod["bluetooth_icon"]({ powered: false, connected_count: 0 }, "nerd"),
    ).toBe(NERD().bluetooth_off);
    expect(
      mod["bluetooth_icon"]({ powered: true, connected_count: 0 }, "nerd"),
    ).toBe(NERD().bluetooth_on);
    expect(
      mod["bluetooth_icon"]({ powered: true, connected_count: 2 }, "nerd"),
    ).toBe(NERD().bluetooth_connected);
  });

  test("audio maps device classes and lets muted win", () => {
    expect(mod["audio_device_class"]("analog-output-headphones")).toBe(
      "headphones",
    );
    expect(mod["audio_device_class"]("analog-output-speaker")).toBe("speaker");
    expect(mod["audio_device_class"]("hdmi-output-0")).toBe("hdmi");
    expect(mod["audio_device_class"]("usb-headset")).toBe("headset");
    expect(mod["audio_device_class"]("bluez-output-1")).toBe("bluetooth");
    expect(mod["audio_device_class"]("weird-port")).toBeNil();

    const snap = {
      volume_pct: 50,
      muted: false,
      port: "analog-output-headphones",
    };
    expect(mod["audio_icon"](snap, "nerd")).toBe(NERD().audio_headphones);
    expect(mod["audio_icon"]({ ...snap, muted: true }, "nerd")).toBe(
      NERD().audio_muted,
    );
    expect(mod["audio_icon"]({ ...snap, port: "weird-port" }, "nerd")).toBe(
      NERD().audio_medium,
    );
    // ASCII keeps the historical bands.
    expect(mod["audio_icon"](snap, "ascii")).toBe("MED");
    expect(mod["audio_icon"]({ ...snap, volume_pct: 10 }, "ascii")).toBe("LO");
    expect(mod["audio_icon"]({ ...snap, muted: true }, "ascii")).toBe("MUTE");
  });

  test("microphone selects on/muted", () => {
    expect(mod["microphone_icon"]({ source_muted: false }, "nerd")).toBe(
      NERD().microphone_on,
    );
    expect(mod["microphone_icon"]({ source_muted: true }, "nerd")).toBe(
      NERD().microphone_muted,
    );
    expect(mod["microphone_icon"]({ source_muted: true }, "ascii")).toBe(
      "mic:mute",
    );
  });

  test("battery ladders cover discharging, charging, and full", () => {
    expect(mod["battery_glyph"]("nerd", 5, "discharging")).toBe(
      NERD().battery[0],
    );
    expect(mod["battery_glyph"]("nerd", 50, "discharging")).toBe(
      NERD().battery[2],
    );
    expect(mod["battery_glyph"]("nerd", 50, "charging")).toBe(
      NERD().battery_charging[2],
    );
    expect(mod["battery_glyph"]("nerd", 100, "full")).toBe(NERD().battery_full);
    // ASCII keeps the historical ladder and the `+` charging mark.
    expect(mod["battery_glyph"]("ascii", 50, "discharging")).toBe("[==  ]");
    expect(mod["battery_glyph"]("ascii", 50, "charging")).toBe("[==  ]+");
    expect(mod["battery_glyph"]("ascii", 50, "full")).toBe("[==  ]");
    expect(mod["battery_glyph"]("ascii", 100, "full")).toBe("[====]");
  });
});

describe("format composition (pure)", () => {
  const NETWORK = {
    link: "wifi",
    down_bps: 8000,
    up_bps: 4000,
    signal_pct: 90,
  };
  const BLUETOOTH = { powered: true, connected_count: 1, total_count: 2 };
  const AUDIO = {
    volume_pct: 50,
    muted: false,
    port: "analog-output-headphones",
  };

  test("network default text prefixes the selected icon and keeps rates/ESSID", () => {
    const nerd = mod["network_text"](NETWORK, "Home", {
      icons: "nerd",
    }) as string;
    expect(nerd.startsWith(mod["ICON_SETS"].nerd.network_wifi[3])).toBe(true);
    expect(nerd).toContain("wifi 8.0K/4.0K (Home)");
    expect(mod["network_text"](NETWORK, "Home", {})).toBe(
      "wifi 8.0K/4.0K (Home)",
    );
  });

  test("network custom template exposes {icon} and compacts absent keys", () => {
    expect(
      mod["network_text"](NETWORK, undefined, {
        icons: "nerd",
        format: "{icon}|{link}|{down}|{essid}",
      }),
    ).toBe(`${mod["ICON_SETS"].nerd.network_wifi[3]}|wifi|8.0K|`);
  });

  test("bluetooth default and custom formats carry the icon", () => {
    const nerd = mod["bluetooth_text"](BLUETOOTH, { icons: "nerd" }) as string;
    expect(nerd).toBe(
      `${mod["ICON_SETS"].nerd.bluetooth_connected} bt on (1/2)`,
    );
    expect(mod["bluetooth_text"](BLUETOOTH, {})).toBe("bt on (1/2)");
    expect(
      mod["bluetooth_text"](BLUETOOTH, {
        icons: "nerd",
        format: "{icon} {status} {connected}/{total}",
      }),
    ).toBe(`${mod["ICON_SETS"].nerd.bluetooth_connected} on 1/2`);
  });

  test("audio default and custom formats carry the device/muted icon", () => {
    const nerd = mod["audio_text"](AUDIO, { icons: "nerd" }) as string;
    expect(nerd).toBe(
      `${mod["ICON_SETS"].nerd.audio_headphones} 50%:analog-output-he`,
    );
    expect(mod["audio_text"](AUDIO, {})).toBe("MED 50%:analog-output-he");
    expect(
      mod["audio_text"](AUDIO, {
        icons: "nerd",
        format: "{icon}:{volume}:{muted}",
      }),
    ).toBe(`${mod["ICON_SETS"].nerd.audio_headphones}:50:false`);
  });

  test("microphone default and custom formats carry on/muted", () => {
    const snap = { source_volume_pct: 70, source_muted: true };
    expect(mod["microphone_text"](snap, { icons: "nerd" })).toBe(
      `${mod["ICON_SETS"].nerd.microphone_muted} 70%`,
    );
    expect(mod["microphone_text"](snap, {})).toBe("mic:mute 70%");
    expect(
      mod["microphone_text"](snap, {
        icons: "nerd",
        format: "{icon}|{volume}|{muted}",
      }),
    ).toBe(`${mod["ICON_SETS"].nerd.microphone_muted}|70|true`);
  });

  test("cpu and memory custom formats expose {icon}", () => {
    expect(
      mod["render_template"]("{icon} {total}%", {
        icon: mod["ICON_SETS"].nerd.cpu,
        total: 42,
      }),
    ).toBe(`${mod["ICON_SETS"].nerd.cpu} 42%`);
    expect(
      mod["render_template"]("{icon} {pct}%", {
        icon: mod["ICON_SETS"].nerd.memory,
        pct: 63,
      }),
    ).toBe(`${mod["ICON_SETS"].nerd.memory} 63%`);
  });
});

describe("icons through activation", () => {
  test("ascii activation output is unchanged", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["clock", "workspaces"] },
    });
    expect(textOf(run.component())).toMatch(/^\d\d:\d\d  1   4\*   9 $/);
  });

  test("icons = nerd paints the glyph on the clock and sensor modules", async () => {
    const cpu = await bar({
      workspaces: THREE,
      settings: { modules_left: ["clock", "cpu"], icons: "nerd" },
      grants: [
        "ui.rich",
        "workspace.read",
        "workspace.control",
        "platform.notify",
      ],
      services: {
        "system.cpu": { snapshot: { total_pct: 42.4, per_core: [40, 44] } },
      },
    });
    const text = textOf(cpu.component());
    expect(text.startsWith(mod["ICON_SETS"].nerd.clock)).toBe(true);
    expect(text).toContain(`${mod["ICON_SETS"].nerd.cpu} 42%`);
  });

  test("icons = pua paints the legacy Font Awesome glyphs", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { modules_left: ["clock"], icons: "pua" },
    });
    expect(textOf(run.component()).startsWith(mod["ICON_SETS"].pua.clock)).toBe(
      true,
    );
  });

  test("an unknown icons value paints ascii and reports one bounded diagnostic", async () => {
    const run = await bar({
      workspaces: THREE,
      settings: { icons: "emoji" },
    });
    expect(textOf(run.component())).toBe(" 1   4*   9 ");
    expect(run.host.notifications).toEqual([
      {
        title: "Unified Bar",
        body: "Unified Bar: unknown icons 'emoji'; using 'ascii'.",
      },
    ]);
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("painted glyph widths keep the clock columns stable", async () => {
    const ascii = await bar({
      workspaces: THREE,
      settings: { modules_left: ["clock"] },
    });
    const nerd = await bar({
      workspaces: THREE,
      settings: { modules_left: ["clock"], icons: "nerd" },
    });
    const asciiLeaf = leaves(ascii.component())[0]!;
    const nerdLeaf = leaves(nerd.component())[0]!;
    const delta =
      mod["display_cells"](nerdLeaf.text) -
      mod["display_cells"](asciiLeaf.text);
    expect(delta).toBe(2); // one glyph cell plus the joining space
  });
});
