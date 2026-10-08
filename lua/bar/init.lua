-- Entry point for Unified Bar (bitty-terminal.bar): the workspace bar.
--
-- ADR-0014 keeps Workspace as a Core mechanism and moves every workspace
-- presentation into plugins. This file renders the presentation the retired
-- Core workspaceline drew (bitty-runtime `workspaceline_text`,
-- `workspaceline_hit_test`, `workspaceline_click`) over the Plugin API v1
-- surface only: `bitty.workspace.list/focus` (workspace.read /
-- workspace.control), the `workspace.*` events, `bitty.settings`, and one
-- `bitty.ui.mount` band. The authoritative bindings are the SDK `bitty.d.lua`
-- (R-SDK-1); nothing outside that contract is used, except the
-- capability-neutral `scratchpad_count` / `scratchpad_occupied` row fields
-- (Core CTX-0954) read tolerantly under the same `workspace.read` grant.
--
-- The host evaluates this file once per plugin activation and owns every
-- resource created here for the lifetime of that generation. The code stays
-- inside the Lua 5.1 grammar (the `just lua` gate) and uses no `utf8` library.

local M = {}

local PLUGIN_ID = "bitty-terminal.bar"

-- Plugin-local command segment; the host qualifies it from the `[lazy]`
-- reservation in `bitty-plugin.toml`. Click bindings carry the qualified name.
local FOCUS_COMMAND_ID = "focus"
M.FOCUS_COMMAND = PLUGIN_ID .. ":" .. FOCUS_COMMAND_ID

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

-- Scratchpad indicator (W-104 R2-consumer, DEC-W104-1): the window scratchpad
-- slot is window-global (at most one parked panel), so every row of one
-- `bitty.workspace.list()` result carries the same `scratchpad_count`
-- (`0`/`1`) and `scratchpad_occupied` snapshot under the existing
-- `workspace.read` grant (Core CTX-0954). No panel capability is consulted.
-- Rows from an older host lack both fields and read as empty.
M.SCRATCHPAD_LABEL = "scratchpad"
M.SCRATCHPAD_COUNT_MAX = 1 -- Core SCRATCHPAD_COUNT_MAX (single-slot ceiling)

-- Plugin settings (relative to plugins.<owner>.<name>) and their defaults.
-- `show` / `edge` replace the retired Core `workspace.show_bar` /
-- `workspace.bar.edge`; `show_single` opts into a lone-workspace bar, which
-- Core always hid.
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

-- Applies the line byte bound across segments; the segment that crosses the
-- bound is cut on a character boundary and everything after it is dropped.
function M.clip(segments, max_bytes)
  local out = {}
  local used = 0
  for _, segment in ipairs(segments) do
    local remaining = max_bytes - used
    if remaining <= 0 then
      break
    end
    local text = segment.text
    if #text > remaining then
      text = M.truncate_bytes(text, remaining)
    end
    if text ~= "" then
      local copy = {}
      for key, value in pairs(segment) do
        copy[key] = value
      end
      copy.text = text
      out[#out + 1] = copy
      used = used + #text
    end
    if text ~= segment.text then
      break
    end
  end
  return out
end

-- Scene node for one segment. Only inactive pills are clickable: separators,
-- the count suffix, and the active pill switch nothing (Core
-- `workspaceline_hit_test` / `workspaceline_click`).
local function segment_node(segment)
  local node = { kind = "Text", text = segment.text }
  if segment.kind == "pill" then
    if segment.active then
      node.bold = true
      node.fg = M.ACTIVE_FG
    else
      node.on_click = { command = M.FOCUS_COMMAND, args = { id = segment.id } }
    end
  end
  return node
end

-- Full bar component for the given rows and settings.
function M.component(rows, opts)
  if not M.visible(rows, opts) then
    return HIDDEN
  end
  local children = {}
  for _, segment in ipairs(M.clip(M.segments(rows, opts), M.LINE_MAX_BYTES)) do
    children[#children + 1] = segment_node(segment)
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

local opts = M.read_settings(settings_get)

-- Mounts are registration calls valid only during activation, so the band
-- edge is fixed per generation; an `edge` change applies on the next one.
local block = bitty.ui.mount(M.EDGE_SLOTS[opts.edge], M.component(bitty.workspace.list(), opts))

local function render()
  bitty.ui.update(block, M.component(bitty.workspace.list(), opts))
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

for _, name in ipairs({
  "workspace.created",
  "workspace.closed",
  "workspace.renamed",
  "workspace.focused",
  "workspace.changed",
}) do
  bitty.events.subscribe(name, render)
end

bitty.events.subscribe("config.reloaded", function()
  local edge = opts.edge
  opts = M.read_settings(settings_get)
  opts.edge = edge
  render()
end)

return M
