# Bitty Unified Bar repository guidance

## Repository and authority

- This is the independent `bar` repository. Its canonical remote is
  <https://github.com/bitty-terminal/bar>.
- The Bitty umbrella directory and [`bitty-plugins`](https://github.com/bitty-terminal/bitty-plugins) directory are grouping only;
  neither owns this repository's Git or CarryCtx state.
- Enter this repository before running Git, CarryCtx, validation, or toolchain
  commands.
- [bitty-docs](https://github.com/bitty-terminal/bitty-docs) and [bitty-plugins-docs](https://github.com/bitty-terminal/bitty-plugins-docs) are the canonical sources for plugin
  architecture, API, security, packaging, compatibility, and public-behavior
  contracts. This repository must not invent capabilities, lifecycle
  semantics, or release policy.
- The project is pre-implementation. Repository existence, a manifest, or a
  proposed file tree is not evidence of usable plugin behavior.

## Plugin identity and scope

- Plugin id: `bitty-terminal.bar` (manifest `plugin.id`), repository
  `bar`, Lua module `lua/bar/`.
- Purpose: Consolidated workspace-bar, tabs, and statusline presentation over
  generic chrome insets (ADR-0014).
- Boundary: Core provides mechanism only (events, insets, click routing); presentation
  is owned entirely by this plugin.

## Toolchain and gates

- Run `just install` once to install pinned dev dependencies.
- Run `just check` to validate manifest and Lua grammar.
