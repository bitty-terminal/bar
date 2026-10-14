# Unified Bar

Consolidated workspace-bar, tabs, and statusline presentation over generic chrome insets.

[ADR-0014](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/decisions/adrs/ADR-0014-workspace-core-presentation-plugins.md)
keeps Workspace as a Core mechanism and moves every workspace presentation
into plugins. This plugin's first module is the workspace bar: it renders what
the retired Core workspaceline drew, over the Plugin API v1 surface only.

> Status: pre-implementation. Behavior is verified against the
> bitty-plugin-sdk mock host (pinned by commit), not against a released host.
> Tabs and statusline modules are not implemented yet.

## Workspace bar

- One pill per workspace, `{stable-id}:{name}`, joined by single spaces and
  followed by ` ({count})`. The id is the stable workspace seq from
  `bitty.workspace.list()` (Core renders `slot.seq`), so closing a workspace
  never renumbers the survivors. The active pill carries `*`, bold, and the
  `accent` theme token. An empty workspace list renders `—` (fail closed).
- Names are cut to 32 characters (or `name_max_chars`); the whole line is
  bounded to 1024 UTF-8 bytes, cut on a character boundary.
- A lone workspace hides the bar unless `show_single = true`.
- Clicking an inactive pill runs `bitty-terminal.bar:focus { id }`, which
  queues `bitty.workspace.focus(id)` by stable id. The active pill,
  separators, the count suffix, unknown or stale ids, and non-integer ids
  queue nothing.
- The bar re-renders from `bitty.workspace.list()` on every `workspace.*`
  event and re-reads settings on `config.reloaded`.

### Settings

Keys live under the plugin namespace (`plugins."bitty-terminal.bar"`); absent
or invalid values fall back to the default.

| Key              | Type    | Default          | Replaces (retired Core key) | Notes                                   |
| ---------------- | ------- | ---------------- | --------------------------- | --------------------------------------- |
| `show`           | boolean | `true`           | `workspace.show_bar`        | Live on `config.reloaded`.              |
| `edge`           | string  | `"bottom"`       | `workspace.bar.edge`        | `"top"` or `"bottom"`; next generation. |
| `show_single`    | boolean | `false`          | none (Core always hid it)   | Live on `config.reloaded`.              |
| `name_max_chars` | integer | `32`             | none (Core fixed at 32)     | `1..32`; live on `config.reloaded`.     |
| `modules_left`   | array   | `["workspaces"]` | none                        | Ordered module names; live.             |
| `modules_center` | array   | `[]`             | none                        | Rendered after left; live.              |
| `modules_right`  | array   | `[]`             | none                        | Rendered after center; live.            |

`edge` applies on the next plugin generation because `bitty.ui.mount` is valid
only during activation and v1 has no unmount or move.

### Modules (declarative)

Settings declare an ordered module list, modeled on Waybar's
`modules-left/center/right`. Phase A renders the three groups left-to-right into
one inset row: a true center/right alignment needs a Spacer/flex node that v1
does not expose (Phase C), so the groups keep their declarative order.

Each listed name resolves against the in-plugin module registry. A module
renders atoms `{ text, bold?, fg?, on_click?, tooltip? }` from local data or a
broker-provided interface and refreshes on its own cadence:

- `workspaces` (event module): the Core-parity pill strip; refreshes from the
  `workspace.*` events — no timer where events suffice.
- `clock` (timer module): `os.date` with a per-module `format` (a restricted,
  zero-grant local source); refreshes on `tick_ms`.
- `cpu` (timer module, Phase B): aggregate CPU utilization from the broker
  `system.cpu@1.0.0` provider (`bitty-terminal.sensors`); polls at the 2 s
  provider ceiling.
- `memory` (timer module, Phase B): memory and swap utilization from
  `system.memory@1.0.0`; polls at the 2 s ceiling.
- `battery` (timer module, Phase B): capacity and charge state from
  `system.battery@1.0.0`; polls at the 5 s ceiling.

A bad spec never hides the bar: an unknown module name, a non-name entry, a
non-list group, or a plan that resolves to nothing falls back to the default
plan (`modules_left = ["workspaces"]`).

Clicks dispatch **registered commands only** — `on-click` shell strings are not a
vehicle and can never reach the scene. `on_click` binds a command id; a module
with detail text but no command binds `bitty-terminal.bar:detail`, which shows
the text as a notification (the v1 tooltip→notify fallback via
`bitty.notify.show`).

Per-module options live in a settings collection named after the module:

| Module  | Option    | Type    | Default   | Notes                                            |
| ------- | --------- | ------- | --------- | ------------------------------------------------ |
| `clock` | `format`  | string  | `"%H:%M"` | `os.date` format.                                |
| `clock` | `tick_ms` | integer | `60000`   | Timer cadence, clamped to the `1000` ms floor.   |
| `clock` | `tooltip` | string  | none      | Detail text shown via the `detail` notification. |

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
  unaffected. Never clickable: no control wiring exists or is wanted here.
  Options: `format` (`{link}`, `{down}`, `{up}`, `{essid}`), `tick_ms`
  (clamped at or above 3 s), `tooltip`.
- `bluetooth` (timer, 5 s floor): radio state plus bonded-device counts
  (`bt on (1/2)`; alias/address rendering stays Lua-side). Read-only by
  default: the bonded-device list rides the `detail` tooltip fallback. With
  `toggle = true` and the `bluetooth.control` head granted, the click flips
  power via `set_power` only; deny defaults to the read-only render.
  Options: `format` (`{status}`, `{connected}`, `{total}`, `{powered}`),
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

Manifest remainder: the device heads (`platform.network.read`,
`platform.essid.read`, `platform.bluetooth.read/.control`,
`platform.backlight.read/.control`, `platform.idle.read/.control`) must be
requested in `[capabilities]` (read heads plus each control head only for the
toggle/step variants) once the SDK closed set admits them — the pinned SDK
currently rejects them with `capabilities.unknown`. No Lua change is needed
when they land.

### Modules (Phase B sensors)

Sensor modules negotiate their provider (`bitty.services.get` with an
explicit `{ version = "^1.0", optional = true }`, inside pcall), poll one
sample per tick, and hide fail closed when the provider is absent, ungranted,
stale past the horizon, revoked, or malformed — a hidden sensor never hides
the bar. Thresholds and icon buckets evaluate Lua-side; the provider sends
raw numbers and states only:

| Module    | Option     | Type    | Default                | Notes                                                       |
| --------- | ---------- | ------- | ---------------------- | ----------------------------------------------------------- |
| `cpu`     | `format`   | string  | `"{total}%"`           | Template keys: `{total}`, `{total_pct}` (rounded integer).  |
| `cpu`     | `warning`  | number  | `80`                   | At-or-above reads `warning`; needs `warning` < `critical`.  |
| `cpu`     | `critical` | number  | `90`                   | At-or-above reads `critical`.                               |
| `cpu`     | `tick_ms`  | integer | `2000`                 | Poll cadence at the provider ceiling; `1000` ms floor.      |
| `cpu`     | `tooltip`  | string  | none                   | Default detail: `CPU 42% (8 cores)`.                        |
| `memory`  | `format`   | string  | `"{pct}%"`             | Keys: `{pct}`, `{used}`, `{total}` (GiB), swap triple.      |
| `memory`  | `warning`  | number  | `80`                   | Same hot direction as `cpu`.                                |
| `memory`  | `critical` | number  | `90`                   | Same hot direction as `cpu`.                                |
| `memory`  | `tick_ms`  | integer | `2000`                 | Poll cadence at the provider ceiling; `1000` ms floor.      |
| `memory`  | `tooltip`  | string  | none                   | Default: `Memory 5/8 GiB (63%)`, plus swap when reported.   |
| `battery` | `format`   | string  | `"{icon} {capacity}%"` | Keys: `{icon}`, `{capacity}`, `{state}`.                    |
| `battery` | `warning`  | number  | `30`                   | At-or-below (discharging only) reads `warning`.             |
| `battery` | `critical` | number  | `15`                   | At-or-below (discharging only) reads `critical`.            |
| `battery` | `tick_ms`  | integer | `5000`                 | Poll cadence at the provider ceiling; `1000` ms floor.      |
| `battery` | `tooltip`  | string  | none                   | Default: `Battery 63% discharging`, plus `W` and time left. |

Battery icons are five ASCII buckets by capacity (`[    ]` through
`[====]`) with a `+` mark while charging. Only a discharging battery alarms
on low capacity; `full`, `charging`, `plugged`, and `unknown` render the
icon with the default presentation. Bar visibility stays workspace-driven
(a lone workspace still hides the bar unless `show_single` is set);
sensor-only plans inherit that rule.

**Activation follow-up (not in this change).** Rendering against the live
host additionally needs manifest declarations the pinned SDK linter does not
accept yet (`[services.required]` for `system.cpu`/`system.memory`/
`system.battery` at `^1.0`, the `platform.cpu-read`, `platform.memory-read`,
and `platform.battery-read` heads, and `[settings]` entries for every key
this plugin reads). Until the SDK models those surfaces, the modules ship
fail-closed: they render under the mock host and hide on a live host
without grants. The exact delta is tracked in the Phase B follow-up under
bitty-plugins#86.

A JSON settings array/object crosses the bridge into Lua as an indexable value
(not a plain table), so module lists and per-module options are read through that
indexable surface.

**Cadence (Phase A).** `bitty.timers.create` is one-shot and creation is valid
only during activation (ADR 0009 LUA-OQ-12). The chassis arms exactly one timer
per timer module at the module cadence (clamped to the rate-policy floor) and
re-arms after a tick; on a host without repeating timers the re-arm fails closed,
so a tick fires once and no handler violation is recorded. The arm path needs no
bar change when repeating timers land. Hidden bars arm nothing (pause-on-hidden).

### Scratchpad indicator

The window scratchpad slot is window-global (at most one parked panel), so
every row of one `bitty.workspace.list()` result carries the same
`scratchpad_count` (`0`/`1`) and `scratchpad_occupied` snapshot (Core CTX-0954,
bitty PR #1671). The bar reads that snapshot tolerantly (the highest valid
count wins, any presence flag wins; absent or invalid fields read as empty)
and appends ` [scratchpad]` after the ` ({count})` suffix while the slot is
occupied. The count rides the state and is shown only when it exceeds the
single-slot ceiling (` [scratchpad:N]`; never on current hosts, where presence
alone carries the `0`/`1`). Without an occupied slot the painted text equals
the Core workspaceline text exactly.

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

`ui.rich` (mount and update the band), `workspace.read` (`list` and the
`workspace.*` events), `workspace.control` (`focus` for clicks), and
`platform.notify` (the tooltip→notify `detail` fallback). Without
`workspace.control` the bar still renders and pill clicks fail closed; without
`platform.notify` the detail fallback fails closed. Device-module control
clicks (`bluetooth-toggle`, `backlight-step`, `idle-toggle`) each call exactly
one control method on their own control interface and only while that
interface resolves; a denied call degrades to a notification and never
retries.

### Known host gaps

Gaps in the current host, not in this plugin:

- The Core host parses `on_click` into the mounted scene but does not yet
  route band clicks to the bound command, so clicking does nothing on a live
  host. The mock host is used to exercise the command path.
- Band painting ignores `fg`, `bg`, and `bold`. The active pill stays
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
| `tests/bar.test.ts`           | Behavior, Core parity, and capability-gate tests.                            |
| `tests/modules.test.ts`       | Declarative module chassis tests (order, cadence, cadence policy, fallback). |
| `tests/devices.test.ts`       | Phase B device module tests (network, bluetooth, backlight, idle).           |
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
parity tests compare every painted column with the Core reference model.

## Security

Report vulnerabilities through the process in the umbrella project's security
policy rather than a public issue. The plugin requests no filesystem, process,
network, clipboard, or terminal-input authority.
