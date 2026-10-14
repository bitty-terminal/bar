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
-- Clicks dispatch registered commands only and never shell out. Phase B adds
-- the first system modules (`network`, `bluetooth`, `backlight`, `idle`) over
-- broker `owner:iface@version` providers; true centering (`modules_center`),
-- scroll bindings, real tooltips, and the tray need new Core vehicles and are
-- Phase C. No new Core API is introduced here.
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
local BLUETOOTH_TOGGLE_COMMAND_ID = "bluetooth-toggle"
local BACKLIGHT_STEP_COMMAND_ID = "backlight-step"
local IDLE_TOGGLE_COMMAND_ID = "idle-toggle"
M.FOCUS_COMMAND = PLUGIN_ID .. ":" .. FOCUS_COMMAND_ID
-- Tooltip-without-command fallback: the click shows the module's detail text
-- as a notification (`bitty.notify.show`) because v1 has no tooltip vehicle.
M.DETAIL_COMMAND = PLUGIN_ID .. ":" .. DETAIL_COMMAND_ID
-- Device-module control commands (Phase B): each calls exactly one control
-- method on its own control interface and never anything else.
M.BLUETOOTH_TOGGLE_COMMAND = PLUGIN_ID .. ":" .. BLUETOOTH_TOGGLE_COMMAND_ID
M.BACKLIGHT_STEP_COMMAND = PLUGIN_ID .. ":" .. BACKLIGHT_STEP_COMMAND_ID
M.IDLE_TOGGLE_COMMAND = PLUGIN_ID .. ":" .. IDLE_TOGGLE_COMMAND_ID

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

-- Phase B device modules (bitty#2012 network, bitty#2017 bluetooth, bitty#2020
-- backlight + idle-inhibit; Core CTX-1197/CTX-1201). Each module consumes one
-- short broker interface (`owner:iface@version` served by the native
-- `bitty-terminal.devices` component) through `bitty.services.get` with an
-- exact `^1.0` requirement and `optional = true`: an ungranted or absent
-- provider resolves to nil (indistinguishable, fail closed) and the module
-- hides, leaving the rest of the plan untouched. Every read runs in `pcall`
-- and every snapshot is shape-checked; invalid shapes hide the module.
-- Read vs control never share an interface: control methods (`set_power`,
-- `set_step`, `set`) are called only from the registered toggle/step
-- commands, and only when the separate control interface resolves. A denied
-- control call degrades to a notification (best-effort) and never retries or
-- escalates (backlight privilege rule DEC-0115).

-- Short broker interfaces negotiated by the device modules.
M.NETWORK_STATE_IFACE = "network.state"
M.NETWORK_ESSID_IFACE = "network.essid"
M.BLUETOOTH_STATE_IFACE = "bluetooth.state"
M.BLUETOOTH_CONTROL_IFACE = "bluetooth.control"
M.BACKLIGHT_STATE_IFACE = "backlight.state"
M.BACKLIGHT_CONTROL_IFACE = "backlight.control"
M.IDLE_STATE_IFACE = "idle.state"
M.IDLE_CONTROL_IFACE = "idle.control"

-- Exact version requirement for the batch-B interfaces (Core
-- PROVIDER_INTERFACE_VERSION 1.0.0; highest compatible wins host-side, never
-- a silent downgrade).
M.DEVICE_VERSION_REQ = "^1.0"

-- Provider-side poll floors (ms): configuration can never sample faster than
-- the provider cadence (network 3 s per bitty#2012; bluetooth, backlight, and
-- idle 5 s per bitty#2017/#2020). Timer modules arm at these cadences and the
-- `tick_floor_ms` registry field keeps an options override at or above them.
M.NETWORK_TICK_MS = 3000
M.DEVICE_TICK_MS = 5000

-- Accepted network link states (Core LinkKind; anything else hides).
M.LINK_KINDS = { ethernet = true, wifi = true, disconnected = true, disabled = true }

-- Defensive ESSID byte bound (an SSID is at most 32 bytes on the wire).
M.ESSID_MAX_BYTES = 64

-- Backlight step bound (percent points per click, either direction).
M.BACKLIGHT_STEP_MAX = 100
M.BACKLIGHT_DEFAULT_STEP = 10

-- Best-effort notification bodies for denied control calls (user-initiated
-- clicks only; reads never notify).
M.BLUETOOTH_UNAVAILABLE = "Bluetooth control unavailable."
M.BACKLIGHT_UNAVAILABLE = "Backlight control unavailable."
M.IDLE_UNAVAILABLE = "Idle control unavailable."

-- Resolves one short broker interface with the batch version requirement.
-- Returns the plain service table, or nil when the provider is absent,
-- ungranted, version-mismatched, or the services namespace is unavailable
-- (older host): ungranted stays indistinguishable from absent.
function M.resolve_service(iface)
  if bitty == nil or bitty.services == nil or bitty.services.get == nil then
    return nil
  end
  local ok, svc = pcall(bitty.services.get, iface, {
    version = M.DEVICE_VERSION_REQ,
    optional = true,
  })
  if not ok or svc == nil then
    return nil
  end
  if type(svc) ~= "table" and type(svc) ~= "userdata" then
    return nil
  end
  return svc
end

-- Calls `get()` on a resolved service; returns the snapshot table, or nil
-- when the call fails, the provider is gone, or the shape is not a table.
function M.service_data(svc)
  if svc == nil then
    return nil
  end
  local ok, data = pcall(function()
    return svc.get()
  end)
  if not ok then
    return nil
  end
  if type(data) ~= "table" and type(data) ~= "userdata" then
    return nil
  end
  return data
end

-- Wi-Fi identity from the separately-granted `network.essid` sub-interface,
-- or nil. The base `network.state` snapshot never carries an ESSID (Core
-- omits the key without the sub-grant), so this is the only ESSID source and
-- an ungranted sub-grant renders exactly like an NM-less host: no ESSID text.
function M.essid_value()
  local data = M.service_data(M.resolve_service(M.NETWORK_ESSID_IFACE))
  if data == nil then
    return nil
  end
  if type(data.essid) ~= "string" or data.essid == "" then
    return nil
  end
  return M.truncate_bytes(data.essid, M.ESSID_MAX_BYTES)
end

-- Whether `link` is an accepted network link state.
function M.valid_link(link)
  return type(link) == "string" and M.LINK_KINDS[link] == true
end

-- Humanized bandwidth rate ("123B", "8.0K", "1.2M"), or nil for an absent or
-- invalid measurement. Missing rates are omitted by the caller, never
-- fabricated.
function M.format_bps(bps)
  if type(bps) ~= "number" or bps < 0 or bps ~= bps then
    return nil
  end
  local value = math.floor(bps)
  if value < 1000 then
    return value .. "B"
  end
  if value < 1000000 then
    return string.format("%.1fK", value / 1000)
  end
  return string.format("%.1fM", value / 1000000)
end

-- Collapses whitespace runs to one space and trims the ends, so a template
-- with absent keys renders cleanly instead of leaving gaps.
function M.compact(text)
  if type(text) ~= "string" then
    return ""
  end
  local one = string.gsub(text, "%s+", " ")
  one = string.gsub(one, "^%s+", "")
  return string.gsub(one, "%s+$", "")
end

-- Network display text, or nil when the snapshot hides (invalid link). The
-- default renders link plus measured bandwidth plus the ESSID in parentheses
-- when the sub-grant holds; a custom `format` template overrides the whole
-- text with `{link}`, `{down}`, `{up}`, and `{essid}` keys (absent keys
-- render as "").
function M.network_text(data, essid, options)
  if type(data) ~= "table" and type(data) ~= "userdata" then
    return nil
  end
  if not M.valid_link(data.link) then
    return nil
  end
  local down = M.format_bps(data.down_bps)
  local up = M.format_bps(data.up_bps)
  local clean_essid = nil
  if type(essid) == "string" and essid ~= "" then
    clean_essid = M.truncate_bytes(essid, M.ESSID_MAX_BYTES)
  end
  local format = options.format
  if type(format) == "string" and format ~= "" then
    return M.compact(M.render_template(format, {
      link = data.link,
      down = down or "",
      up = up or "",
      essid = clean_essid or "",
    }))
  end
  local text = data.link
  if down ~= nil or up ~= nil then
    text = text .. " " .. (down or "?") .. "/" .. (up or "?")
  end
  if clean_essid ~= nil then
    text = text .. " (" .. clean_essid .. ")"
  end
  return text
end

-- Network module render: one readout atom, or no atoms when the provider is
-- ungranted, absent, failing, or misshapen. The atom is never clickable (no
-- control wiring exists or is wanted for network).
function M.network_atoms(ctx)
  local options = ctx.options or {}
  local data = M.service_data(M.resolve_service(M.NETWORK_STATE_IFACE))
  local text = M.network_text(data, M.essid_value(), options)
  if text == nil then
    return {}
  end
  return { { text = text } }
end

-- Bluetooth display text, or nil when the snapshot hides (`powered` must be
-- a boolean; counters fall back to 0). The default renders the radio state
-- plus the connected/total device counts while powered.
function M.bluetooth_text(data, options)
  if type(data) ~= "table" and type(data) ~= "userdata" then
    return nil
  end
  if type(data.powered) ~= "boolean" then
    return nil
  end
  local connected = 0
  if is_integer(data.connected_count) and data.connected_count >= 0 then
    connected = math.floor(data.connected_count)
  end
  local total = 0
  if is_integer(data.total_count) and data.total_count >= 0 then
    total = math.floor(data.total_count)
  end
  local status = "off"
  if data.powered then
    status = "on"
  end
  local format = options.format
  if type(format) == "string" and format ~= "" then
    return M.compact(M.render_template(format, {
      status = status,
      connected = tostring(connected),
      total = tostring(total),
      powered = tostring(data.powered),
    }))
  end
  local text = "bt " .. status
  if data.powered and total > 0 then
    text = text .. " (" .. connected .. "/" .. total .. ")"
  end
  return text
end

-- Bluetooth detail text (`alias (address)` per bonded device, bounded), or
-- nil when no device renders. Alias/address rendering stays Lua-side; the
-- enumeration itself stays capped host-side (16 entries plus the truncated
-- flag), so only a display bound applies here.
function M.bluetooth_detail(data)
  if type(data) ~= "table" and type(data) ~= "userdata" then
    return nil
  end
  local devices = data.devices
  if not is_collection(devices) then
    return nil
  end
  local parts = {}
  local count = list_len(devices)
  if count > 16 then
    count = 16
  end
  for index = 1, count do
    local device = devices[index]
    if type(device) == "table" or type(device) == "userdata" then
      if type(device.alias) == "string" and type(device.address) == "string" then
        parts[#parts + 1] = device.alias .. " (" .. device.address .. ")"
      end
    end
  end
  if #parts == 0 then
    return nil
  end
  return M.truncate_bytes(table.concat(parts, ", "), M.TEMPLATE_MAX_BYTES)
end

-- Bluetooth module render: the radio readout, clickable for the power toggle
-- only when the toggle option is set and the separate control interface
-- resolves (deny defaults to a read-only render). Without a toggle binding,
-- device detail rides the tooltip→notify fallback.
function M.bluetooth_atoms(ctx)
  local options = ctx.options or {}
  local data = M.service_data(M.resolve_service(M.BLUETOOTH_STATE_IFACE))
  local text = M.bluetooth_text(data, options)
  if text == nil then
    return {}
  end
  local atom = { text = text }
  if options.toggle == true then
    local control = M.resolve_service(M.BLUETOOTH_CONTROL_IFACE)
    if control ~= nil then
      atom.on_click = M.click_binding(M.BLUETOOTH_TOGGLE_COMMAND)
    end
  end
  if atom.on_click == nil then
    local detail = M.bluetooth_detail(data)
    if detail ~= nil then
      atom.tooltip = detail
    end
  end
  return { atom }
end

-- Whether `delta` is a usable backlight step (percent points per click).
function M.valid_step(delta)
  return is_integer(delta)
    and delta >= -M.BACKLIGHT_STEP_MAX
    and delta <= M.BACKLIGHT_STEP_MAX
end

-- Backlight display text ("75%"), or nil when the snapshot hides (`pct` must
-- read 0..100). A custom `format` template overrides with the `{pct}` key.
function M.backlight_text(data, options)
  if type(data) ~= "table" and type(data) ~= "userdata" then
    return nil
  end
  if type(data.pct) ~= "number" or data.pct ~= math.floor(data.pct) then
    return nil
  end
  local pct = math.floor(data.pct)
  if pct < 0 or pct > 100 then
    return nil
  end
  local format = options.format
  if type(format) == "string" and format ~= "" then
    return M.compact(M.render_template(format, { pct = tostring(pct) }))
  end
  return pct .. "%"
end

-- Backlight module render: the brightness readout, clickable for one step
-- only when the separate control interface resolves (read stays the default).
-- A denied step degrades to a notification in the step command, never a
-- retry or an escalation.
function M.backlight_atoms(ctx)
  local options = ctx.options or {}
  local data = M.service_data(M.resolve_service(M.BACKLIGHT_STATE_IFACE))
  local text = M.backlight_text(data, options)
  if text == nil then
    return {}
  end
  local atom = { text = text }
  local step = options.step
  if step == nil then
    step = M.BACKLIGHT_DEFAULT_STEP
  end
  if M.valid_step(step) then
    local control = M.resolve_service(M.BACKLIGHT_CONTROL_IFACE)
    if control ~= nil then
      atom.on_click = M.click_binding(M.BACKLIGHT_STEP_COMMAND, {
        delta = math.floor(step),
      })
    end
  end
  if atom.on_click == nil then
    if type(options.tooltip) == "string" and options.tooltip ~= "" then
      atom.tooltip = options.tooltip
    end
  end
  return { atom }
end

-- Idle-inhibit display text, or nil when the snapshot hides (`inhibited`
-- must be a boolean). The activated/deactivated glyphs stay config-side via
-- `on_text`/`off_text`.
function M.idle_text(data, options)
  if type(data) ~= "table" and type(data) ~= "userdata" then
    return nil
  end
  if type(data.inhibited) ~= "boolean" then
    return nil
  end
  if data.inhibited then
    if type(options.on_text) == "string" and options.on_text ~= "" then
      return options.on_text
    end
    return "inhibit:on"
  end
  if type(options.off_text) == "string" and options.off_text ~= "" then
    return options.off_text
  end
  return "inhibit:off"
end

-- Idle-inhibit module render: the inhibit state, clickable for the toggle
-- only when the separate control interface resolves (read stays the default).
function M.idle_atoms(ctx)
  local options = ctx.options or {}
  local data = M.service_data(M.resolve_service(M.IDLE_STATE_IFACE))
  local text = M.idle_text(data, options)
  if text == nil then
    return {}
  end
  local atom = { text = text }
  local control = M.resolve_service(M.IDLE_CONTROL_IFACE)
  if control ~= nil then
    atom.on_click = M.click_binding(M.IDLE_TOGGLE_COMMAND)
  end
  if atom.on_click == nil then
    if type(options.tooltip) == "string" and options.tooltip ~= "" then
      atom.tooltip = options.tooltip
    end
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

-- Phase B system modules (bitty-plugins#86 Phase B): broker
-- `owner:iface@version` providers on their contract cadences. Each renders
-- nothing when its provider is ungranted, absent, failing, or misshapen, so
-- one denied device never hides the bar.
M.MODULES.network = {
  name = "network",
  kind = "timer",
  tick_ms = M.NETWORK_TICK_MS,
  tick_floor_ms = M.NETWORK_TICK_MS,
  option_keys = { "format", "tick_ms", "tooltip" },
  render = function(ctx)
    return M.network_atoms(ctx)
  end,
}

M.MODULES.bluetooth = {
  name = "bluetooth",
  kind = "timer",
  tick_ms = M.DEVICE_TICK_MS,
  tick_floor_ms = M.DEVICE_TICK_MS,
  option_keys = { "format", "tick_ms", "tooltip", "toggle" },
  render = function(ctx)
    return M.bluetooth_atoms(ctx)
  end,
}

M.MODULES.backlight = {
  name = "backlight",
  kind = "timer",
  tick_ms = M.DEVICE_TICK_MS,
  tick_floor_ms = M.DEVICE_TICK_MS,
  option_keys = { "format", "tick_ms", "tooltip", "step" },
  render = function(ctx)
    return M.backlight_atoms(ctx)
  end,
}

M.MODULES.idle = {
  name = "idle",
  kind = "timer",
  tick_ms = M.DEVICE_TICK_MS,
  tick_floor_ms = M.DEVICE_TICK_MS,
  option_keys = { "tick_ms", "tooltip", "on_text", "off_text" },
  render = function(ctx)
    return M.idle_atoms(ctx)
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
-- overridable per module, clamped to the rate-policy floor. A module may
-- name a stricter `tick_floor_ms` (device providers sample no faster than
-- their contract cadence); the chassis floor still applies otherwise.
function M.tick_ms(def, options)
  if not is_collection(def) or def.tick_ms == nil then
    return nil
  end
  local ms = def.tick_ms
  if is_collection(options) and is_integer(options.tick_ms) and options.tick_ms >= 1 then
    ms = options.tick_ms
  end
  local floor = M.MIN_TICK_MS
  if is_integer(def.tick_floor_ms) and def.tick_floor_ms > floor then
    floor = def.tick_floor_ms
  end
  if ms < floor then
    ms = floor
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

-- Best-effort control-denial notification for a user-initiated device click.
-- Reads never notify; a denied control call notifies once and never retries
-- or escalates.
local function notify_unavailable(body)
  if bitty.notify == nil or bitty.notify.show == nil then
    return false
  end
  local ok, shown = pcall(bitty.notify.show, {
    title = M.TOOLTIP_TITLE,
    body = body,
  })
  if ok and shown == true then
    return true
  end
  return false
end

bitty.commands.register({
  id = BLUETOOTH_TOGGLE_COMMAND_ID,
  title = "Unified Bar: toggle Bluetooth power",
  description = "Flip the Bluetooth radio power via the bluetooth.control interface.",
  args_schema = {
    type = "object",
    properties = {},
    additionalProperties = false,
  },
  run = function(args)
    local data = M.service_data(M.resolve_service(M.BLUETOOTH_STATE_IFACE))
    if data == nil or type(data.powered) ~= "boolean" then
      return false
    end
    local control = M.resolve_service(M.BLUETOOTH_CONTROL_IFACE)
    if control == nil then
      return false
    end
    local target = not data.powered
    local ok = pcall(function()
      control.set_power(target)
    end)
    if not ok then
      notify_unavailable(M.BLUETOOTH_UNAVAILABLE)
      return false
    end
    pcall(render)
    return true
  end,
})

bitty.commands.register({
  id = BACKLIGHT_STEP_COMMAND_ID,
  title = "Unified Bar: step backlight brightness",
  description = "Step the backlight brightness by delta percent points (DEC-0115: unpermitted attempts degrade to a notification, never escalate).",
  args_schema = {
    type = "object",
    properties = {
      delta = { type = "number", minimum = -M.BACKLIGHT_STEP_MAX, maximum = M.BACKLIGHT_STEP_MAX },
    },
    required = { "delta" },
    additionalProperties = false,
  },
  run = function(args)
    local params = args
    if type(params) ~= "table" and type(params) ~= "userdata" then
      return false
    end
    if not M.valid_step(params.delta) then
      return false
    end
    local control = M.resolve_service(M.BACKLIGHT_CONTROL_IFACE)
    if control == nil then
      return false
    end
    local delta = math.floor(params.delta)
    local ok = pcall(function()
      control.set_step(delta)
    end)
    if not ok then
      notify_unavailable(M.BACKLIGHT_UNAVAILABLE)
      return false
    end
    pcall(render)
    return true
  end,
})

bitty.commands.register({
  id = IDLE_TOGGLE_COMMAND_ID,
  title = "Unified Bar: toggle idle inhibition",
  description = "Flip idle inhibition via the idle.control interface.",
  args_schema = {
    type = "object",
    properties = {},
    additionalProperties = false,
  },
  run = function(args)
    local data = M.service_data(M.resolve_service(M.IDLE_STATE_IFACE))
    if data == nil or type(data.inhibited) ~= "boolean" then
      return false
    end
    local control = M.resolve_service(M.IDLE_CONTROL_IFACE)
    if control == nil then
      return false
    end
    local target = not data.inhibited
    local ok = pcall(function()
      control.set(target)
    end)
    if not ok then
      notify_unavailable(M.IDLE_UNAVAILABLE)
      return false
    end
    pcall(render)
    return true
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
