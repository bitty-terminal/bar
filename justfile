# Quality gates for Unified Bar (bitty-terminal.bar).
#
# Generated from bitty-plugin-template. Dependencies live in package.json and
# are locked in bun.lock; `just install` materializes them. The manifest gate
# runs the authoritative SDK linter (bitty-plugin-lint, pinned by commit), not
# a vendored re-implementation. Every gate below runs offline once install has
# completed.

# Pinned parser version; keep identical to the luaparse devDependency in
# package.json.
luaparse_pin := "0.3.1"

# Pinned metadata gates. `bunx --bun <tool>@<pin>` keeps each gate on exactly
# the version its sibling plugins use, without adding a second dependency set
# to package.json.
prettier_version := "3.9.6"
markdownlint_version := "0.23.1"

# List available recipes.
default:
    @just --list

# Check formatting of all files with Prettier (.prettierignore scopes it to
# tracked sources; `--ignore-unknown` skips Lua and lockfiles).
fmt-check:
    bunx --bun prettier@{{prettier_version}} --check . --ignore-unknown

# Lint all Markdown sources with markdownlint-cli2 (.markdownlint-cli2.jsonc).
markdownlint:
    bunx --bun markdownlint-cli2@{{markdownlint_version}}

# Fail when the repository metadata that every checkout needs is missing or
# unparsable.
metadata:
    test -s README.md && test -s AGENTS.md && test -s repo.toml
    test -s .carryctx/config.toml
    python3 -c 'import tomllib; from pathlib import Path; [tomllib.loads(p.read_text()) for p in [Path("repo.toml"), Path(".carryctx/config.toml")]]'

# Fail when build output, databases, or worktree scratch is staged or would be
# picked up by `git add`.
hygiene:
    #!/usr/bin/env bash
    set -euo pipefail
    bad=0
    while IFS= read -r -d '' f; do
        case "$f" in
            *.sqlite|*.db|*.zst|*.tar|*.tar.gz|*.tgz|node_modules/*|target/*|dist/*|.worktrees/*)
                echo "unexpected artifact tracked: $f" >&2; bad=1 ;;
        esac
    done < <(git ls-files -z --cached --others --exclude-standard)
    test "$bad" -eq 0

# Fail on hardcoded host paths in any tracked or untracked source file.
paths:
    #!/usr/bin/env bash
    set -euo pipefail
    pattern='(/hom''e/|/Use''rs/|/mn''t/[A-Za-z]|[A-Za-z]:[\\/]Use''rs[\\/])'
    found=0
    while IFS= read -r -d '' f; do
        if grep -nEI "$pattern" "$f"; then found=1; fi
    done < <(git ls-files -z --cached --others --exclude-standard)
    if [ "$found" -ne 0 ]; then
        echo 'hardcoded host path detected (portable-path gate)' >&2
        exit 1
    fi
    echo 'portable-path gate passed'

# Install pinned dev dependencies from bun.lock. This is the only gate step
# that may use the network; install once, then `just check` is offline.
install:
    bun install --frozen-lockfile

# Fail closed when dependencies are absent, so a gate never silently fetches
# from the network. Run `just install` first.
deps:
    @test -d node_modules || { echo "dependencies are not installed; run 'just install'" >&2; exit 1; }

# Validate bitty-plugin.toml with the authoritative SDK linter (R-SDK-2),
# pinned by commit in package.json and bun.lock. The manifest schema is owned
# by bitty-docs, not by this repository.
manifest: deps
    @test -x node_modules/.bin/bitty-plugin-lint || { echo "bitty-plugin-lint is not installed; run 'just install'" >&2; exit 1; }
    bun run bitty-plugin-lint bitty-plugin.toml

# Parse the Lua entry point with a pinned Lua 5.1 grammar parser.
lua: deps
    bunx --bun luaparse@{{luaparse_pin}} --quiet --file lua/bar/init.lua

# Fail-closed control for the `lua` gate: the same pinned parser must reject an
# invalid snippet. `luaparse` exits 0 on empty input, so without this control a
# recipe that lost its `--file` argument would silently pass rather than parse
# the generated entry point.
lua-control: deps
    @! bunx --bun luaparse@{{luaparse_pin}} --quiet --code 'local ='

# Run the workspace bar behavior and Core-parity tests: `lua/bar/init.lua`
# executes in a pinned Lua 5.4 VM (wasmoon) against the pinned SDK mock host,
# which owns every capability, registration, scene, and schema check.
test: deps
    bun test

# Aggregate gate run locally and in CI (after `just install`).
check: fmt-check markdownlint metadata hygiene paths manifest lua lua-control test
