# Unified Bar

Consolidated workspace-bar, tabs, and statusline presentation over generic chrome insets.

## Overview

Unified Bar renders the workspace capsule strip and a configurable set of
system modules (clock, CPU, memory, battery, network, Bluetooth, backlight,
idle, and audio) in one chrome band. Workspace mechanism stays in Core; the
plugin presents `bitty.workspace.list()` and forwards an explicit focus
request. System modules read optional broker providers and hide fail closed
when a provider is absent or ungranted.

> Status: pre-implementation ecosystem. Behavior is verified against the
> bitty-plugin-sdk mock host (pinned by commit), not against a released host.
> The workspace bar and system modules are implemented; tabs and statusline
> modules are not implemented yet.

## Install

Prerequisites: Bitty `>=0.0.24,<0.1` and Plugin API `^1.0` (from
`bitty-plugin.toml` `[compat]`). Optional system modules additionally need
their broker providers and the matching capability grants; a missing provider
hides that module rather than the whole bar.

```sh
bitty plugin install https://github.com/bitty-terminal/bar.git
bitty plugin enable bitty-terminal.bar
bitty plugin list   # confirm state and grants
```

From a local checkout:

```sh
bitty plugin install ./bar --yes
bitty plugin enable bitty-terminal.bar
```

`bitty plugin list` confirms activation: the entry must be enabled and list the
granted capabilities. A disabled entry carries a `disabled_reason`; see
[Troubleshooting](#troubleshooting).

## Commands

| Command                                | What it does                                                                                              | Arguments                                              | Default keybinding  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------- |
| `bitty-terminal.bar:focus`             | Focus a workspace by stable id (public command; capsule clicks use `workspace-action`).                   | `id` (integer, required, `>= 1`)                       | None (click target) |
| `bitty-terminal.bar:detail`            | Show a module's detail text as a notification (explicit fallback; hover uses the overlay tooltip).        | `text` (string, required, max 1024 bytes)              | None (click target) |
| `bitty-terminal.bar:hover`             | Update the non-modal overlay tooltip on pointer enter/leave (Core band hover; no capture, no modal).      | `region` (string, required), `phase` (`enter`/`leave`) | None (hover target) |
| `bitty-terminal.bar:workspace-action`  | Capsule target: left focuses, wheel cycles previous/next, middle/right show the workspace detail.         | `id?`, `delta?` plus host-injected `button`/`region`   | None (click target) |
| `bitty-terminal.bar:clock-action`      | Clock target: right cycles short/date/calendar, middle shows the full date-time, left is a no-op.         | host-injected `button`/`region`                        | None (click target) |
| `bitty-terminal.bar:network-action`    | Network target: left/middle show the link detail; right toggles the radio when a control head is granted. | host-injected `button`/`region`                        | None (click target) |
| `bitty-terminal.bar:audio-toggle`      | PulseAudio target: left/middle toggle sink mute, right shows the sink detail.                             | host-injected `button`/`region`                        | None (click target) |
| `bitty-terminal.bar:audio-step`        | Step the default sink volume; `delta` is a host-computed signed line count.                               | `delta` (number, required) plus host-injected `region` | None (wheel target) |
| `bitty-terminal.bar:microphone-action` | Microphone target: left/right toggle source mute, middle shows the microphone detail.                     | host-injected `button`/`region`                        | None (click target) |
| `bitty-terminal.bar:microphone-step`   | Step the source volume; `delta` is a host-computed signed line count.                                     | `delta` (number, required) plus host-injected `region` | None (wheel target) |
| `bitty-terminal.bar:bluetooth-toggle`  | Flip Bluetooth radio power through `bluetooth.control`; degrades to a notification when denied.           | None                                                   | None (click target) |
| `bitty-terminal.bar:backlight-step`    | Step backlight brightness by `delta` percent points through `backlight.control`.                          | `delta` (number, required, `-100..100`)                | None (click target) |
| `bitty-terminal.bar:idle-toggle`       | Flip idle inhibition through `idle.control`; degrades to a notification when denied.                      | None                                                   | None (click target) |

All commands are also invocable from the command palette. Clicks and wheel
steps dispatch registered commands only; there is no shell-string path. For a
region-aware span, the host injects `button` (`left`/`right`/`middle`) and
`region` into the declared args; a wheel merges the computed `delta`. A direct
palette or keymap invocation carries no button and reads as `left`.

## Configuration

Settings are declared in `bitty-plugin.toml` `[settings]` and resolved from
`$XDG_CONFIG_HOME/bitty/plugins/bitty-terminal.bar.lua`. Every key is
user-owned; the plugin never writes settings.

| Key              | Type         | Default                                | Description                                                                                                                        | Applies         |
| ---------------- | ------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `show`           | boolean      | `true`                                 | Mount and paint the bar.                                                                                                           | Live            |
| `edge`           | string       | `"bottom"`                             | Band slot, `"top"` or `"bottom"`; any other string falls back to `"bottom"`.                                                       | Next activation |
| `show_single`    | boolean      | `false`                                | Keep the bar visible when only one workspace exists. An occupied scratchpad also forces it visible.                                | Live            |
| `name_max_chars` | integer      | `32`                                   | Maximum characters per workspace name in `name` and `both` label modes, `1..32`.                                                   | Live            |
| `label`          | string       | `"index"`                              | Capsule label mode: `"index"`, `"name"`, or `"both"`; an unknown value falls back to `"index"`.                                    | Live            |
| `icons`          | string       | `"ascii"`                              | Icon map: `"ascii"` (default, unchanged output), `"pua"`, or `"nerd"`; an unknown value falls back to `"ascii"`.                   | Live            |
| `modules_left`   | string array | `["workspaces"]`                       | Ordered module names for the left group; anchored to the left inset edge.                                                          | Live            |
| `modules_center` | string array | `["clock"]`                            | Ordered module names for the center group; centered on the full band row (never "after left").                                     | Live            |
| `modules_right`  | string array | `["network","cpu","memory","battery"]` | Ordered module names for the right group; flush to the right inset edge.                                                           | Live            |
| `workspaces`     | string array | `[]`                                   | Per-module option collection for `workspaces`. Strict v1 settings accept a string array only, so option maps keep module defaults. | Live            |
| `clock`          | string array | `[]`                                   | Per-module option collection for `clock`; same string-array limit as above.                                                        | Live            |
| `network`        | string array | `[]`                                   | Per-module option collection for `network`; same string-array limit as above.                                                      | Live            |
| `bluetooth`      | string array | `[]`                                   | Per-module option collection for `bluetooth`; same string-array limit as above.                                                    | Live            |
| `backlight`      | string array | `[]`                                   | Per-module option collection for `backlight`; same string-array limit as above.                                                    | Live            |
| `idle`           | string array | `[]`                                   | Per-module option collection for `idle`; same string-array limit as above.                                                         | Live            |
| `pulseaudio`     | string array | `[]`                                   | Per-module option collection for `pulseaudio`; same string-array limit as above.                                                   | Live            |
| `microphone`     | string array | `[]`                                   | Per-module option collection for `microphone`; same string-array limit as above.                                                   | Live            |
| `spectrum`       | string array | `[]`                                   | Per-module option collection for `spectrum`; same string-array limit as above.                                                     | Live            |
| `cpu`            | string array | `[]`                                   | Per-module option collection for `cpu`; same string-array limit as above.                                                          | Live            |
| `memory`         | string array | `[]`                                   | Per-module option collection for `memory`; same string-array limit as above.                                                       | Live            |
| `battery`        | string array | `[]`                                   | Per-module option collection for `battery`; same string-array limit as above.                                                      | Live            |

```lua
-- $XDG_CONFIG_HOME/bitty/plugins/bitty-terminal.bar.lua
return {
  show = true,
  edge = "bottom",
  show_single = false,
  label = "index",
  icons = "ascii",
  modules_left = { "workspaces" },
  modules_center = { "clock" },
  modules_right = { "network", "cpu", "memory", "battery" },
}
```

The shipped plan keeps workspaces on the left and the clock in the center
group. The right group defaults to the `network`, `cpu`, `memory`, and
`battery` indicators, in that order. Each of those modules is provider-backed
and hides fail closed when its broker provider is absent or ungranted, so a
fresh install on a host without sensors paints only the capsules and clock
instead of showing errors. Remove a module from the group list to opt out, or
set `modules_right = {}` to drop the whole group; add `pulseaudio`,
`microphone`, `bluetooth`, `backlight`, `idle`, or `spectrum` only when the
matching provider and capability grant are available.

`modules_left`, `modules_center`, and `modules_right` are true anchored groups
(Core #2411): the bar emits one child `Row` per non-empty group with
`anchor = "left" | "center" | "right"`, and Core resolves the placement
against the live band width. The center group is centered on the full row,
the right group is flush to the right inset edge, and narrow widths clip
deterministically (left first, then right, then center) without overlapping.
The plugin never simulates alignment with padding strings. On a host without
Core #2411 the `anchor` key is ignored and the groups flow left-to-right in
declaration order, so the bar still paints.

The host parses plugin settings at activation; `config.reloaded` re-reads
them and re-renders, so `show`, labels, icons, and the module plan update
without reopening Bitty. On v1 hosts, timer cadences already armed at
activation are not re-chained, so a cadence change waits for a new generation.
`edge` can only
change on a new activation because `bitty.ui.mount` is valid only during
activation and v1 has no unmount or move.

## Keybindings

The plugin installs no keyboard bindings. Clicks bind the capsule
`workspace-action` and the module action commands; wheel steps bind
`workspace-action`, `audio-step`, and `microphone-step`. To run a command from
the keyboard, add a user mapping in `$XDG_CONFIG_HOME/bitty/init.lua`; user
mappings keep precedence:

```lua
return {
  keymaps = {
    {
      chord = "ctrl+alt+b",
      action = "bitty-terminal.bar:focus",
      context = "global",
    },
  },
}
```

`focus` requires an `id` argument, so a bare keymap entry cannot choose a
workspace; bind other bar commands or use the click targets.

## Troubleshooting

| Symptom / error                          | Meaning                                                                                                                                                                                                                          | What to do                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `E_INCOMPATIBLE`                         | The host application or Plugin API version is outside `[compat]`; activation is disabled with no partial mount.                                                                                                                  | Upgrade Bitty or install a bar revision whose ranges admit your host. Do not edit the manifest ranges.                                                             |
| `E_SETTINGS_UNDECLARED`                  | The entry point read a settings key absent from `[settings]`. This is a plugin defect.                                                                                                                                           | Every read key is declared; if it still appears, report it with `bitty plugin info bitty-terminal.bar` and run `bitty --safe` meanwhile.                           |
| Capability denied                        | `E_CAPABILITY_DENIED` (class `runtime`): `ui.rich` hides the band, `workspace.read` empties it, `workspace.control` makes clicks no-ops, `ui.overlay` drops only the hover tooltip, `platform.notify` drops the detail fallback. | Reinstall and approve the grants, or inspect granted versus requested capabilities with `bitty plugin list`. A missing sensor/device grant only hides that module. |
| Control click notifies instead of acting | The control head is ungranted or the call was denied (`E_NOT_PERMITTED`); the click degrades to one notification by design.                                                                                                      | Grant the matching `*.control` capability at install/consent time, or keep the read-only render.                                                                   |
| Bar is missing                           | `show = false`, a lone workspace with `show_single = false` and no occupied scratchpad, or lazy activation before the first workspace event.                                                                                     | Check the settings file and `bitty plugin list`; open or focus a workspace to trigger the first render.                                                            |
| Two bars                                 | Core still draws `workspace.show_bar` while the plugin paints its band.                                                                                                                                                          | Set `workspace.show_bar = false` in the main configuration.                                                                                                        |
| `E_SPAWN_FAILED`                         | Not applicable: this plugin spawns no process and opens no socket.                                                                                                                                                               | —                                                                                                                                                                  |

## Workspace bar

- One padded capsule per workspace, one space each side (`" 1 "`), joined by
  single spaces. `label` defaults to the stable workspace seq alone
  (`" 1   2* "`), which keeps the bar quiet; `label = "name"` renders the
  truncated name (`" shell "`) and `label = "both"` the historical `id:name`
  pair (`" 1:shell "`). The id is the
  stable workspace seq from `bitty.workspace.list()`, so closing a workspace
  never renumbers the survivors. The active capsule carries `*`, bold, the
  `background` foreground, and the `accent` background theme token. Inactive
  capsules use the subtler `selection` background so they recede without
  disappearing; the capsule padding is part of the same atom and therefore
  part of the click target. Occupied workspaces carry `+` when
  `panel_count > 0`; attention (`bell`, `activity`, or `exited`) carries `!`
  with `cursor` emphasis. An empty workspace list renders `—` (fail closed).
- Core's v1 band exposes text runs with `fg`/`bg`/`bold` and painted fills, but
  no corner-radius primitive. The shipped capsule is therefore a square padded
  background (one space each side) rather than a rounded pill; rounding needs a
  future Core band shape, not a plugin-local invention.
- In `name` and `both` modes, names are cut to 32 characters (or
  `name_max_chars`); an empty name falls back to the seq, so a capsule is
  never blank. Complete capsules are retained in stable numeric id order and
  the line is bounded to 1024 UTF-8 bytes. A capsule remains one styled `Text`
  atom, preserving its complete click target.
- A lone workspace hides the bar unless `show_single = true`.
- Every capsule carries the `workspace.<id>` item region. Left runs
  `bitty-terminal.bar:workspace-action { id }`, which queues
  `bitty.workspace.focus(id)` by stable id; the active capsule is a no-op on
  left, and separators, the scratchpad indicator, unknown or stale ids, and
  non-integer ids queue nothing. Middle/right show that workspace's detail,
  and the wheel steps to the previous (wheel-up) or next workspace, wrapping
  at both ends.
- The bar re-renders from `bitty.workspace.list()` on every `workspace.*`
  event and re-renders on `config.reloaded`, which re-reads the settings;
  only `edge` stays pinned to the activation generation because the mount
  slot cannot move.

### Modules (declarative)

Settings declare an ordered module list, modeled on Waybar's
`modules-left/center/right`. Each non-empty group is one anchored `Row`
under the scene root; Core resolves `left`/`center`/`right` against the live
band width, so the center group is truly centered and the right group is
flush to the right inset edge. The groups keep their declarative order, and a
narrow band clips them deterministically instead of overlapping.

Each listed name resolves against the in-plugin module registry. A module
renders atoms `{ text, bold?, fg?, on_click?, on_scroll?, tooltip?, region? }`
from local data or a broker-provided interface and refreshes on its own
cadence:

- `workspaces` (event module): the capsule strip; refreshes from the
  `workspace.*` events — no timer where events suffice.
- `clock` (timer module): `os.date` with a per-module `format` (a restricted,
  zero-grant local source); refreshes on `tick_ms`. Right click cycles
  short time, weekday date, and ISO calendar date; middle shows the full
  local date-time; the cycle repaints immediately.
- `cpu` (timer module, Phase B): aggregate CPU utilization from the broker
  `system.cpu@1.0.0` provider (`bitty-terminal.sensors`); polls at the 2 s
  provider ceiling.
- `memory` (timer module, Phase B): memory and swap utilization from
  `system.memory@1.0.0`; polls at the 2 s ceiling.
- `battery` (timer module, Phase B): capacity and charge state from
  `system.battery@1.0.0`; polls at the 5 s ceiling.
- `pulseaudio` (timer module, Phase B provider module): volume, mute, and port
  from the `audio.state@1.0.0` broker interface with icon selection Lua-side;
  polls at the 2 s state ceiling. Left/middle toggle mute, right shows the
  sink detail, and the wheel steps the volume through `audio.control@1.0.0`
  (bounded ±10 steps, 10 Hz coalesced host-side). Read-only text when the
  control head is ungranted; hidden when the state monitor is absent (fail
  closed).
- `microphone` (timer module, Phase B provider module): source (microphone)
  level and mute from the optional `source_volume_pct` / `source_muted` fields
  of the same `audio.state@1.0.0` snapshot, so no new capability is requested.
  Left/right toggle source mute and the wheel steps the input only when the
  control head serves the optional source methods; middle shows the detail.
  The live reader serves no source fields in 0.0.26, so the module hides fail
  closed rather than showing a fake level.
- `spectrum` (timer module, Phase B provider module): the cava-lite meter —
  block glyphs (U+2581-U+2588) in a Text node at 4 fps from the
  `audio.spectrum@1.0.0` broker interface (<=32 buckets). Falloff smoothing
  and peak-hold run in Lua; `paused = true` freezes the last row. Hidden until
  a live spectrum source lands host-side (the `pactl` monitor exposes no level
  taps by design, so the meter hides rather than fabricates; 60 fps cava stays
  out of scope).

A bad spec never hides the bar: an unknown module name, a non-name entry, a
non-list group, or a plan that resolves to nothing falls back to the shipped
default plan (`modules_left = ["workspaces"]`, `modules_center = ["clock"]`,
`modules_right = ["network", "cpu", "memory", "battery"]`). A fresh install
therefore paints the workspace capsules, the clock, and any right-side system
indicators whose providers are available; provider modules hide fail closed,
so an absent provider removes only that module. Set `modules_center = []` or
`modules_right = []` to remove a group.

### Pointer buttons

A module atom may declare a per-item band `region` beside its
`on_click`/`on_scroll` binding (`region = { id, kind }`). Core derives the
display-cell rectangle from the painted spans, so the plugin never supplies
coordinates; a click on that span dispatches the registered command with the
host-injected `button` (`left`/`right`/`middle`) and `region`, and a wheel
merges the host-computed `delta`. Clicks and wheel steps therefore remain
registered-command-only: `on-click` shell strings are not a vehicle and can
never reach the scene. Right/middle region dispatch needs Core #2248 (Bitty
0.0.26); on the 0.0.24/0.0.25 hosts the region key is ignored and left-click
and wheel routing keep working, which is why the `[compat]` floor stays at
0.0.24.

| Module                                     | Left                | Middle                | Right                      | Wheel                        |
| ------------------------------------------ | ------------------- | --------------------- | -------------------------- | ---------------------------- |
| `workspaces`                               | Focus the capsule   | Workspace detail      | Workspace detail           | Previous (up) / next (down)  |
| `clock`                                    | No-op               | Full date-time detail | Cycle short/date/calendar  | —                            |
| `network`                                  | Link detail         | Link detail           | Radio toggle when granted¹ | —                            |
| `pulseaudio`                               | Toggle sink mute    | Toggle sink mute      | Sink detail                | Step volume (±10, coalesced) |
| `microphone`                               | Toggle source mute² | Microphone detail     | Toggle source mute²        | Step input (±10)             |
| `cpu`, `memory`, `battery`                 | Detail              | Detail                | Detail                     | —                            |
| read-only `bluetooth`, `backlight`, `idle` | Detail³             | Detail³               | Detail³                    | —                            |

¹ `network.control` is a forward-looking stub, not a live guarantee: it is not
declared in `[services.required]`, no provider ships in 0.0.26, and only the
mock harness exercises the toggle path. On a live host the right click
degrades to the link detail; a real provider must add the service and
capability declaration first.

² The audio provider exposes sink control only; source mute/step methods are
probed optionally and an absent method fails closed. The microphone module
itself also hides until the provider reports source fields.

³ With its control head granted, the left click keeps the existing toggle/step
behavior (`bluetooth-toggle`, `backlight-step`, `idle-toggle`). Independently
of the click binding, the module's detail text (the bonded-device list for
`bluetooth`, the `tooltip` option for `backlight`/`idle`) is the hover
tooltip; a read-only module also keeps the `detail` notification fallback on
click.

### Hover detail

Every rendered module atom carries an `on_hover` binding with a stable
per-module region id (`bar:module:<name>`, plus `:<n>` for a repeated name in
one plan). Core resolves the live region under the pointer and dispatches the
registered `hover` command with `phase = "enter"` or `"leave"`; no pointer
coordinates reach the plugin. On enter the bar writes the module's existing
detail text (cpu/memory/battery readings, the clock date-time, the workspace
strip, the audio port, the bonded-device list, or a module's `tooltip`
option) into its `overlay`-slot block as one bounded plain-text row; on leave
it clears it. Core anchors the block to the live module region and presents
it as a non-modal tooltip.

Hover is presentation-only: it never captures input, never sets modal state,
and never uses an OS notification. The tooltip disappears on leave, focus
loss, bar hide, or when the module no longer exists after a re-render. A
module with no detail text still has a hover region that round-trips
enter/leave and simply shows no tooltip. On hosts without Core #2411 the
`on_hover` key is ignored, so clicks and wheel steps keep working unchanged.

### Icons and display cells

`icons` selects a shipped glyph map for the modules that carry a symbol:

- `"ascii"` (default) is byte-identical to the historical output. Clock,
  network, bluetooth, cpu, and memory compose no icon; audio keeps
  `LO`/`MED`/`HI`/`MUTE`; battery keeps the five `[    ]`…`[====]` buckets and
  the `+` charging mark.
- `"pua"` uses the legacy Font Awesome private-use block (`nf-fa-*`), which is
  present in most patched fonts.
- `"nerd"` uses Nerd Fonts v3 Material Design glyphs (`nf-md-*`).

The maps cover the clock, the network link kinds (a four-rung Wi-Fi strength
ladder in `nerd`; `pua` repeats one Font Awesome Wi-Fi glyph, so it is not a
strength ladder), ethernet, disconnected, disabled, Bluetooth
(off/on/connected), audio device classes
(speaker/headphones/headset/HDMI/USB/Bluetooth) and muted state, microphone
(on/muted), cpu, memory, and the battery charging/discharging ladders plus the
`full` state. `battery_full` is the same glyph as the top ladder rung in every
set. The network snapshot carries no signal strength in 0.0.26, so Wi-Fi
renders the top ladder rung; a future `signal_pct` field selects the real rung
without a bar change.

Width is measured in **display cells**, never UTF-8 bytes: combining marks
take 0, CJK/emoji take 2, and Nerd Font private-use glyphs take their declared
1 cell. A terminal without the font paints its replacement box in that same
one-cell slot, so columns after the glyph do not shift. An over-long or
malformed icon string falls back to its ASCII entry, and a missing map key
composes no icon (fail closed). A 300-character text composed with an icon is
still bounded to 256 display cells.

Text+icon composition is a stable `{icon}` template key (or the clock's icon
prefix). The default templates are unchanged for ASCII, e.g. battery remains
`{icon} {capacity}%`; a custom per-module `format` may place `{icon}` itself.
Per-module option tables are inert under the v1 settings contract (see below),
so the maps currently compose through the tested defaults; the template
surface lights up unchanged when table settings land.

Per-module options live in a settings collection named after the module.
Each collection is declared in the manifest `[settings]` table (bitty#2010);
under the v1 settings contract the collections have no table or dot-path
form, so they are declared `string-array` with an empty default and read as
module defaults until table settings land host- and SDK-side (CTX-1226). The
option logic itself is unchanged and covered by the pure suites:

| Module       | Option           | Type    | Default              | Notes                                                             |
| ------------ | ---------------- | ------- | -------------------- | ----------------------------------------------------------------- |
| `clock`      | `format`         | string  | `"%H:%M"`            | `os.date` format.                                                 |
| `clock`      | `tick_ms`        | integer | `60000`              | Timer cadence, clamped to the `200` ms floor.                     |
| `clock`      | `tooltip`        | string  | none                 | Hover / middle-click detail; default the live date-time.          |
| `pulseaudio` | `format`         | string  | none                 | Bounded `{icon}`/`{volume}`/`{port}`/`{muted}` template override. |
| `pulseaudio` | `show_port`      | boolean | `true`               | Append the truncated port to the text.                            |
| `pulseaudio` | `port_max_chars` | integer | `16`                 | Port display width, `1..64`.                                      |
| `pulseaudio` | `tick_ms`        | integer | `2000`               | State poll cadence, clamped to the `200` ms floor.                |
| `pulseaudio` | `tooltip`        | string  | none                 | Hover tooltip; default the full port name (text may truncate it). |
| `microphone` | `format`         | string  | `"{icon} {volume}%"` | Keys: `{icon}`, `{volume}`, `{muted}`.                            |
| `microphone` | `tick_ms`        | integer | `2000`               | Source poll cadence (same snapshot as `pulseaudio`).              |
| `microphone` | `tooltip`        | string  | none                 | Default: `Microphone 70% (muted)`.                                |
| `spectrum`   | `buckets`        | integer | `8`                  | Sample width, `1..32` (out-of-range falls back to `8`).           |
| `spectrum`   | `tick_ms`        | integer | `250`                | Meter cadence (4 fps), clamped to the `200` ms floor.             |
| `spectrum`   | `paused`         | boolean | `false`              | Freeze the last row without polling.                              |
| `spectrum`   | `tooltip`        | string  | none                 | Hover tooltip text; no tooltip when unset.                        |

### Modules (Phase B devices)

The first system modules consume broker `owner:iface@version` providers
served by the native `bitty-terminal.devices` component (Core CTX-1197 /
CTX-1201; bitty#2012 network, bitty#2017 bluetooth, bitty#2020 backlight +
idle-inhibit). Each resolves its short interface with an exact `^1.0`
requirement and `optional = true`: an ungranted or absent provider hides the
module and leaves the rest of the plan untouched. Read vs control never share
an interface, and every control call re-resolves its control interface, so a
narrowed grant takes effect without restart.

- `network` (timer, 3 s floor): link plus measured bandwidth
  (`wifi 8.0K/4.0K`); unmeasured rates are omitted. The ESSID renders only
  when the separately-granted `network.essid` sub-interface resolves
  (`wifi 8.0K/4.0K (Home)`); otherwise the key is absent and the rest is
  unaffected. The `network` region routes every button: left/middle show the
  link detail, and right asks the forward-looking `network.control` stub to
  toggle the radio. That interface is not declared in `[services.required]`
  and no provider ships in 0.0.26, so a live right click falls back to detail;
  the toggle path is mock-tested only.
  Options: `format` (`{icon}`, `{link}`, `{down}`, `{up}`, `{essid}`),
  `tick_ms` (clamped at or above 3 s), `tooltip` (hover; default the live
  link detail).
- `bluetooth` (timer, 5 s floor): radio state plus bonded-device counts
  (`bt on (1/2)`; alias/address rendering stays Lua-side). Read-only by
  default: the bonded-device list is the hover tooltip and the `detail` click
  fallback. With
  `toggle = true` and the `bluetooth.control` head granted, the click flips
  power via `set_power` only; deny defaults to the read-only render.
  Options: `format` (`{icon}`, `{status}`, `{connected}`, `{total}`, `{powered}`),
  `tick_ms` (at or above 5 s), `tooltip`, `toggle`.
- `backlight` (timer, 5 s floor): brightness (`75%`). The click steps by
  `step` percent points (default `10`) via `backlight.control`/`set_step`
  only. An unpermitted attempt reports `E_NOT_PERMITTED` host-side and the
  click degrades to a notification (DEC-0115: never retries, never escalates,
  never setuid). Without the control head the module is read-only.
  Options: `format` (`{pct}`), `tick_ms` (at or above 5 s), `tooltip`,
  `step` (`-100..100`).
- `idle` (timer, 5 s floor): inhibit state (`inhibit:on` / `inhibit:off`;
  the activated/deactivated glyphs stay config-side via `on_text` /
  `off_text`). The click flips inhibition via `idle.control`/`set` only when
  that head is granted; a denied toggle degrades to a notification.
  Options: `tick_ms` (at or above 5 s), `tooltip`, `on_text`, `off_text`.

Manifest activation (CTX-1226, post-SDK#152): the device heads
(`platform.network.read`, `platform.essid.read`,
`platform.bluetooth.read/.control`, `platform.backlight.read/.control`,
`platform.idle.read/.control`) are requested in `[capabilities]` (read heads
plus each control head for the toggle/step variants) alongside the matching
`[services.required]` broker entries, so the modules render once the host
grants them and hide fail closed otherwise. No Lua change was needed.

### Modules (Phase B sensors)

Sensor modules negotiate their provider (`bitty.services.get` with an
explicit `{ version = "^1.0", optional = true }`, inside pcall), poll one
sample per tick, and hide fail closed when the provider is absent, ungranted,
stale past the horizon, revoked, or malformed — a hidden sensor never hides
the bar. Thresholds and icon buckets evaluate Lua-side; the provider sends
raw numbers and states only:

| Module    | Option     | Type    | Default                | Notes                                                            |
| --------- | ---------- | ------- | ---------------------- | ---------------------------------------------------------------- |
| `cpu`     | `format`   | string  | `"{total}%"`           | Keys: `{icon}`, `{total}`, `{total_pct}` (rounded).              |
| `cpu`     | `warning`  | number  | `80`                   | At-or-above reads `warning`; needs `warning` < `critical`.       |
| `cpu`     | `critical` | number  | `90`                   | At-or-above reads `critical`.                                    |
| `cpu`     | `tick_ms`  | integer | `2000`                 | Poll cadence at the provider ceiling; `1000` ms floor.           |
| `cpu`     | `tooltip`  | string  | none                   | Hover detail: `CPU 42% (8 cores)` by default.                    |
| `memory`  | `format`   | string  | `"{pct}%"`             | Keys: `{icon}`, `{pct}`, `{used}`, `{total}` (GiB), swap.        |
| `memory`  | `warning`  | number  | `80`                   | Same hot direction as `cpu`.                                     |
| `memory`  | `critical` | number  | `90`                   | Same hot direction as `cpu`.                                     |
| `memory`  | `tick_ms`  | integer | `2000`                 | Poll cadence at the provider ceiling; `1000` ms floor.           |
| `memory`  | `tooltip`  | string  | none                   | Hover detail: `Memory 5/8 GiB (63%)`, plus swap when reported.   |
| `battery` | `format`   | string  | `"{icon} {capacity}%"` | Keys: `{icon}`, `{capacity}`, `{state}`.                         |
| `battery` | `warning`  | number  | `30`                   | At-or-below (discharging only) reads `warning`.                  |
| `battery` | `critical` | number  | `15`                   | At-or-below (discharging only) reads `critical`.                 |
| `battery` | `tick_ms`  | integer | `5000`                 | Poll cadence at the provider ceiling; `1000` ms floor.           |
| `battery` | `tooltip`  | string  | none                   | Hover detail: `Battery 63% discharging`, plus `W` and time left. |

With `icons = "ascii"`, battery icons are five ASCII buckets by capacity
(`[    ]` through `[====]`) with a `+` mark while charging. The `pua` and
`nerd` maps swap in native charging/discharging ladders; `battery_full` is
the same glyph as the top ladder rung, not a separate glyph. Only a
discharging battery alarms on low capacity; `full`, `charging`, `plugged`,
and `unknown` render the icon with the default presentation. Bar visibility
stays workspace-driven (a lone workspace still hides the bar unless
`show_single` is set); sensor-only plans inherit that rule.

**Activation (landed, CTX-1226).** The manifest declares `[services.required]`
for `system.cpu`/`system.memory`/`system.battery` at `^1.0` (plus the device
and audio provider interfaces at their Lua version requirements), the
`platform.cpu-read`, `platform.memory-read`, and `platform.battery-read`
heads, and `[settings]` entries for every key this plugin reads, so the
modules render on a live host once granted and hide fail closed without
grants (`tests/activation.test.ts` proves negotiate → grant → poll → render
per family plus the ungranted-hides negative). One v1 limit remains: the
per-module option collections have no table form in the settings contract,
so option tables read as module defaults until table settings land (pure
option logic is unchanged and covered by the pure suites).

A JSON settings array/object crosses the bridge into Lua as an indexable value
(not a plain table), so module lists and per-module options are read through that
indexable surface.

**Cadence (Phase A, bar#17).** `bitty.timers.create` is one-shot and creation
is valid only during activation (ADR 0009 LUA-OQ-12). The chassis pre-arms a
bounded chain of one-shot ticks per timer module at multiples of the module
cadence (clamped to the rate-policy floor) while the window is open, sharing
the host timer budget evenly (`M.chain_ticks`, at least two repeats per
module); every tick re-polls providers and re-renders, so repeated advances
repaint with fresh values and no handler violation is recorded. The first
tick additionally re-arms one single tick optimistically, so the arm path
needs no bar change when repeating timers land. Hidden bars arm nothing
(pause-on-hidden); past the activation window (e.g. `config.reloaded`) the
live chain is kept and only an immediate re-render is issued.

### Scratchpad indicator

The window scratchpad slot is window-global (at most one parked panel), so
every row of one `bitty.workspace.list()` result carries the same
`scratchpad_count` (`0`/`1`) and `scratchpad_occupied` snapshot (Core CTX-0954,
bitty PR #1671). The bar reads that snapshot tolerantly (the highest valid
count wins, any presence flag wins; absent or invalid fields read as empty)
and appends the `[scratchpad]` suffix after the capsule list while the slot is
occupied. The count rides the state and is shown only when it exceeds the
single-slot ceiling (`[scratchpad:N]`; never on current hosts, where presence
alone carries the `0`/`1`). Without an occupied slot the capsule list has no
scratchpad segment.

- The indicator is presentation only: it is never clickable and queues no
  request. Occupancy arrives under the existing `workspace.read` grant (the
  same `workspace.list()` rows); no panel capability is requested or
  consulted, and no new event family is needed: Core fires the existing
  `workspace.changed` on a put/take flip, which the bar already re-renders
  from.
- An occupied slot forces the bar visible even with a lone workspace; an
  empty slot keeps the Core hide-lone behavior. `show = false` still hides
  everything.
- Hosts without the CTX-0954 surface omit both fields, so the bar renders
  without the indicator (fail closed).

### Capabilities

`ui.rich` (mount and update the band), `ui.overlay` (mount the
presentation-only overlay tooltip; no `ui.overlay.focus`, so no input capture),
`workspace.read` (`list` and the `workspace.*` events),
`workspace.control` (`focus` for clicks and wheel cycling), and
`platform.notify` (the explicit `detail` notification fallback and control
denials; hover never uses it), plus
the 14 Phase B heads: `platform.cpu-read`/`memory-read`/`battery-read`
(sensor providers), `platform.network.read`/`essid.read`,
`platform.bluetooth.read/.control`, `platform.backlight.read/.control`,
`platform.idle.read/.control` (device providers, read never implying
control), and `audio.state.read`/`state.control`/`spectrum` (audio monitor).
Without `workspace.control` the bar still renders and capsule clicks/wheel
fail closed; without `platform.notify` the detail fallback fails closed.
Device-module control clicks (`bluetooth-toggle`, `backlight-step`,
`idle-toggle`) each call exactly one control method on their own control
interface and only while that interface resolves; a denied call degrades to a
notification and never retries.

The audio modules negotiate the `audio.state@1.0.0`, `audio.control@1.0.0`,
and `audio.spectrum@1.0.0` broker interfaces optionally: without the
`audio.state.read`, `audio.state.control`, and `audio.spectrum` heads the
modules hide (fail closed). Those heads are declared in the manifest since
the SDK#152 closed-set parity (CTX-1226); the matching `[services.required]`
entries supply the host negotiation versions.

### Known host gaps

Gaps in the current host and provider set, not in this plugin:

- True group alignment and hover detail require Core #2411 (band anchors and
  bounded hover dispatch, targeted for the 0.0.26 train via PR #2423). On an
  older host the
  `anchor` and `on_hover` keys are ignored: the groups flow left-to-right and
  no tooltip appears, while clicks and wheel steps keep working. `ui.overlay`
  is still requested so a host that ignores hover mounts the block unused;
  hover fails closed if the grant is denied.
- The 0.0.26 audio provider reports no source (microphone) level/mute and
  exposes no source control, so the `microphone` module hides and its
  commands fail closed until that provider surface lands.
- `network.control` is a forward-looking stub: not declared in
  `[services.required]`, no provider ships in 0.0.26, and only the mock
  harness exercises the toggle path, so the live right click degrades to the
  link detail.
- Band painting ignores `fg`, `bg`, and `bold`. The active capsule stays
  identifiable through the `*` mark.
- Plugin bands reserve no exclusive zone. They overlay the edge content row
  instead of reflowing the grid the way the Core band did.
- An empty (hidden) band still takes a stacking index on its edge.
- Activation is lazy: the plugin activates on its first declared event or
  command, so `show_single = true` takes effect after the first workspace event.
- While Core still draws its own workspaceline, set `workspace.show_bar = false`
  to avoid two bars.

## Layout

| Path                          | Purpose                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `bitty-plugin.toml`           | Static manifest: identity, compatibility, capabilities, and lazy triggers.   |
| `lua/bar/init.lua`            | Entry point evaluated once per activation; pure functions exported on `M`.   |
| `tests/harness.ts`            | Runs `init.lua` in a Lua 5.4 VM (wasmoon) against the SDK mock host.         |
| `tests/core-workspaceline.ts` | Reference model of the retired Core workspaceline (bitty@55f9d336).          |
| `tests/bar.test.ts`           | Behavior, capsule label, and capability-gate tests.                          |
| `tests/modules.test.ts`       | Declarative module chassis tests (order, cadence, cadence policy, fallback). |
| `tests/devices.test.ts`       | Phase B device module tests (network, bluetooth, backlight, idle).           |
| `tests/audio.test.ts`         | Audio module tests (pulseaudio state/control, spectrum meter, rate bounds).  |
| `tests/icons.test.ts`         | Icon maps, ASCII fallback, format composition, display-cell width.           |
| `tests/buttons.test.ts`       | Per-button click/wheel bindings for every region-aware module.               |
| `tests/hover.test.ts`         | Anchored group shape, unique hover regions, overlay tooltip lifecycle.       |
| `justfile`                    | Quality gates with pinned tool versions.                                     |

## Development

```sh
just install   # bun install --frozen-lockfile; the only network step
just check     # manifest lint, Lua 5.1 grammar parse + control, bun tests
```

`just manifest` runs the authoritative `bitty-plugin-lint` from
[bitty-plugin-sdk](https://github.com/bitty-terminal/bitty-plugin-sdk). `just
lua` parses the entry point with the pinned `luaparse` (Lua 5.1 grammar) and
`just lua-control` proves the parser rejects invalid input. `just test` runs the
entry point against the SDK `MockHost`, which owns capability gates, the
activation registration window, scene-node validation, command argument
schemas, event declarations, and the bounded workspace request queue; the
behavior suites cover capsule label modes, click targets, scratchpad, modules,
and capability gates.

## Security

Report vulnerabilities through the process in the umbrella project's security
policy rather than a public issue. The plugin requests no filesystem, process,
network, clipboard, or terminal-input authority.
