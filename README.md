# Unified Bar

Consolidated workspace-bar, tabs, and statusline presentation over generic chrome insets.

[ADR-0014](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/decisions/adrs/ADR-0014-workspace-core-presentation-plugins.md)
keeps Workspace as a Core mechanism and moves every workspace presentation into
plugins. This plugin's first module is a Waybar-like workspace bar over the
Plugin API v1 surface.

> Status: pre-implementation. Behavior is verified against the bitty-plugin-sdk
> mock host (pinned by commit), not against a released host. Tabs and statusline
> modules are not implemented yet.

## Workspace bar

- One capsule per workspace, `[stable-id:name]`, joined by single spaces. The
  active capsule carries `*`; occupied workspaces carry `+` when
  `panel_count > 0`; and attention (`bell`, `activity`, or `exited`) carries
  `!`. The active capsule also uses the host `accent` and `background` theme
  tokens with bold text; occupied and attention capsules use restrained bold or
  `cursor` emphasis. Each capsule remains one styled `Text` atom.
- Names are cut to 32 characters (or `name_max_chars`); complete capsules are
  retained in stable numeric id order and the line is bounded to 1024 UTF-8
  bytes. A capsule is one clickable `Text` node, so its complete hit area keeps
  the existing click binding.
- A lone workspace hides the bar unless `show_single = true`.
- Clicking an inactive capsule runs `bitty-terminal.bar:focus { id }`, which
  queues `bitty.workspace.focus(id)` by stable id. The active capsule,
  separators, unknown or stale ids, and non-integer ids queue nothing.
- The bar re-renders from `bitty.workspace.list()` on every `workspace.*`
  event and re-reads settings on `config.reloaded`.

### Settings

Keys live under the plugin namespace (`plugins."bitty-terminal.bar"`); absent
or invalid values fall back to the default.

| Key              | Type    | Default    | Notes                                   |
| ---------------- | ------- | ---------- | --------------------------------------- |
| `show`           | boolean | `true`     | Live on `config.reloaded`.              |
| `edge`           | string  | `"bottom"` | `"top"` or `"bottom"`; next generation. |
| `show_single`    | boolean | `false`    | Live on `config.reloaded`.              |
| `name_max_chars` | integer | `32`       | `1..32`; live on `config.reloaded`.     |

Users customize these keys through the generic plugin TOML configuration at
`$XDG_CONFIG_HOME/bitty/plugins/bitty-terminal.bar.toml` (with the standard
`~/.config` fallback), for example:

```toml
[plugins."bitty-terminal.bar"]
edge = "top"
show_single = true
name_max_chars = 20
```

The plugin accepts only `top` and `bottom` today. Although Plugin API v1
accepts `left` and `right` as storage slots, the current Core host does not
paint vertical bands yet, so accepting those settings would produce an
invisible bar. Vertical capsules remain a host follow-up.

`edge` applies on the next plugin generation because `bitty.ui.mount` is valid
only during activation and v1 has no unmount or move.

### Capabilities

`ui.rich` (mount and update the band), `workspace.read` (`list` and the
`workspace.*` events), and `workspace.control` (`focus` for clicks). Without
`workspace.control` the bar still renders and clicks fail closed.

### Known host gaps

Gaps in the current host, not in this plugin:

- The Core host parses `on_click` into the mounted scene but does not yet route
  band clicks to the bound command, so clicking does nothing on a live host. The
  mock host is used to exercise the command path.
- The current host has no capsule style atom; active, occupied, and attention
  states use supported `Text` styling plus textual markers.
- `left` and `right` mounts are accepted and stored by Core but are not painted
  until vertical bands ship; the plugin intentionally rejects them and falls
  back to `bottom`.
- Plugin bands reserve no exclusive zone. They overlay the edge content row
  instead of reflowing the grid the way the Core band did.
- An empty (hidden) band still takes a stacking index on its edge.
- Activation is lazy: the plugin activates on its first declared event or
  command, so `show_single = true` takes effect after the first workspace event.
- While Core still draws its own workspaceline, set `workspace.show_bar = false`
  to avoid two bars.

## Layout

| Path                          | Purpose                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `bitty-plugin.toml`           | Static manifest, compatibility, capabilities, and lazy triggers.     |
| `lua/bar/init.lua`            | Entry point and pure capsule rendering helpers.                      |
| `tests/harness.ts`            | Lua 5.4 VM and SDK mock-host bridge.                                 |
| `tests/core-workspaceline.ts` | Reference model of the retired Core workspaceline bounds.            |
| `tests/bar.test.ts`           | Capsule states, bounds, clicks, edge settings, and capability gates. |
| `justfile`                    | Quality gates with pinned tool versions.                             |

## Development

```sh
just install   # bun install --frozen-lockfile; the only network step
just check     # manifest lint, Lua 5.1 grammar parse + control, bun tests
```

`just manifest` runs the authoritative `bitty-plugin-lint` from
[bitty-plugin-sdk](https://github.com/bitty-terminal/bitty-plugin-sdk).
`just lua` parses the entry point with the pinned `luaparse` (Lua 5.1 grammar)
and `just lua-control` proves the parser rejects invalid input. `just test` runs
the entry point against the SDK `MockHost`, which owns capability gates,
registration, scene validation, command schemas, events, and the bounded
workspace request queue.

## Security

Report vulnerabilities through the process in the umbrella project's security
policy rather than a public issue. The plugin requests no filesystem, process,
network, clipboard, or terminal-input authority.
