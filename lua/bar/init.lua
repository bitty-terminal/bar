-- Entry point for Unified Bar (bitty-terminal.bar): the workspace bar.
--
-- ADR-0014 keeps Workspace as a Core mechanism and moves every workspace
-- presentation into plugins. This file renders a Waybar-like capsule list over
-- the Plugin API v1 surface only: `bitty.workspace.list/focus` (workspace.read /
-- workspace.control), the `workspace.*` events, `bitty.settings`, and one
-- `bitty.ui.mount` band. The authoritative bindings are the SDK `bitty.d.lua`
-- (R-SDK-1); nothing outside that contract is used.
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
-- behavior-preserving (bitty-runtime `runtime/workspaces.rs`).
M.NAME_MAX_CHARS = 32 -- WORKSPACE_NAME_MAX_CHARS (characters per pill name)
M.LINE_MAX_BYTES = 1024 -- WORKSPACELINE_MAX_CHARS (UTF-8 bytes, char-boundary cut)
M.MAX_WORKSPACES = 16 -- MAX_WORKSPACES (also the workspace.list row bound)

M.ACTIVE_MARK = "*"
M.OCCUPIED_MARK = "+"
M.ATTENTION_MARK = "!"
M.PILL_OPEN = "["
M.PILL_CLOSE = "]"
M.SEPARATOR = " "
-- Fail-closed placeholder for an empty workspace list (U+2014 EM DASH).
M.EMPTY_PLACEHOLDER = "\226\128\148"
-- Accepted bar edges and the band slot each one mounts into.
-- The v1 host accepts left/right as storage slots but does not paint vertical
-- bands yet. Keep those values out of the setting until vertical bands ship.
M.EDGE_SLOTS = { top = "top", bottom = "bottom" }

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
function M.truncate_chars(text, max_chars)
  local out = {}
  local index = 1
  local count = 0
  while index <= #text and count < max_chars do
    local first = string.byte(text, index)
    local width = 1
    if first >= 194 and first <= 223 then
      width = 2
    elseif first >= 224 and first <= 239 then
      width = 3
    elseif first >= 240 and first <= 244 then
      width = 4
    end
    local last = index + width - 1
    if last > #text then
      width = 1
    else
      for continuation = index + 1, last do
        local byte = string.byte(text, continuation)
        if byte < 128 or byte > 191 then
          width = 1
          break
        end
      end
    end
    count = count + 1
    out[count] = string.sub(text, index, index + width - 1)
    index = index + width
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

-- Whether the bar presents (Core `bar_present`): enabled, and either more
-- than one workspace, the fail-closed empty list, or an explicit opt-in.
function M.visible(rows, opts)
  if not opts.show then
    return false
  end
  return #rows ~= 1 or opts.show_single
end

-- Core supplies rows in display order. Sorting a bounded copy by stable id
-- keeps the capsule order deterministic if a host delivers an equivalent
-- snapshot in a different iteration order, without mutating host data.
function M.ordered_rows(rows)
  local out = {}
  for index, row in ipairs(rows) do
    out[index] = row
  end
  for index = 2, #out do
    local row = out[index]
    local cursor = index - 1
    while cursor >= 1 and out[cursor].id > row.id do
      out[cursor + 1] = out[cursor]
      cursor = cursor - 1
    end
    out[cursor + 1] = row
  end
  return out
end

-- Ordered bar segments before the byte bound: one capsule per workspace.
function M.segments(rows, opts)
  if #rows == 0 then
    return { { kind = "empty", text = M.EMPTY_PLACEHOLDER } }
  end
  local ordered = M.ordered_rows(rows)
  local out = {}
  local count = math.min(#ordered, M.MAX_WORKSPACES)
  for index = 1, count do
    local row = ordered[index]
    if index > 1 then
      out[#out + 1] = { kind = "separator", text = M.SEPARATOR }
    end
    local marks = ""
    if row.active == true then
      marks = marks .. M.ACTIVE_MARK
    end
    if type(row.panel_count) == "number" and row.panel_count > 0 then
      marks = marks .. M.OCCUPIED_MARK
    end
    local attention = row.attention
    if attention ~= nil and
        (attention.bell == true or attention.activity == true or attention.exited == true) then
      marks = marks .. M.ATTENTION_MARK
    end
    local label = tostring(row.id) .. ":" .. M.truncate_chars(row.name, opts.name_max_chars)
    if marks ~= "" then
      label = label .. marks
    end
    out[#out + 1] = {
      kind = "pill",
      text = M.PILL_OPEN .. label .. M.PILL_CLOSE,
      id = row.id,
      active = row.active == true,
      occupied = type(row.panel_count) == "number" and row.panel_count > 0,
      attention = attention ~= nil and
        (attention.bell == true or attention.activity == true or attention.exited == true),
    }
  end
  return out
end

-- Applies the line byte bound without cutting a capsule in half. This keeps
-- every painted item a complete, clickable atom.
function M.clip(segments, max_bytes)
  local out = {}
  local used = 0
  for _, segment in ipairs(segments) do
    local text = segment.text
    if used + #text > max_bytes then
      break
    end
    local copy = {}
    for key, value in pairs(segment) do
      copy[key] = value
    end
    out[#out + 1] = copy
    used = used + #text
  end
  if out[#out] ~= nil and out[#out].kind == "separator" then
    out[#out] = nil
  end
  return out
end

-- Scene node for one segment. A capsule is one Text atom, the supported v1
-- primitive that can carry both the existing click binding and host theme
-- styling without inventing an unsupported node kind.
local function segment_node(segment)
  local node = { kind = "Text", text = segment.text }
  if segment.kind == "pill" then
    if segment.active then
      node.fg = "background"
      node.bg = "accent"
      node.bold = true
    elseif segment.attention then
      node.fg = "cursor"
    elseif segment.occupied then
      node.bold = true
    end
    if not segment.active then
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
