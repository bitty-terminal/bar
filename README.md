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

| Key              | Type    | Default    | Replaces (retired Core key) | Notes                                   |
| ---------------- | ------- | ---------- | --------------------------- | --------------------------------------- |
| `show`           | boolean | `true`     | `workspace.show_bar`        | Live on `config.reloaded`.              |
| `edge`           | string  | `"bottom"` | `workspace.bar.edge`        | `"top"` or `"bottom"`; next generation. |
| `show_single`    | boolean | `false`    | none (Core always hid it)   | Live on `config.reloaded`.              |
| `name_max_chars` | integer | `32`       | none (Core fixed at 32)     | `1..32`; live on `config.reloaded`.     |
| `modules_left`   | array   | `["workspaces"]` | none                 | Ordered module names; live.             |
| `modules_center` | array   | `[]`       | none                        | Rendered after left; live.              |
| `modules_right`  | array   | `[]`       | none                        | Rendered after center; live.            |

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

A bad spec never hides the bar: an unknown module name, a non-name entry, a
non-list group, or a plan that resolves to nothing falls back to the default
plan (`modules_left = ["workspaces"]`).

Clicks dispatch **registered commands only** — `on-click` shell strings are not a
vehicle and can never reach the scene. `on_click` binds a command id; a module
with detail text but no command binds `bitty-terminal.bar:detail`, which shows
the text as a notification (the v1 tooltip→notify fallback via
`bitty.notify.show`).

Per-module options live in a settings collection named after the module:

| Module  | Option    | Type    | Default   | Notes                                             |
| ------- | --------- | ------- | --------- | ------------------------------------------------- |
| `clock` | `format`  | string  | `"%H:%M"` | `os.date` format.                                 |
| `clock` | `tick_ms` | integer | `60000`   | Timer cadence, clamped to the `1000` ms floor.    |
| `clock` | `tooltip` | string  | none      | Detail text shown via the `detail` notification.  |

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
`platform.notify` the detail fallback fails closed.

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

| Path                          | Purpose                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `bitty-plugin.toml`           | Static manifest: identity, compatibility, capabilities, and lazy triggers. |
| `lua/bar/init.lua`            | Entry point evaluated once per activation; pure functions exported on `M`. |
| `tests/harness.ts`            | Runs `init.lua` in a Lua 5.4 VM (wasmoon) against the SDK mock host.       |
| `tests/core-workspaceline.ts` | Reference model of the retired Core workspaceline (bitty@55f9d336).        |
| `tests/bar.test.ts`           | Behavior, Core parity, and capability-gate tests.                          |
| `tests/modules.test.ts`       | Declarative module chassis tests (order, cadence, cadence policy, fallback). |
| `justfile`                    | Quality gates with pinned tool versions.                                   |

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
