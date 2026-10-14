-- Entry point for Unified Bar (bitty-terminal.bar): the workspace bar and its
-- Waybar-style declarative module chassis (bitty-plugins#86, Phase A).
--
-- ADR-0014 keeps Workspace as a Core mechanism and moves every workspace
-- presentation into plugins. This file renders the presentation the retired
-- Core workspaceline drew (bitty-runtime `workspaceline_text`,
-- `workspaceline_hit_test`, `workspaceline_click`) over the Plugin API v1
-- surface only: `bitty.workspace.list/focus` (workspace.read /
-- workspace.control), the `workspace.*` events, `bitty.settings`,
-- `bitty.commands.register`, `bitty.timers.create`, `bitty.notify.show`, and
-- one `bitty.ui.mount` band. The authoritative bindings are the SDK
-- `bitty.d.lua` (R-SDK-1); nothing outside that contract is used, except the
-- capability-neutral `scratchpad_count` / `scratchpad_occupied` row fields
-- (Core CTX-0954) read tolerantly under the same `workspace.read` grant.
--
-- Phase A is the chassis, not the modules. Settings declare an ordered module
-- list (Waybar-style `modules_left`/`modules_center`/`modules_right`); each
-- module is a registry entry `{ name, kind, tick_ms, events, render(data) }`
-- that renders atoms from local data or a broker interface on its own cadence.
-- Clicks dispatch registered commands only and never shell out. System modules
-- (broker `owner:iface@version` providers) are Phase B; true centering
-- (`modules_center`), scroll bindings, real tooltips, and the tray need new
-- Core vehicles and are Phase C. No new Core API is introduced here.
--
-- The host evaluates this file once per plugin activation and owns every
-- resource created here for the lifetime of that generation. The code stays
-- inside the Lua 5.1 grammar (the `just lua` gate) and uses no `utf8` library.

local M = {}

local PLUGIN_ID = "bitty-terminal.bar"

-- Plugin-local command segments; the host qualifies them from the `[lazy]`
-- reservation in `bitty-plugin.toml`. Click bindings carry the qualified name.
local FOCUS_COMMAND_ID = "focus"
local DETAIL_COMMAND_ID = "detail"
M.FOCUS_COMMAND = PLUGIN_ID .. ":" .. FOCUS_COMMAND_ID
-- Tooltip-without-command fallback: the click shows the module's detail text
-- as a notification (`bitty.notify.show`) because v1 has no tooltip vehicle.
M.DETAIL_COMMAND = PLUGIN_ID .. ":" .. DETAIL_COMMAND_ID

-- Bounds mirrored from the retired Core workspaceline so the retirement is
-- behavior-preserving (bitty@55f9d336 `crates/bitty-runtime/src/runtime/workspaces.rs`).
M.NAME_MAX_CHARS = 32 -- WORKSPACE_NAME_MAX_CHARS (characters per pill name)
M.LINE_MAX_BYTES = 1024 -- WORKSPACELINE_MAX_CHARS (UTF-8 bytes, char-boundary cut)
M.MAX_WORKSPACES = 16 -- MAX_WORKSPACES (also the workspace.list row bound)

M.ACTIVE_MARK = "*"
M.SEPARATOR = " "
-- Fail-closed placeholder for an empty workspace list (U+2014 EM DASH).
M.EMPTY_PLACEHOLDER = "\226\128\148"
-- Theme token for the active pill; host-resolved, never a raw color.
M.ACTIVE_FG = "accent"

-- Accepted bar edges and the band slot each one mounts into.
M.EDGE_SLOTS = { top = "top", bottom = "bottom" }

-- Module-group settings keys (Waybar `modules-*`). Phase A renders left, then
-- center, then right into one inset row: a true center/right alignment needs a
-- Spacer/flex node (Phase C), so the groups keep their declarative order.
M.MODULE_GROUPS = { "modules_left", "modules_center", "modules_right" }
M.DEFAULT_MODULES_LEFT = { "workspaces" }
-- Modules are joined by a single space when more than one renders.
M.MODULE_GAP = " "

-- Per-module timer floor (ms). v1 `bitty.timers.create` is one-shot and
-- creation is activation-window-only (ADR 0009 LUA-OQ-12), so a repeating
-- per-module cadence is a 1.x addition; the floor keeps any single tick well
-- inside the host timer rate policy, and the arm path re-arms optimistically
-- so a host with repeating timers needs no bar change.
M.MIN_TICK_MS = 1000

-- Scratchpad indicator (W-104 R2-consumer, DEC-W104-1): the window scratchpad
-- slot is window-global (at most one parked panel), so every row of one
-- `bitty.workspace.list()` result carries the same `scratchpad_count`
-- (`0`/`1`) and `scratchpad_occupied` snapshot under the existing
-- `workspace.read` grant (Core CTX-0954). No panel capability is consulted.
-- Rows from an older host lack both fields and read as empty.
M.SCRATCHPAD_LABEL = "scratchpad"
M.SCRATCHPAD_COUNT_MAX = 1 -- Core SCRATCHPAD_COUNT_MAX (single-slot ceiling)

-- Clock module defaults: `os.date` is a restricted, zero-grant local source.
M.CLOCK_DEFAULT_FORMAT = "%H:%M"
M.CLOCK_TICK_MS = 60000
-- Template renderer cap (bytes) for a bounded `{key}` substitution.
M.TEMPLATE_MAX_BYTES = 1024
-- Notification title for the tooltip fallback.
M.TOOLTIP_TITLE = "Unified Bar"

-- `states` → theme tokens (host-resolved; never a raw color). A module picks a
-- state name and the host resolves the token against the active theme.
M.STATE_TOKENS = {
  normal = "normal",
  warning = "warning",
  critical = "critical",
}

-- Plugin settings (relative to plugins.<owner>.<name>) and their defaults.
-- `show` / `edge` replace the retired Core `workspace.show_bar` /
-- `workspace.bar.edge`; `show_single` opts into a lone-workspace bar, which
-- Core always hid. `name_max_chars` keeps the Core pill-name bound.
M.DEFAULTS = {
  show = true,
  edge = "bottom",
  show_single = false,
  name_max_chars = M.NAME_MAX_CHARS,
}

-- A band whose text is empty is not painted by the host.
local HIDDEN = { kind = "Text", text = "" }

local function is_integer(value)
  return type(value) == "number" and value == math.floor(value)
end

-- A settings value that can be indexed (`t[k]`) and measured (`#t`). Under the
-- host bridge a JSON array/object crosses into Lua as an indexable userdata
-- (not a plain table), so both are accepted; scalars (boolean/number/string)
-- are not collections.
local function is_collection(value)
  local kind = type(value)
  return kind == "table" or kind == "userdata"
end

-- Length of an indexable settings collection, fail closed to 0.
local function list_len(list)
  if not is_collection(list) then
    return 0
  end
  local ok, n = pcall(function()
    return #list
  end)
  if ok and type(n) == "number" and n >= 0 then
    return math.floor(n)
  end
  return 0
end

-- Truncates `text` to at most `max_chars` UTF-8 characters (Core
-- `truncate_ws_name`, which counts Rust `char`s).
--
-- Portable byte walk (bar#6): the classic `[^\128-\191][\128-\191]*` gmatch
-- pattern embeds isolated UTF-8 continuation bytes (0x80-0xBF), which the
-- phodopus engine rejects as an invalid UTF-8 pattern itself (`invalid utf-8
-- sequence of 1 bytes from index 2` during mount, even for ASCII rows).
-- Walking with `string.byte`/`string.sub` needs no non-UTF8 pattern bytes
-- and counts identically on every engine.
function M.truncate_chars(text, max_chars)
  local out = {}
  local count = 0
  local i = 1
  local n = #text
  while i <= n do
    if count >= max_chars then
      break
    end
    local byte = string.byte(text, i)
    local len = 1
    if byte >= 240 and byte < 248 then
      len = 4
    elseif byte >= 224 and byte < 240 then
      len = 3
    elseif byte >= 192 and byte < 224 then
      len = 2
    else
      len = 1
    end
    -- Clamp a truncated tail (split sequence at end of input): take the rest.
    if i + len - 1 > n then
      len = n - i + 1
    end
    count = count + 1
    out[count] = string.sub(text, i, i + len - 1)
    i = i + len
  end
  return table.concat(out)
end

-- Truncates `text` to at most `max_bytes` bytes on a UTF-8 character
-- boundary (Core `String::truncate` after the `is_char_boundary` walk).
function M.truncate_bytes(text, max_bytes)
  if #text <= max_bytes then
    return text
  end
  local cut = max_bytes
  while cut > 0 do
    local byte = string.byte(text, cut + 1)
    if byte < 128 or byte > 191 then
      break
    end
    cut = cut - 1
  end
  return string.sub(text, 1, cut)
end

-- Bounded in-plugin template renderer: `{key}` is replaced by `data[key]`
-- (a missing key keeps its literal `{key}`), then the result is cut to
-- `max_bytes` on a character boundary. Pure; the module never builds a format
-- engine beyond this substitution.
function M.render_template(format, data, max_bytes)
  if type(format) ~= "string" then
    return ""
  end
  if not is_collection(data) then
    data = {}
  end
  local cap = max_bytes or M.TEMPLATE_MAX_BYTES
  local bounded = M.truncate_bytes(format, cap)
  local rendered = string.gsub(bounded, "{(%w+)}", function(key)
    local value = data[key]
    if value == nil then
      return "{" .. key .. "}"
    end
    return tostring(value)
  end)
  return M.truncate_bytes(rendered, cap)
end

-- Theme token for a module `states` name, or nil for an unknown/absent state.
function M.state_token(state)
  return M.STATE_TOKENS[state]
end

-- Normalizes a click binding. Only a command id (a string, the qualified name
-- of a registered command) is ever accepted: shell/exec strings are not a
-- vehicle and can never reach the scene. Returns nil when the command is
-- absent or not a string. Arguments must be a plain table when present.
function M.click_binding(command, args)
  if type(command) ~= "string" or command == "" then
    return nil
  end
  if args ~= nil and not is_collection(args) then
    return nil
  end
  local binding = { command = command }
  if args ~= nil then
    binding.args = args
  end
  return binding
end

-- Notification payload for the tooltip→notify fallback, or nil when there is
-- no detail text to show.
function M.tooltip_payload(text)
  if type(text) ~= "string" or text == "" then
    return nil
  end
  return { title = M.TOOLTIP_TITLE, body = text }
end

-- Reads and validates the plugin settings; any absent or invalid value falls
-- back to its default so a bad configuration never hides or breaks the bar.
function M.read_settings(get)
  local opts = {}
  for key, default in pairs(M.DEFAULTS) do
    opts[key] = default
  end
  local show = get("show")
  if type(show) == "boolean" then
    opts.show = show
  end
  local edge = get("edge")
  if type(edge) == "string" and M.EDGE_SLOTS[edge] ~= nil then
    opts.edge = edge
  end
  local show_single = get("show_single")
  if type(show_single) == "boolean" then
    opts.show_single = show_single
  end
  local name_max = get("name_max_chars")
  if is_integer(name_max) and name_max >= 1 and name_max <= M.NAME_MAX_CHARS then
    opts.name_max_chars = name_max
  end
  opts.specs = M.read_plan(get, opts)
  return opts
end

-- Window scratchpad occupancy derived from `bitty.workspace.list()` rows
-- (Core CTX-0954): the slot is window-global, so the rows of one result
-- agree; the read stays tolerant (the highest valid count wins, any presence
-- flag wins) and fail closed (absent or invalid fields read as empty, which
-- is also how rows from a host without the surface render: no indicator).
function M.scratchpad_state(rows)
  local count = 0
  local occupied = false
  for _, row in ipairs(rows) do
    local field = row.scratchpad_count
    if type(field) == "number" and field == math.floor(field) and field > count then
      count = field
    end
    if row.scratchpad_occupied == true then
      occupied = true
    end
  end
  if count < 0 then
    count = 0
  end
  if occupied and count < 1 then
    count = 1
  end
  if count > 0 then
    occupied = true
  end
  return { count = count, occupied = occupied }
end

-- Scratchpad indicator segment for the occupied slot, or nil when empty. The
-- count rides the state and is shown only when it exceeds the single-slot
-- ceiling (never on current hosts, where presence alone carries the `0`/`1`).
-- Appended after the workspace count suffix so the Core workspaceline text
-- stays an exact prefix; never clickable (no panel capability is involved).
function M.scratchpad_segment(rows)
  local state = M.scratchpad_state(rows)
  if not state.occupied then
    return nil
  end
  local text = M.SEPARATOR .. "[" .. M.SCRATCHPAD_LABEL
  if state.count > M.SCRATCHPAD_COUNT_MAX then
    text = text .. ":" .. state.count
  end
  return { kind = "scratchpad", text = text .. "]" }
end

-- Whether the bar presents (Core `bar_present`): enabled, and either more
-- than one workspace, the fail-closed empty list, an explicit opt-in, or an
-- occupied scratchpad (window-global state worth showing even with a lone
-- workspace; an empty slot keeps the Core hide-lone behavior).
function M.visible(rows, opts)
  if not opts.show then
    return false
  end
  if #rows ~= 1 then
    return true
  end
  if opts.show_single then
    return true
  end
  return M.scratchpad_state(rows).occupied
end

-- Ordered bar segments before the byte bound: one pill per workspace
-- (`{stable-id}:{name}` plus `*` on the active one), single-space separators,
-- the ` ({count})` suffix, and the scratchpad indicator when the slot is
-- occupied. The id is the stable workspace seq from
-- `bitty.workspace.list()` (Core `workspaceline_tokens` renders `slot.seq`),
-- so closing a workspace never renumbers the survivors. Without an occupied
-- scratchpad the concatenated text equals Core `workspaceline_text` for the
-- same rows.
function M.segments(rows, opts)
  if #rows == 0 then
    return { { kind = "empty", text = M.EMPTY_PLACEHOLDER } }
  end
  local out = {}
  local count = math.min(#rows, M.MAX_WORKSPACES)
  for index = 1, count do
    local row = rows[index]
    if index > 1 then
      out[#out + 1] = { kind = "separator", text = M.SEPARATOR }
    end
    local mark = row.active and M.ACTIVE_MARK or ""
    out[#out + 1] = {
      kind = "pill",
      text = row.id .. ":" .. M.truncate_chars(row.name, opts.name_max_chars) .. mark,
      id = row.id,
      active = row.active == true,
    }
  end
  out[#out + 1] = { kind = "suffix", text = " (" .. count .. ")" }
  local scratchpad = M.scratchpad_segment(rows)
  if scratchpad ~= nil then
    out[#out + 1] = scratchpad
  end
  return out
end

-- Converts one workspaces segment to a chassis atom. Atom shape:
-- `{ text, bold?, fg?, on_click?, tooltip? }`. Only inactive pills are
-- clickable: separators, the count suffix, the active pill, the empty
-- placeholder, and the scratchpad indicator switch nothing (Core
-- `workspaceline_hit_test` / `workspaceline_click`).
local function segment_atom(segment)
  local atom = { text = segment.text }
  if segment.kind == "pill" then
    if segment.active then
      atom.bold = true
      atom.fg = M.ACTIVE_FG
    else
      atom.on_click = M.click_binding(M.FOCUS_COMMAND, { id = segment.id })
    end
  end
  return atom
end

-- Workspaces module render: the Core-parity pill strip as atoms.
function M.workspaces_atoms(rows, opts)
  local atoms = {}
  for _, segment in ipairs(M.segments(rows, opts)) do
    atoms[#atoms + 1] = segment_atom(segment)
  end
  return atoms
end

-- Deterministic clock text: `os.date(format, now)` (a restricted, zero-grant
-- local source), fail closed to "" on a bad format or time.
function M.clock_text(format, now)
  if type(format) ~= "string" or format == "" then
    return ""
  end
  if type(now) ~= "number" then
    return ""
  end
  local ok, text = pcall(os.date, format, now)
  if not ok or type(text) ~= "string" then
    return ""
  end
  return text
end

-- Clock module render: one atom from `os.date`. `options.tooltip` (a plain
-- string) becomes the tooltip→notify detail text; the module is not otherwise
-- clickable.
function M.clock_atoms(ctx)
  local options = ctx.options or {}
  local format = options.format
  if type(format) ~= "string" or format == "" then
    format = M.CLOCK_DEFAULT_FORMAT
  end
  local atom = { text = M.clock_text(format, ctx.now) }
  if type(options.tooltip) == "string" and options.tooltip ~= "" then
    atom.tooltip = options.tooltip
  end
  return { atom }
end

-- In-plugin module registry (bitty-plugins#86 Phase A). Each entry declares
-- how it renders and how it refreshes:
--   name    : the settings name that selects it in a module group.
--   kind    : "event" (refresh from events.subscribe) or "timer" (refresh on
--             tick_ms).
--   tick_ms : timer cadence for a "timer" module; nil for an event module.
--   events  : event names the module refreshes from (event modules only).
--   render  : render(ctx) -> atoms from local data or a broker interface.
-- System modules (broker `owner:iface@version` providers) are Phase B and
-- register here unchanged when a provider lands.
M.MODULES = {}

M.MODULES.workspaces = {
  name = "workspaces",
  kind = "event",
  events = {
    "workspace.created",
    "workspace.closed",
    "workspace.renamed",
    "workspace.focused",
    "workspace.changed",
  },
  option_keys = {},
  render = function(ctx)
    return M.workspaces_atoms(ctx.rows, ctx.opts)
  end,
}

M.MODULES.clock = {
  name = "clock",
  kind = "timer",
  tick_ms = M.CLOCK_TICK_MS,
  option_keys = { "format", "tick_ms", "tooltip" },
  render = function(ctx)
    return M.clock_atoms(ctx)
  end,
}

-- A module name for one list entry, or nil when the entry is not a usable
-- name (string, or table with a string `module`/`name`). Bad entries are
-- skipped so a malformed spec never hides the bar.
function M.entry_module(entry)
  if type(entry) == "string" and entry ~= "" then
    return entry
  end
  if is_collection(entry) then
    local name = entry.module
    if type(name) ~= "string" then
      name = entry.name
    end
    if type(name) == "string" and name ~= "" then
      return name
    end
  end
  return nil
end

-- Per-module options for `name`: the recognized option keys of its registry
-- entry, read from the settings collection named after the module. An absent
-- or non-collection read yields no options (fail to default).
function M.module_options(get, name)
  local options = {}
  local raw = get(name)
  local def = M.MODULES[name]
  if is_collection(raw) and def ~= nil and type(def.option_keys) == "table" then
    for _, key in ipairs(def.option_keys) do
      local value = raw[key]
      if value ~= nil then
        options[key] = value
      end
    end
  end
  return options
end

-- Appends the resolvable module specs of one group list to `specs`. Unknown
-- names and non-name entries are skipped, so one bad entry never hides the
-- bar.
local function append_specs(get, list, specs)
  local count = list_len(list)
  for index = 1, count do
    local name = M.entry_module(list[index])
    if name ~= nil and M.MODULES[name] ~= nil then
      specs[#specs + 1] = { name = name, options = M.module_options(get, name) }
    end
  end
end

-- Resolves the ordered module plan from the module-group settings. Order is
-- left, then center, then right. If no group is set, or every entry is
-- unknown, the plan falls back to the default (`modules_left` = workspaces),
-- so a bad or empty spec never hides the bar.
function M.read_plan(get, opts)
  local specs = {}
  local groups = {}
  local any_set = false
  for _, key in ipairs(M.MODULE_GROUPS) do
    local value = get(key)
    if is_collection(value) then
      groups[key] = value
      any_set = true
    end
  end
  if any_set then
    for _, key in ipairs(M.MODULE_GROUPS) do
      append_specs(get, groups[key], specs)
    end
  end
  if #specs == 0 then
    append_specs(get, M.DEFAULT_MODULES_LEFT, specs)
  end
  if opts ~= nil then
    opts.specs = specs
  end
  return specs
end

-- Timer cadence for a module (nil for an event module): the module default,
-- overridable per module, clamped to the rate-policy floor.
function M.tick_ms(def, options)
  if not is_collection(def) or def.tick_ms == nil then
    return nil
  end
  local ms = def.tick_ms
  if is_collection(options) and is_integer(options.tick_ms) and options.tick_ms >= 1 then
    ms = options.tick_ms
  end
  if ms < M.MIN_TICK_MS then
    ms = M.MIN_TICK_MS
  end
  return math.floor(ms)
end

-- Applies the line byte bound across atoms; the atom that crosses the bound
-- is cut on a character boundary and everything after it is dropped.
function M.clip(atoms, max_bytes)
  local out = {}
  local used = 0
  for _, atom in ipairs(atoms) do
    local remaining = max_bytes - used
    if remaining <= 0 then
      break
    end
    local text = atom.text
    if #text > remaining then
      text = M.truncate_bytes(text, remaining)
    end
    if text ~= "" then
      local copy = {}
      for key, value in pairs(atom) do
        copy[key] = value
      end
      copy.text = text
      out[#out + 1] = copy
      used = used + #text
    end
    if text ~= atom.text then
      break
    end
  end
  return out
end

-- Scene node for one atom. A tooltip with no command binds the detail command
-- (tooltip→notify fallback); anything else stays non-interactive.
function M.atom_node(atom)
  local node = { kind = "Text", text = atom.text }
  if atom.bold == true then
    node.bold = true
  end
  if atom.fg ~= nil then
    node.fg = atom.fg
  end
  if atom.on_click ~= nil then
    node.on_click = atom.on_click
  elseif atom.tooltip ~= nil then
    node.on_click = { command = M.DETAIL_COMMAND, args = { text = atom.tooltip } }
  end
  return node
end

-- Renders the ordered plan into atoms: each module's atoms in order, joined by
-- a single space between modules, then clipped to the line byte bound.
function M.render_plan(opts, rows, now)
  local atoms = {}
  local first = true
  for _, spec in ipairs(opts.specs) do
    local def = M.MODULES[spec.name]
    if def ~= nil then
      local rendered = def.render({
        rows = rows,
        opts = opts,
        now = now,
        options = spec.options,
      })
      if type(rendered) == "table" and #rendered > 0 then
        if not first then
          atoms[#atoms + 1] = { text = M.MODULE_GAP }
        end
        for _, atom in ipairs(rendered) do
          atoms[#atoms + 1] = atom
        end
        first = false
      end
    end
  end
  return M.clip(atoms, M.LINE_MAX_BYTES)
end

-- Full bar component for the given settings, rows, and clock reading.
function M.component(opts, rows, now)
  if not M.visible(rows, opts) then
    return HIDDEN
  end
  local atoms = M.render_plan(opts, rows, now)
  if #atoms == 0 then
    return HIDDEN
  end
  local children = {}
  for _, atom in ipairs(atoms) do
    children[#children + 1] = M.atom_node(atom)
  end
  return { kind = "Row", children = children }
end

-- Focus target for a click: the workspace id when it names an existing,
-- inactive workspace; nil otherwise (fail closed, no request queued).
function M.focus_target(rows, id)
  if not is_integer(id) or id < 1 then
    return nil
  end
  for _, row in ipairs(rows) do
    if row.id == id then
      if row.active then
        return nil
      end
      return math.floor(id)
    end
  end
  return nil
end

-- Host wiring. Skipped when the host table is absent so the pure functions
-- above stay loadable on their own.
if bitty == nil then
  return M
end

local function settings_get(key)
  return bitty.settings.get(key)
end

local function now_seconds()
  local ok, value = pcall(os.time)
  if ok and type(value) == "number" then
    return value
  end
  return nil
end

local opts = M.read_settings(settings_get)
local timers = {}

local function build_component()
  return M.component(opts, bitty.workspace.list(), now_seconds())
end

-- Mounts are registration calls valid only during activation, so the band
-- edge is fixed per generation; an `edge` change applies on the next one.
local block = bitty.ui.mount(M.EDGE_SLOTS[opts.edge], build_component())

local function render()
  bitty.ui.update(block, build_component())
end

-- Arms one timer module: a single `timers.create` tick at the module cadence.
-- The callback re-renders and re-arms optimistically; Plugin API v1 closes
-- timer creation after activation (ADR 0009 LUA-OQ-12), so the re-arm fails
-- closed and the tick is one-shot today, while a host with repeating timers
-- needs no bar change. Called only while the bar is visible (pause-on-hidden).
local function arm_timer(name, spec)
  local def = M.MODULES[name]
  local ms = M.tick_ms(def, spec.options)
  if ms == nil then
    return
  end
  local ok, handle = pcall(function()
    return bitty.timers.create(ms, function()
      timers[name] = nil
      render()
      arm_timer(name, spec)
    end)
  end)
  if ok and type(handle) == "number" then
    timers[name] = handle
  end
end

-- (Re)creates the timer set for the current plan; called at activation and on
-- config.reloaded. Hidden bars arm nothing (pause-on-hidden).
local function reschedule()
  for _, handle in pairs(timers) do
    pcall(bitty.timers.cancel, handle)
  end
  timers = {}
  if not M.visible(bitty.workspace.list(), opts) then
    return
  end
  for _, spec in ipairs(opts.specs) do
    local def = M.MODULES[spec.name]
    if def ~= nil and def.tick_ms ~= nil then
      arm_timer(spec.name, spec)
    end
  end
end

bitty.commands.register({
  id = FOCUS_COMMAND_ID,
  title = "Unified Bar: focus workspace",
  description = "Focus the workspace with this stable id (workspace bar click target).",
  args_schema = {
    type = "object",
    properties = {
      id = { type = "number", minimum = 1 },
    },
    required = { "id" },
    additionalProperties = false,
  },
  run = function(args)
    local target = M.focus_target(bitty.workspace.list(), args.id)
    if target == nil then
      return false
    end
    return bitty.workspace.focus(target)
  end,
})

bitty.commands.register({
  id = DETAIL_COMMAND_ID,
  title = "Unified Bar: show module detail",
  description = "Show a module's detail text as a notification (tooltip fallback).",
  args_schema = {
    type = "object",
    properties = {
      text = { type = "string", maxLength = M.TEMPLATE_MAX_BYTES },
    },
    required = { "text" },
    additionalProperties = false,
  },
  run = function(args)
    local payload = M.tooltip_payload(args.text)
    if payload == nil then
      return false
    end
    -- Fail closed when platform.notify is not granted (the fallback is
    -- best-effort presentation, never a hard failure).
    local ok, result = pcall(bitty.notify.show, payload)
    if not ok then
      return false
    end
    return result
  end,
})

-- Event-driven modules refresh from their declared events (no timer where
-- events suffice). The subscription set is the union of the planned modules'
-- events, deduplicated.
local subscribed = {}
for _, spec in ipairs(opts.specs) do
  local def = M.MODULES[spec.name]
  if def ~= nil and type(def.events) == "table" then
    for _, name in ipairs(def.events) do
      if subscribed[name] == nil then
        subscribed[name] = true
        bitty.events.subscribe(name, render)
      end
    end
  end
end

bitty.events.subscribe("config.reloaded", function()
  local edge = opts.edge
  opts = M.read_settings(settings_get)
  opts.edge = edge
  reschedule()
  render()
end)

reschedule()

return M
