# Unified Bar

Consolidated workspace-bar, tabs, and statusline presentation over generic chrome insets.

This repository was generated from
[bitty-plugin-template](https://github.com/bitty-terminal/bitty-plugin-template).
It is a minimal Bitty plugin package: a static manifest, one Lua entry point,
and a CI quality gate.

> Status: pre-implementation. The Bitty plugin host is still landing, and the
> entry point below follows the frozen Plugin API v1 generation pipeline
> (bitty-plugin-sdk #109, re-wired by SDK #118, host parity from bitty #1303
> as re-wired by bitty #1391: `keymaps`/`tasks`/`services`
> WIRED, `env` DEFERRED with typed `E_NOT_IMPLEMENTED`,
> `process.spawn` v1-OUT). `just check` validates the manifest with the
> authoritative `bitty-plugin-lint` from
> [bitty-plugin-sdk](https://github.com/bitty-terminal/bitty-plugin-sdk)
> (pinned by commit in `package.json` and `bun.lock`) and parses the Lua entry
> point, with a fail-closed parser control so the parse cannot silently pass.
> Entry layout: the package root holds `bitty-plugin.toml` (the discovery
> unit) and the `lua/` module root (the `require` root). The host resolves the
> fixed `init.lua` entry as `lua/<module>/init.lua` (or `lua/init.lua`) and
> executes it once per activation; finding the manifest (discovery) alone does
> not prove the entry runs (activation), and no package-root forwarder is
> needed. The template's host-integration gate checks both phases separately.

## Layout

| Path                       | Purpose                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bitty-plugin.toml`        | Static manifest: identity, compatibility, capability requests, and lazy triggers.                      |
| `lua/bar/init.lua`         | Entry point evaluated once per activation; every resource it creates belongs to the plugin generation. |
| `package.json`             | Pinned dev dependencies: the authoritative `bitty-plugin-lint` (by commit) and `luaparse`.             |
| `bun.lock`                 | Locked dependency graph installed by `just install`.                                                   |
| `justfile`                 | Quality gates with pinned tool versions.                                                               |
| `.github/workflows/ci.yml` | CI gate with a read-only token and SHA-pinned actions.                                                 |

## Development

Install the pinned dependencies once, then run the same gate CI runs:

```sh
just install   # bun install --frozen-lockfile; the only network step
just check
```

`just install` materializes `bitty-plugin-lint` (bitty-plugin-sdk, pinned by
commit in `package.json` and `bun.lock`) and `luaparse`; every gate then runs
offline. `just manifest` validates `bitty-plugin.toml` with the authoritative
SDK linter against the accepted contract in bitty-docs
`docs/specifications/plugin-platform-rfc.md` (file name, identity,
compatibility, capability closed set, lazy triggers, hard limits). `just lua`
runs the pinned `luaparse` 0.3.1 CLI over the entry point; `just lua-control`
feeds the same parser an invalid snippet and requires rejection, so a recipe
that stopped reading the entry point cannot pass silently. `just check` runs
all three.

## Capabilities

Capabilities are deny by default: a request absent from `[capabilities]` is
denied, identifiers come from a closed set, and there is no allow-all entry.
Request the narrowest identifier the plugin actually uses, one at a time.
High-risk identifiers (`terminal.raw-read`, `terminal.input.all`,
`ui.protocol-register`, `debug.control`, `runtime.plugin-manage`, and similar)
trigger distinct consent and should not be added without a reviewed need.

Filesystem access is declared as structured requests with explicit patterns:

```toml
[[capabilities.filesystem]]
access = "read"
paths = ["~/Documents/**/*.md"]
```

## API contract

The `bitty` namespace used by `init.lua` is the accepted Plugin API v1 surface
as frozen by the SDK generation pipeline (bitty-plugin-sdk #109, re-wired by
SDK #118, host parity from bitty #1303 as re-wired by bitty #1391). The
authoritative Lua bindings and type definitions are the
SDK `bitty.d.lua` (R-SDK-1); do not use surface that contract does not define.
`keymaps`, `tasks`, and `services` are WIRED on the current host (the example
provides and resolves `greeter` live); `env` is a DEFERRED typed stub that
fails closed with `E_NOT_IMPLEMENTED` (runtime), so its example call in
`init.lua` stays commented out. `process.spawn` is
v1-OUT and has no entry point.

## Before publishing

1. Add a `LICENSE` file and set `plugin.license` in `bitty-plugin.toml`.
2. Confirm `compat.bitty` and `compat.plugin-api` match the host releases you
   support.
3. Replace this README's status note once the plugin is functional and tested
   against a released host.
4. Keep the repository free of secrets, install scripts, and ambient
   authority.

## Security

Report vulnerabilities through the process in the umbrella project's security
policy rather than a public issue. This scaffold contains no credentials and no
install-time execution.
