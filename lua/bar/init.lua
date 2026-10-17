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
-- Clicks dispatch registered commands only and never shell out. Phase B
-- adds the first system modules over broker `owner:iface@version`
-- providers: the device modules (`network`, `bluetooth`, `backlight`,
-- `idle`), the sensor modules (cpu/memory/battery), and the audio pair
-- (`pulseaudio` state/control plus the `spectrum` cava-lite meter), each
-- registering here unchanged when a provider lands. Wheel steps ride
-- the `on_scroll` vehicle (bitty#2008, CTX-1190, host-computed `delta`);
-- true centering (`modules_center`), real tooltips, and the tray need new
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
local BLUETOOTH_TOGGLE_COMMAND_ID = "bluetooth-toggle"
local BACKLIGHT_STEP_COMMAND_ID = "backlight-step"
local IDLE_TOGGLE_COMMAND_ID = "idle-toggle"
local AUDIO_TOGGLE_COMMAND_ID = "audio-toggle"
local AUDIO_STEP_COMMAND_ID = "audio-step"
M.FOCUS_COMMAND = PLUGIN_ID .. ":" .. FOCUS_COMMAND_ID
-- Tooltip-without-command fallback: the click shows the module's detail text
-- as a notification (`bitty.notify.show`) because v1 has no tooltip vehicle.
M.DETAIL_COMMAND = PLUGIN_ID .. ":" .. DETAIL_COMMAND_ID
-- Device-module control commands (Phase B): each calls exactly one control
-- method on its own control interface and never anything else.
M.BLUETOOTH_TOGGLE_COMMAND = PLUGIN_ID .. ":" .. BLUETOOTH_TOGGLE_COMMAND_ID
M.BACKLIGHT_STEP_COMMAND = PLUGIN_ID .. ":" .. BACKLIGHT_STEP_COMMAND_ID
M.IDLE_TOGGLE_COMMAND = PLUGIN_ID .. ":" .. IDLE_TOGGLE_COMMAND_ID
-- Audio control targets (CTX-1220, bitty#2013): click mutes, wheel steps the
-- volume. Both dispatch registered commands only and never shell out.
M.AUDIO_TOGGLE_COMMAND = PLUGIN_ID .. ":" .. AUDIO_TOGGLE_COMMAND_ID
M.AUDIO_STEP_COMMAND = PLUGIN_ID .. ":" .. AUDIO_STEP_COMMAND_ID

-- Bounds mirrored from the retired Core workspaceline so the retirement is
-- behavior-preserving (bitty@55f9d336 `crates/bitty-runtime/src/runtime/workspaces.rs`).
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
-- so a host with repeating timers needs no bar change. The floor is the
-- fastest allowed provider poll: the audio spectrum 5 Hz ceiling (200 ms,
-- bitty#2013 contract `SPECTRUM_MIN_INTERVAL_MS`); slower modules (state
-- 2 s, clock 60 s) stay above it, and over-poll coalesces host-side.
M.MIN_TICK_MS = 200

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
-- Phase B sensor providers (bitty#2019 cpu, bitty#2011 memory, bitty#2016
-- battery). The native component `bitty-terminal.sensors` serves the short
-- interfaces `system.cpu` / `system.memory` / `system.battery` at `1.0.0`
-- with one read-only method (`get`), each backed 1:1 by a read-only head
-- (`platform.cpu-read` / `platform.memory-read` / `platform.battery-read`).
-- Provider-side ceilings with over-poll coalescing (2s cpu/memory, 5s
-- battery) and stale-then-hide live in the provider; thresholds and icon
-- buckets live here in Lua (the provider returns raw numbers/states only).
-- Negotiation passes an explicit `{ version, optional = true }` so the call
-- is accepted by the host bridge (where the manifest `[services.required]`
-- entry supplies the fallback requirement) and by the SDK mock host (which
-- mandates `opts.version`); the whole negotiation stays inside pcall so an
-- ungranted or absent provider hides the module fail closed.
M.SENSOR_VERSION_REQ = "^1.0"
M.CPU_IFACE = "system.cpu"
M.MEMORY_IFACE = "system.memory"
M.BATTERY_IFACE = "system.battery"
-- Module cadences poll at the provider ceilings (bitty
-- `system_sensors::common::{FAST,SLOW}_SENSOR_CEILING_MS`), so one tick
-- serves one fresh sample without over-polling.
M.CPU_TICK_MS = 2000
M.MEMORY_TICK_MS = 2000
M.BATTERY_TICK_MS = 5000
-- Threshold defaults (percent). CPU/memory read hot at or above the marks;
-- a discharging battery reads low at or below the marks.
M.CPU_WARNING_DEFAULT = 80
M.CPU_CRITICAL_DEFAULT = 90
M.MEMORY_WARNING_DEFAULT = 80
M.MEMORY_CRITICAL_DEFAULT = 90
M.BATTERY_WARNING_DEFAULT = 30
M.BATTERY_CRITICAL_DEFAULT = 15
-- Display formats over the bounded template renderer.
M.CPU_DEFAULT_FORMAT = "{total}%"
M.MEMORY_DEFAULT_FORMAT = "{pct}%"
M.BATTERY_DEFAULT_FORMAT = "{icon} {capacity}%"
-- Battery icon buckets (ASCII only, five levels by capacity). The charging
-- mark is appended while charging; level and alarm selection stay in Lua.
M.BATTERY_ICONS = { "[    ]", "[=   ]", "[==  ]", "[=== ]", "[====]" }
M.BATTERY_CHARGING_MARK = "+"
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

-- Audio provider contract (CTX-1220, bitty#2013; bitty PRs #2058/#2071 are
-- read-only here). Interfaces served by the native `bitty-terminal.audio`
-- provider: `audio.state@1.0.0` (`get()`), `audio.control@1.0.0`
-- (`set_volume`/`toggle_mute`), `audio.spectrum@1.0.0` (`spectrum`).
-- Rate: state 2 s, spectrum 5 Hz / <=32 buckets / <=1 KiB, control 10 Hz
-- coalesced (over-poll serves last-good host-side, never floods the VM).
-- Scopes: fixed-`pactl`-argv monitor, no shell (host-side; Lua never spawns
-- and never touches `wpctl`). Fail-closed: an absent monitor hides the module
-- (never zeros, never fabrication). Manifest heads (`audio.state.read`,
-- `audio.state.control`, `audio.spectrum`) ride the SDK closed-set parity
-- follow-up; until granted, the optional negotiation below resolves nil and
-- the modules hide, which is the same fail-closed posture.
M.AUDIO_STATE_IFACE = "audio.state"
M.AUDIO_CONTROL_IFACE = "audio.control"
M.AUDIO_SPECTRUM_IFACE = "audio.spectrum"
M.AUDIO_VERSION_REQ = ">=1.0"
-- State poll cadence: the 2 s read ceiling (`STATE_MIN_INTERVAL_MS`).
M.AUDIO_TICK_MS = 2000
-- Spectrum poll cadence: 4 fps cava-lite (250 ms), inside the 5 Hz ceiling.
-- Full-rate 60 fps cava is explicitly out of scope (not a plugin-VM workload).
M.SPECTRUM_TICK_MS = 250
M.SPECTRUM_BUCKETS_DEFAULT = 8
M.SPECTRUM_BUCKETS_MAX = 32 -- SPECTRUM_MAX_BUCKETS (response capped at 1 KiB)
M.VOLUME_MAX_PCT = 100
M.VOLUME_STEP_MAX_PCT = 10 -- VOLUME_STEP_MAX_PCT (over-bound denied, never clamped)
M.AUDIO_PORT_MAX_BYTES = 64 -- AUDIO_MAX_PORT_BYTES (validation bound)
-- Port display width (characters) when the text carries the port. The full
-- port name stays in the tooltip for Phase C real tooltips.
M.AUDIO_PORT_DISPLAY_CHARS = 16
-- Volume icons (portable ASCII; Nerd-Font glyphs are a theme concern, not
-- data). Thresholds mirror Waybar-style low/med/high bands.
M.AUDIO_ICON_MUTED = "MUTE"
M.AUDIO_ICON_LOW = "LO"
M.AUDIO_ICON_MED = "MED"
M.AUDIO_ICON_HIGH = "HI"
-- Spectrum block glyphs (U+2581-U+2588) as byte escapes (no `utf8` library;
-- the file stays in the Lua 5.1 grammar). Index 1 is silence (a space keeps
-- the meter width stable); indexes 2-9 are one-eighth through full block.
M.SPECTRUM_GLYPHS = {
  " ",
  "\226\150\129",
  "\226\150\130",
  "\226\150\131",
  "\226\150\132",
  "\226\150\133",
  "\226\150\134",
  "\226\150\135",
  "\226\150\136",
}
-- Spectrum smoothing policy (pure Lua): instant attack, linear falloff per
-- tick, and a slow peak decay. Peaks hold briefly so transients stay visible
-- at 4 fps without a second row.
M.SPECTRUM_FALLOFF = 0.15
M.SPECTRUM_PEAK_DECAY = 0.05
M.SPECTRUM_PEAK_HOLD_TICKS = 4

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
--
-- Portable substitution (bar#15): the phodopus production VM rejects
-- `string.gsub` with a function replacement, so matches are walked with
-- `string.find` (the same ASCII-only `{(%w+)}` pattern) and spliced with
-- `string.sub`. Byte-identical to the gsub form: matches resolve
-- left-to-right without overlap, a missing key keeps its literal `{key}`,
-- and present values splice via `tostring` with no `%`-escape processing.
function M.render_template(format, data, max_bytes)
  if type(format) ~= "string" then
    return ""
  end
  if not is_collection(data) then
    data = {}
  end
  local cap = max_bytes or M.TEMPLATE_MAX_BYTES
  local bounded = M.truncate_bytes(format, cap)
  local out = {}
  local pos = 1
  local n = #bounded
  while pos <= n do
    local s, e, key = string.find(bounded, "{(%w+)}", pos)
    if s == nil then
      out[#out + 1] = string.sub(bounded, pos)
      break
    end
    if s > pos then
      out[#out + 1] = string.sub(bounded, pos, s - 1)
    end
    local value = data[key]
    if value == nil then
      out[#out + 1] = string.sub(bounded, s, e)
    else
      out[#out + 1] = tostring(value)
    end
    pos = e + 1
  end
  return M.truncate_bytes(table.concat(out), cap)
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

-- Ordered bar segments before the byte bound: one capsule per workspace
-- (`[stable-id:name]` plus state marks) and single-space separators. The
-- scratchpad indicator remains available after the capsule list when the slot is
-- occupied. The id is the stable workspace seq from
-- `bitty.workspace.list()` (Core `workspaceline_tokens` renders `slot.seq`),
-- so closing a workspace never renumbers the survivors. Without an occupied
-- scratchpad the concatenated text equals Core `workspaceline_text` for the
-- same rows.
function M.segments(rows, opts)
  if #rows == 0 then
    return { { kind = "empty", text = M.EMPTY_PLACEHOLDER } }
  end
  local ordered = {}
  for index, row in ipairs(rows) do
    ordered[index] = row
  end
  for index = 2, #ordered do
    local row = ordered[index]
    local cursor = index - 1
    while cursor >= 1 and ordered[cursor].id > row.id do
      ordered[cursor + 1] = ordered[cursor]
      cursor = cursor - 1
    end
    ordered[cursor + 1] = row
  end
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
  local scratchpad = M.scratchpad_segment(rows)
  if scratchpad ~= nil then
    out[#out + 1] = scratchpad
  end
  return out
end

-- Converts one workspaces segment to a chassis atom. Atom shape:
-- `{ text, bold?, fg?, on_click?, tooltip? }`. Only inactive pills are
-- clickable: separators, the active capsule, the empty
-- placeholder, and the scratchpad indicator switch nothing (Core
-- `workspaceline_hit_test` / `workspaceline_click`).
local function segment_atom(segment)
  local atom = { text = segment.text, whole = true }
  if segment.kind == "pill" then
    if segment.active then
      atom.bold = true
      atom.fg = "background"
      atom.bg = "accent"
    elseif segment.attention then
      atom.fg = "cursor"
    elseif segment.occupied then
      atom.bold = true
    end
    if not segment.active then
      atom.on_click = M.click_binding(M.FOCUS_COMMAND, { id = segment.id })
    end
  elseif segment.kind == "separator" then
    atom.separator = true
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
-- Whether an audio state snapshot is usable: `volume_pct` 0..100, `muted`
-- boolean, `port` a non-empty string within the byte bound. Anything else
-- (absent fields, out-of-range volume, over-long port) reads as unusable so
-- the module hides instead of painting garbage.
function M.audio_valid_snapshot(snap)
  if type(snap) ~= "table" and type(snap) ~= "userdata" then
    return false
  end
  local ok, valid = pcall(function()
    local vol = snap.volume_pct
    if not is_integer(vol) or vol < 0 or vol > M.VOLUME_MAX_PCT then
      return false
    end
    if type(snap.muted) ~= "boolean" then
      return false
    end
    local port = snap.port
    if type(port) ~= "string" or port == "" or #port > M.AUDIO_PORT_MAX_BYTES then
      return false
    end
    return true
  end)
  return ok and valid == true
end

-- Volume icon for a validated snapshot: muted (or parked at zero) reads
-- `MUTE`; otherwise low/med/high bands. Pure; thresholds are presentation
-- policy and live entirely Lua-side.
function M.audio_icon(snap)
  if snap.muted == true or snap.volume_pct == 0 then
    return M.AUDIO_ICON_MUTED
  end
  if snap.volume_pct < 34 then
    return M.AUDIO_ICON_LOW
  end
  if snap.volume_pct < 67 then
    return M.AUDIO_ICON_MED
  end
  return M.AUDIO_ICON_HIGH
end

-- Audio module text: `{icon} {volume}%` plus `:{port}` when `show_port` is
-- set (default true; the port is truncated to `port_max_chars`). A `format`
-- option overrides the shape via the bounded `{key}` template with keys
-- `icon`, `volume`, `port`, and `muted`. Fail closed to "" on a bad snapshot.
function M.audio_text(snap, options)
  if not M.audio_valid_snapshot(snap) then
    return ""
  end
  options = options or {}
  local port_chars = M.AUDIO_PORT_DISPLAY_CHARS
  if is_integer(options.port_max_chars) and options.port_max_chars >= 1
    and options.port_max_chars <= M.AUDIO_PORT_MAX_BYTES then
    port_chars = options.port_max_chars
  end
  local port_short = M.truncate_chars(snap.port, port_chars)
  local data = {
    icon = M.audio_icon(snap),
    volume = tostring(snap.volume_pct),
    port = port_short,
    muted = tostring(snap.muted),
  }
  if type(options.format) == "string" and options.format ~= "" then
    return M.render_template(options.format, data, M.TEMPLATE_MAX_BYTES)
  end
  local show_port = options.show_port
  if show_port == nil then
    show_port = true
  end
  local text = data.icon .. " " .. data.volume .. "%"
  if show_port == true then
    text = text .. ":" .. port_short
  end
  return text
end

-- Audio tooltip: the full port name (untruncated display goes to the text).
-- Nil when there is no usable snapshot.
function M.audio_tooltip(snap)
  if not M.audio_valid_snapshot(snap) then
    return nil
  end
  return snap.port
end

-- Coalesces one wheel/scroll delta into a bounded integer volume step, or nil
-- when there is nothing to do. The host injects `delta` as signed lines
-- (positive for wheel-up); fractional sub-line ticks floor to a no-op and
-- bursts clamp to one step (saturating, never widened). Mirrors the host
-- `ControlGate` burst discipline Lua-side so a 100-tick burst drains as one
-- bounded `set_volume({ delta })` call. NaN and infinities are rejected.
function M.volume_step(delta)
  if type(delta) ~= "number" then
    return nil
  end
  if delta ~= delta then
    return nil
  end
  if delta == math.huge or delta == -math.huge then
    return nil
  end
  local step = math.floor(math.abs(delta))
  if delta < 0 then
    step = -step
  end
  if step == 0 then
    return nil
  end
  if step > M.VOLUME_STEP_MAX_PCT then
    step = M.VOLUME_STEP_MAX_PCT
  end
  if step < -M.VOLUME_STEP_MAX_PCT then
    step = -M.VOLUME_STEP_MAX_PCT
  end
  return step
end

-- Block glyph for one spectrum level in 0..1 (clamped). Out-of-range values
-- clamp to the rails; non-numbers read as silence so one bad tap never hides
-- the meter.
function M.spectrum_glyph(level)
  if type(level) ~= "number" or level ~= level then
    return M.SPECTRUM_GLYPHS[1]
  end
  if level < 0 then
    level = 0
  end
  if level > 1 then
    level = 1
  end
  local index = math.floor(level * 8) + 1
  return M.SPECTRUM_GLYPHS[index]
end

-- Spectrum meter text: one glyph per bucket, bounded to 32 buckets (96 bytes
-- worst case, well inside the 1 KiB response cap and the line bound).
-- Non-collection or empty input reads as "" (the caller hides the module).
function M.spectrum_text(levels)
  if not is_collection(levels) then
    return ""
  end
  local count = list_len(levels)
  if count < 1 then
    return ""
  end
  if count > M.SPECTRUM_BUCKETS_MAX then
    count = M.SPECTRUM_BUCKETS_MAX
  end
  local out = {}
  for index = 1, count do
    local ok, level = pcall(function()
      return levels[index]
    end)
    if ok then
      out[#out + 1] = M.spectrum_glyph(level)
    else
      out[#out + 1] = M.SPECTRUM_GLYPHS[1]
    end
  end
  return table.concat(out)
end

-- One smoothing step (pure): instant attack on rising taps, linear falloff on
-- falling ones. A nil/empty previous state adopts the new levels. Lengths
-- follow the new sample (the provider owns the bucket count); missing entries
-- read as silence.
function M.spectrum_falloff(prev_levels, new_levels)
  local count = list_len(new_levels)
  if count < 1 then
    return {}
  end
  if count > M.SPECTRUM_BUCKETS_MAX then
    count = M.SPECTRUM_BUCKETS_MAX
  end
  local prev_count = list_len(prev_levels)
  local out = {}
  for index = 1, count do
    local target = new_levels[index]
    if type(target) ~= "number" or target ~= target then
      target = 0
    end
    if target < 0 then
      target = 0
    end
    if target > 1 then
      target = 1
    end
    local prev = 0
    if prev_levels ~= nil and index <= prev_count then
      local raw = prev_levels[index]
      if type(raw) == "number" and raw == raw then
        prev = math.min(1, math.max(0, raw))
      end
    end
    if target >= prev then
      out[index] = target
    else
      local decayed = prev - M.SPECTRUM_FALLOFF
      if decayed < target then
        decayed = target
      end
      out[index] = decayed
    end
  end
  return out
end

-- One peak-hold step (pure): each peak holds for `M.SPECTRUM_PEAK_HOLD_TICKS`
-- renders, then decays at `M.SPECTRUM_PEAK_DECAY` per tick. The previous
-- state rides two parallel arrays (`prev_levels`, `prev_hold`; either may be
-- nil to adopt the current levels with a fresh hold) so every argument stays
-- a flat level array. Returns the next peak state as
-- `{ levels = {...}, hold = {...} }`; the caller renders `max(smoothed, peak)`
-- per bucket so transients hold briefly at 4 fps.
function M.spectrum_peak_step(prev_levels, prev_hold, levels)
  local count = list_len(levels)
  if count < 1 then
    return { levels = {}, hold = {} }
  end
  if count > M.SPECTRUM_BUCKETS_MAX then
    count = M.SPECTRUM_BUCKETS_MAX
  end
  local prev_level_count = list_len(prev_levels)
  local prev_hold_count = list_len(prev_hold)
  local out_levels = {}
  local out_hold = {}
  for index = 1, count do
    local level = levels[index]
    if type(level) ~= "number" or level ~= level then
      level = 0
    end
    level = math.min(1, math.max(0, level))
    local held_level = 0
    local held_ticks = 0
    if index <= prev_level_count then
      local raw_ok, raw = pcall(function()
        return prev_levels[index]
      end)
      if raw_ok and type(raw) == "number" and raw == raw then
        held_level = math.min(1, math.max(0, raw))
      end
    end
    if index <= prev_hold_count then
      local hold_ok, raw_hold = pcall(function()
        return prev_hold[index]
      end)
      if hold_ok and type(raw_hold) == "number" and raw_hold > 0 then
        held_ticks = math.floor(raw_hold)
      end
    end
    if level >= held_level then
      out_levels[index] = level
      out_hold[index] = M.SPECTRUM_PEAK_HOLD_TICKS
    elseif held_ticks > 0 then
      out_levels[index] = held_level
      out_hold[index] = held_ticks - 1
    else
      local decayed = held_level - M.SPECTRUM_PEAK_DECAY
      if decayed < level then
        decayed = level
      end
      out_levels[index] = decayed
      out_hold[index] = 0
    end
  end
  return { levels = out_levels, hold = out_hold }
end

-- Meter row with peak-hold applied (pure): per-bucket `max(smoothed, peak)`.
-- Both inputs are plain level arrays; a missing side reads as silence.
function M.spectrum_with_peaks(smoothed, peaks)
  local count = list_len(smoothed)
  local peak_count = list_len(peaks)
  if count < 1 then
    return {}
  end
  if count > M.SPECTRUM_BUCKETS_MAX then
    count = M.SPECTRUM_BUCKETS_MAX
  end
  local out = {}
  for index = 1, count do
    local base = smoothed[index]
    if type(base) ~= "number" or base ~= base then
      base = 0
    end
    local peak = 0
    if index <= peak_count then
      local raw = peaks[index]
      if type(raw) == "number" and raw == raw then
        peak = raw
      end
    end
    if peak > base then
      out[index] = peak
    else
      out[index] = base
    end
  end
  return out
end

-- Broker negotiation (optional, fail-closed): resolves one audio interface at
-- `M.AUDIO_VERSION_REQ`, or nil when the provider is absent, the version
-- mismatches, or the head is ungranted. Every caller wraps this in `pcall`,
-- so a throwing bridge reads the same as an absent one (hidden, never loud).
local function audio_service(iface)
  if bitty == nil or bitty.services == nil or bitty.services.get == nil then
    return nil
  end
  local ok, svc = pcall(bitty.services.get, iface, {
    version = M.AUDIO_VERSION_REQ,
    optional = true,
  })
  if not ok or svc == nil then
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

-- Negotiated provider handles, keyed by short interface. Successes cache for
-- the generation; failures retry on the next poll so a late provider lights
-- up without a reload. Negotiation is a local directory lookup, never I/O.
M._providers = {}

-- Resolves one sensor provider, or nil when the provider is absent,
-- ungranted, or the negotiation itself is rejected (for example an
-- undeclared `[services.required]` entry on the host, which fails the
-- resolution as an error rather than a nil). Every failure hides the module
-- fail closed; none of them may fail activation.
function M.negotiate(iface)
  if M._providers[iface] ~= nil then
    return M._providers[iface]
  end
  if bitty == nil or bitty.services == nil or bitty.services.get == nil then
    return nil
  end
  local ok, handle = pcall(
    bitty.services.get,
    iface,
    { version = M.SENSOR_VERSION_REQ, optional = true }
  )
  if not ok or handle == nil then
    return nil
  end
  M._providers[iface] = handle
  return handle
end

-- Polls one negotiated provider, or nil when the sample is stale past the
-- provider horizon, the grant was revoked mid-generation, or the call
-- itself fails. The provider never fabricates zeros: a nil poll hides.
function M.poll(handle)
  if type(handle) ~= "table" and type(handle) ~= "userdata" then
    return nil
  end
  local get = handle.get
  if type(get) ~= "function" then
    return nil
  end
  local ok, snapshot = pcall(get, {})
  if not ok or snapshot == nil then
    return nil
  end
  if type(snapshot) ~= "table" and type(snapshot) ~= "userdata" then
    return nil
  end
  return snapshot
end

-- A numeric snapshot field, or nil when absent or mistyped. A malformed
-- snapshot hides the module; the provider contract pins every key.
local function snap_number(snapshot, key)
  local value = snapshot[key]
  if type(value) ~= "number" then
    return nil
  end
  return value
end

-- A text snapshot field, or nil when absent or mistyped.
local function snap_text(snapshot, key)
  local value = snapshot[key]
  if type(value) ~= "string" then
    return nil
  end
  return value
end

-- Display rounding for a percent in `[0, 100]`, or nil when not a number.
function M.round_pct(value)
  if type(value) ~= "number" then
    return nil
  end
  return math.floor(value + 0.5)
end

-- Display rounding to one decimal, or nil when not a number.
function M.round1(value)
  if type(value) ~= "number" then
    return nil
  end
  return math.floor(value * 10 + 0.5) / 10
end

-- Display text for a rounded number that reads identically on Lua 5.1 and
-- 5.3+: whole values render without a trailing `.0` (5.4 floats), fractions
-- keep one decimal. Returns "" when not a number.
function M.num1(value)
  if type(value) ~= "number" then
    return ""
  end
  if value == math.floor(value) then
    return tostring(math.floor(value))
  end
  return tostring(M.round1(value))
end

-- A duration in seconds as `1h23m` / `45m` / `30s`, or nil when unusable.
function M.format_duration(seconds)
  if type(seconds) ~= "number" or seconds < 0 then
    return nil
  end
  local total = math.floor(seconds)
  local hours = math.floor(total / 3600)
  local minutes = math.floor((total % 3600) / 60)
  if hours > 0 then
    return hours .. "h" .. minutes .. "m"
  end
  if minutes > 0 then
    return minutes .. "m"
  end
  return (total % 60) .. "s"
end

-- Core count from a `per_core` array, tolerant of the bridge shape (a JSON
-- array crosses as a table or as indexable userdata; anything else reads 0
-- and the aggregate still renders).
function M.core_count(per_core)
  if type(per_core) == "table" then
    return #per_core
  end
  if type(per_core) == "userdata" then
    local ok, count = pcall(function()
      return #per_core
    end)
    if ok and type(count) == "number" then
      return math.floor(count)
    end
  end
  return 0
end

-- Alarm state for a value that reads hot at or above the marks (cpu,
-- memory), or nil when the value is not a number.
function M.hot_state(value, warning, critical)
  if type(value) ~= "number" then
    return nil
  end
  if value >= critical then
    return "critical"
  end
  if value >= warning then
    return "warning"
  end
  return "normal"
end

-- Alarm state for a value that reads low at or below the marks (a
-- discharging battery), or nil when the value is not a number.
function M.low_state(value, warning, critical)
  if type(value) ~= "number" then
    return nil
  end
  if value <= critical then
    return "critical"
  end
  if value <= warning then
    return "warning"
  end
  return "normal"
end

-- Validated warning/critical pair from per-module options with shipped
-- defaults, as `{ warning, critical }`. Each mark falls back independently
-- when it is not a number in `[0, 100]`; an inverted pair falls back
-- wholesale so a bad configuration can neither pin an alarm on nor silence
-- one (`hot` requires warning < critical, low requires warning > critical).
function M.thresholds(options, warn_default, crit_default, hot)
  local warning = warn_default
  local critical = crit_default
  local w = options.warning
  local c = options.critical
  if type(w) == "number" and w >= 0 and w <= 100 then
    warning = w
  end
  if type(c) == "number" and c >= 0 and c <= 100 then
    critical = c
  end
  if hot then
    if warning >= critical then
      warning = warn_default
      critical = crit_default
    end
  else
    if warning <= critical then
      warning = warn_default
      critical = crit_default
    end
  end
  return { warning = warning, critical = critical }
end

-- Battery icon bucket (1..5) by capacity, or nil when not a number.
function M.battery_bucket(capacity)
  if type(capacity) ~= "number" then
    return nil
  end
  if capacity < 10 then
    return 1
  end
  if capacity < 35 then
    return 2
  end
  if capacity < 65 then
    return 3
  end
  if capacity < 90 then
    return 4
  end
  return 5
end

-- Battery icon for a capacity/state pair (`""` when the capacity is not a
-- number). The charging mark rides the icon; the alarm rides the theme
-- token, never the glyph.
function M.battery_icon(capacity, state)
  local bucket = M.battery_bucket(capacity)
  if bucket == nil then
    return ""
  end
  local icon = M.BATTERY_ICONS[bucket]
  if state == "charging" then
    icon = icon .. M.BATTERY_CHARGING_MARK
  end
  return icon
end

-- CPU module render: one atom from the `system.cpu` snapshot, or no atoms
-- (fail-closed hide) when the provider is absent, ungranted, stale past the
-- horizon, or malformed. Thresholds evaluate Lua-side; the provider sends
-- raw numbers only.
function M.cpu_atoms(ctx)
  local options = ctx.options or {}
  local snapshot = nil
  local handle = M.negotiate(M.CPU_IFACE)
  if handle ~= nil then
    snapshot = M.poll(handle)
  end
  if snapshot == nil then
    return {}
  end
  local total = snap_number(snapshot, "total_pct")
  if total == nil then
    return {}
  end
  local marks = M.thresholds(
    options,
    M.CPU_WARNING_DEFAULT,
    M.CPU_CRITICAL_DEFAULT,
    true
  )
  local state = M.hot_state(total, marks.warning, marks.critical)
  local shown = M.round_pct(total)
  local format = options.format
  if type(format) ~= "string" or format == "" then
    format = M.CPU_DEFAULT_FORMAT
  end
  local text = M.render_template(
    format,
    { total = shown, total_pct = shown },
    M.TEMPLATE_MAX_BYTES
  )
  if text == "" then
    return {}
  end
  local atom = { text = text }
  if state == "warning" or state == "critical" then
    atom.fg = M.state_token(state)
  end
  local detail = options.tooltip
  if type(detail) ~= "string" or detail == "" then
    detail = "CPU " .. shown .. "% (" .. M.core_count(snapshot.per_core) .. " cores)"
  end
  atom.tooltip = detail
  return { atom }
end

-- Memory module render: one atom from the `system.memory` snapshot, or no
-- atoms when the provider is absent, ungranted, stale, or malformed. Swap
-- rides the tooltip detail when the source reports a swap total.
function M.memory_atoms(ctx)
  local options = ctx.options or {}
  local snapshot = nil
  local handle = M.negotiate(M.MEMORY_IFACE)
  if handle ~= nil then
    snapshot = M.poll(handle)
  end
  if snapshot == nil then
    return {}
  end
  local pct = snap_number(snapshot, "pct")
  local used = snap_number(snapshot, "used_gib")
  local total = snap_number(snapshot, "total_gib")
  if pct == nil or used == nil or total == nil then
    return {}
  end
  local marks = M.thresholds(
    options,
    M.MEMORY_WARNING_DEFAULT,
    M.MEMORY_CRITICAL_DEFAULT,
    true
  )
  local state = M.hot_state(pct, marks.warning, marks.critical)
  local shown = M.round_pct(pct)
  local format = options.format
  if type(format) ~= "string" or format == "" then
    format = M.MEMORY_DEFAULT_FORMAT
  end
  local text = M.render_template(format, {
    pct = shown,
    used = M.num1(used),
    total = M.num1(total),
    swap_pct = M.num1(snap_number(snapshot, "swap_pct")),
    swap_used = M.num1(snap_number(snapshot, "swap_used_gib")),
    swap_total = M.num1(snap_number(snapshot, "swap_total_gib")),
  }, M.TEMPLATE_MAX_BYTES)
  if text == "" then
    return {}
  end
  local atom = { text = text }
  if state == "warning" or state == "critical" then
    atom.fg = M.state_token(state)
  end
  local detail = options.tooltip
  if type(detail) ~= "string" or detail == "" then
    detail = "Memory "
      .. M.num1(used)
      .. "/"
      .. M.num1(total)
      .. " GiB ("
      .. shown
      .. "%)"
    local swap_total = snap_number(snapshot, "swap_total_gib")
    if swap_total ~= nil and swap_total > 0 then
      local swap_used = snap_number(snapshot, "swap_used_gib")
      if swap_used == nil then
        swap_used = 0
      end
      detail = detail
        .. ", swap "
        .. M.num1(swap_used)
        .. "/"
        .. M.num1(swap_total)
        .. " GiB"
    end
  end
  atom.tooltip = detail
  return { atom }
end

-- Battery module render: one atom from the `system.battery` snapshot, or no
-- atoms when the source is absent (batteryless or UPower-less with no
-- sysfs battery), ungranted, stale, or malformed. Only a discharging
-- battery alarms on low capacity; every other state renders the icon with
-- the default presentation.
function M.battery_atoms(ctx)
  local options = ctx.options or {}
  local snapshot = nil
  local handle = M.negotiate(M.BATTERY_IFACE)
  if handle ~= nil then
    snapshot = M.poll(handle)
  end
  if snapshot == nil then
    return {}
  end
  local capacity = snap_number(snapshot, "capacity_pct")
  local state = snap_text(snapshot, "state")
  if capacity == nil or state == nil then
    return {}
  end
  local icon = M.battery_icon(capacity, state)
  if icon == "" then
    return {}
  end
  local shown = M.round_pct(capacity)
  local format = options.format
  if type(format) ~= "string" or format == "" then
    format = M.BATTERY_DEFAULT_FORMAT
  end
  local text = M.render_template(format, {
    icon = icon,
    capacity = shown,
    capacity_pct = shown,
    state = state,
  }, M.TEMPLATE_MAX_BYTES)
  if text == "" then
    return {}
  end
  local atom = { text = text }
  if state == "discharging" then
    local marks = M.thresholds(
      options,
      M.BATTERY_WARNING_DEFAULT,
      M.BATTERY_CRITICAL_DEFAULT,
      false
    )
    local alarm = M.low_state(capacity, marks.warning, marks.critical)
    if alarm == "warning" or alarm == "critical" then
      atom.fg = M.state_token(alarm)
    end
  end
  local detail = options.tooltip
  if type(detail) ~= "string" or detail == "" then
    detail = "Battery " .. shown .. "% " .. state
    local power = snap_number(snapshot, "power_w")
    if power ~= nil then
      detail = detail .. " " .. M.num1(power) .. "W"
    end
    local seconds = snapshot.seconds_to_empty
    if type(seconds) == "number" then
      local duration = M.format_duration(seconds)
      if duration ~= nil then
        detail = detail .. " " .. duration .. " left"
      end
    end
  end
  atom.tooltip = detail
  return { atom }
end

-- Whether the control head resolves (click/scroll bindings only). Read-only
-- render carries no command when this is nil.
function M.audio_control_present()
  return audio_service(M.AUDIO_CONTROL_IFACE) ~= nil
end

-- One validated state snapshot, or nil when the monitor is absent or the
-- sample fails validation (fail closed to hidden).
function M.audio_snapshot()
  local svc = audio_service(M.AUDIO_STATE_IFACE)
  if svc == nil or svc.get == nil then
    return nil
  end
  local ok, snap = pcall(svc.get)
  if not ok or not M.audio_valid_snapshot(snap) then
    return nil
  end
  return snap
end

-- One validated spectrum sample (`levels` array, 1..32 finite taps), or nil
-- when the meter is absent or the sample is malformed. `buckets` out of range
-- reads as nil (the render falls back to the default count instead).
function M.spectrum_sample(buckets)
  if buckets == nil then
    buckets = M.SPECTRUM_BUCKETS_DEFAULT
  end
  if not is_integer(buckets) or buckets < 1 or buckets > M.SPECTRUM_BUCKETS_MAX then
    return nil
  end
  local svc = audio_service(M.AUDIO_SPECTRUM_IFACE)
  if svc == nil or svc.spectrum == nil then
    return nil
  end
  local ok, res = pcall(svc.spectrum, { buckets = buckets })
  if not ok or (type(res) ~= "table" and type(res) ~= "userdata") then
    return nil
  end
  local levels
  local levels_ok = pcall(function()
    levels = res.levels
  end)
  if not levels_ok or not is_collection(levels) then
    return nil
  end
  local count = list_len(levels)
  if count < 1 or count > M.SPECTRUM_BUCKETS_MAX then
    return nil
  end
  for index = 1, count do
    local tap_ok, tap = pcall(function()
      return levels[index]
    end)
    if not tap_ok or type(tap) ~= "number" or tap ~= tap then
      return nil
    end
  end
  return levels
end

-- Toggle mute through the control head. Returns true on an admitted call,
-- false when the head is absent, denied, or rate-limited (fail closed; the
-- caller re-polls `get()` for the new level on success).
function M.audio_toggle()
  local svc = audio_service(M.AUDIO_CONTROL_IFACE)
  if svc == nil or svc.toggle_mute == nil then
    return false
  end
  local ok = pcall(svc.toggle_mute, {})
  return ok == true
end

-- Step the volume through the control head. `delta` is the host-computed
-- scroll `delta` (signed lines) or any caller number; bursts clamp to one
-- bounded step and sub-line fractions are a no-op. Returns true on an
-- admitted call, false otherwise (fail closed, never clamped past ±10).
function M.audio_step(delta)
  local step = M.volume_step(delta)
  if step == nil then
    return false
  end
  local svc = audio_service(M.AUDIO_CONTROL_IFACE)
  if svc == nil or svc.set_volume == nil then
    return false
  end
  local ok = pcall(svc.set_volume, { delta = step })
  return ok == true
end

-- PulseAudio module render: one atom from the state snapshot, or {} when the
-- monitor is absent (fail closed to hidden). Click mutes and wheel steps only
-- when the control head resolves; otherwise the atom is read-only text with
-- the port tooltip (a tooltip beside a command would need a Phase C vehicle,
-- so the clickable atom carries the port in its text instead).
function M.pulseaudio_atoms(ctx)
  local snap = M.audio_snapshot()
  if snap == nil then
    return {}
  end
  local options = nil
  if ctx ~= nil then
    options = ctx.options
  end
  local text = M.audio_text(snap, options)
  if text == "" then
    return {}
  end
  local atom = { text = text }
  local tooltip = M.audio_tooltip(snap)
  if tooltip ~= nil then
    atom.tooltip = tooltip
  end
  if M.audio_control_present() then
    atom.on_click = M.click_binding(M.AUDIO_TOGGLE_COMMAND, {})
    atom.on_scroll = M.click_binding(M.AUDIO_STEP_COMMAND, {})
  end
  return { atom }
end

-- Module-local spectrum display state (per activation generation): the last
-- smoothed row, the parallel peak-hold arrays, and the last painted text
-- (for pause).
M._spectrum_prev = nil
M._spectrum_peak_levels = nil
M._spectrum_peak_hold = nil
M._spectrum_last_text = nil

-- Spectrum module render: one meter atom from the live sample with falloff
-- and peak-hold applied, or {} when the meter is absent (hidden until a live
-- source lands host-side). `options.buckets` (1..32, default 8) sizes the
-- sample; out-of-range counts fall back to the default. `options.paused`
-- freezes the last row without polling.
function M.spectrum_atoms(ctx)
  local options = nil
  if ctx ~= nil then
    options = ctx.options
  end
  if type(options) ~= "table" and type(options) ~= "userdata" then
    options = {}
  end
  local paused = false
  local paused_ok, paused_raw = pcall(function()
    return options.paused
  end)
  if paused_ok and paused_raw == true then
    paused = true
  end
  if paused and M._spectrum_last_text ~= nil then
    return { { text = M._spectrum_last_text } }
  end
  local buckets = M.SPECTRUM_BUCKETS_DEFAULT
  local buckets_ok, buckets_raw = pcall(function()
    return options.buckets
  end)
  if buckets_ok and is_integer(buckets_raw)
    and buckets_raw >= 1 and buckets_raw <= M.SPECTRUM_BUCKETS_MAX then
    buckets = buckets_raw
  end
  local levels = M.spectrum_sample(buckets)
  if levels == nil then
    return {}
  end
  local smoothed = M.spectrum_falloff(M._spectrum_prev, levels)
  M._spectrum_prev = smoothed
  local peaks = M.spectrum_peak_step(
    M._spectrum_peak_levels,
    M._spectrum_peak_hold,
    smoothed
  )
  M._spectrum_peak_levels = peaks.levels
  M._spectrum_peak_hold = peaks.hold
  local row = M.spectrum_with_peaks(smoothed, peaks.levels)
  local text = M.spectrum_text(row)
  if text == "" then
    return {}
  end
  M._spectrum_last_text = text
  local atom = { text = text }
  local tooltip_ok, tooltip_raw = pcall(function()
    return options.tooltip
  end)
  if tooltip_ok and type(tooltip_raw) == "string" and tooltip_raw ~= "" then
    atom.tooltip = tooltip_raw
  end
  return { atom }
end

-- In-plugin module registry (bitty-plugins#86 Phase A chassis, Phase B
-- sensor and audio modules). Each entry declares how it renders and how it
-- refreshes:
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
-- PulseAudio state module (Phase B provider module, bitty#2013): volume,
-- mute, and port from `audio.state@1.0.0` with icon selection Lua-side.
-- Click mutes via `audio.control@1.0.0`; wheel steps the volume through the
-- same head (bounded ±10, 10 Hz coalesced host-side). Read-only when the
-- control head is ungranted (no click/scroll binding); hidden when the state
-- monitor is absent (fail closed, never zeros).
M.MODULES.pulseaudio = {
  name = "pulseaudio",
  kind = "timer",
  tick_ms = M.AUDIO_TICK_MS,
  option_keys = { "format", "tick_ms", "tooltip", "show_port", "port_max_chars" },
  render = function(ctx)
    return M.pulseaudio_atoms(ctx)
  end,
}

-- Spectrum cava-lite meter (Phase B provider module, bitty#2013): block
-- glyphs (U+2581-U+2588) in a Text node at 4 fps. Falloff smoothing and
-- peak-hold run in Lua; `paused = true` freezes the last row. Hidden until a
-- live spectrum source lands host-side (the `pactl` monitor exposes no level
-- taps by design, so the meter hides rather than fabricates).
M.MODULES.spectrum = {
  name = "spectrum",
  kind = "timer",
  tick_ms = M.SPECTRUM_TICK_MS,
  option_keys = { "buckets", "tick_ms", "tooltip", "paused" },
  render = function(ctx)
    return M.spectrum_atoms(ctx)
  end,
}

M.MODULES.cpu = {
  name = "cpu",
  kind = "timer",
  tick_ms = M.CPU_TICK_MS,
  option_keys = { "format", "warning", "critical", "tick_ms", "tooltip" },
  render = function(ctx)
    return M.cpu_atoms(ctx)
  end,
}

M.MODULES.memory = {
  name = "memory",
  kind = "timer",
  tick_ms = M.MEMORY_TICK_MS,
  option_keys = { "format", "warning", "critical", "tick_ms", "tooltip" },
  render = function(ctx)
    return M.memory_atoms(ctx)
  end,
}

M.MODULES.battery = {
  name = "battery",
  kind = "timer",
  tick_ms = M.BATTERY_TICK_MS,
  option_keys = { "format", "warning", "critical", "tick_ms", "tooltip" },
  render = function(ctx)
    return M.battery_atoms(ctx)
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

-- Bound on live pre-armed ticks per generation (bar#17): v1 timers are
-- one-shot and creation closes after activation, so repeats are pre-armed as
-- a bounded chain of one-shot ticks while the window is open. The bound fits
-- the tightest host timer budget (mock `TIMERS_MAX` 32; production admits
-- 64), so a full chain always arms on either host; a plan that still exceeds
-- the budget arms a prefix and degrades to fewer repeats, never a violation.
M.TIMER_CHAIN_CAP = 32
-- Minimum chained ticks per timer module: the repeat proof advances twice
-- (fresh values, rollover), so even the largest plan repeats at least twice.
M.TIMER_CHAIN_MIN = 2

-- Chained ticks per timer module (first tick plus follow-ups) for a plan
-- with `count` timer modules, sharing the cap evenly. 0 when the plan has
-- no timer module.
function M.chain_ticks(count)
  if not is_integer(count) or count < 1 then
    return 0
  end
  local per = math.floor(M.TIMER_CHAIN_CAP / count)
  if per < M.TIMER_CHAIN_MIN then
    per = M.TIMER_CHAIN_MIN
  end
  if per > M.TIMER_CHAIN_CAP then
    per = M.TIMER_CHAIN_CAP
  end
  return per
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
    if atom.whole and #text > remaining then
      break
    end
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
  if out[#out] ~= nil and (out[#out].separator or out[#out].module_gap) then
    out[#out] = nil
  end
  return out
end

-- Scene node for one atom. A tooltip with no command binds the detail command
-- (tooltip→notify fallback); anything else stays non-interactive. A scroll
-- binding rides alongside (wheel steps never replace the click target).
function M.atom_node(atom)
  local node = { kind = "Text", text = atom.text }
  if atom.bold == true then
    node.bold = true
  end
  if atom.fg ~= nil then
    node.fg = atom.fg
  end
  if atom.bg ~= nil then
    node.bg = atom.bg
  end
  if atom.on_click ~= nil then
    node.on_click = atom.on_click
  elseif atom.tooltip ~= nil then
    node.on_click = { command = M.DETAIL_COMMAND, args = { text = atom.tooltip } }
  end
  if atom.on_scroll ~= nil then
    node.on_scroll = atom.on_scroll
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
          atoms[#atoms + 1] = { text = M.MODULE_GAP, module_gap = true }
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

-- Arms one timer module (bar#17): the first tick at the module cadence plus
-- follow-up ticks at multiples of the cadence, all pre-armed while the
-- activation window is open. Every tick re-polls providers and re-renders,
-- so repeated timer advances repaint with fresh values with no
-- post-activation `timers.create`. The first tick additionally re-arms one
-- single tick optimistically; Plugin API v1 closes timer creation after
-- activation (ADR 0009 LUA-OQ-12), so that re-arm fails closed on v1 hosts
-- (the pre-armed chain already covers the repeats) while a host with
-- repeating timers continues past the chain with no bar change. Follow-up
-- ticks render only, so a repeating host never accumulates parallel loops.
-- Called only while the bar is visible (pause-on-hidden).
local function arm_timer(name, spec, extra)
  local def = M.MODULES[name]
  local ms = M.tick_ms(def, spec.options)
  if ms == nil then
    return
  end
  if not is_integer(extra) or extra < 0 then
    extra = 0
  end
  local function arm_once(delay_ms, rearm)
    local ok, handle = pcall(function()
      return bitty.timers.create(delay_ms, function()
        render()
        if rearm then
          arm_once(ms, true)
        end
      end)
    end)
    if ok and type(handle) == "number" then
      timers[#timers + 1] = handle
    end
  end
  arm_once(ms, true)
  for k = 2, extra + 1 do
    arm_once(ms * k, false)
  end
end

-- Whether the `timers.create` window is open (bar#17): v1 closes timer
-- creation after activation, so a `config.reloaded` handler must not cancel
-- the live activation chain it cannot replace. The probe creates and cancels
-- one zero-delay timer; only openness is read (the handle is dropped
-- immediately either way).
local function registration_open()
  local ok, handle = pcall(function()
    return bitty.timers.create(0, function() end)
  end)
  if ok and type(handle) == "number" then
    pcall(bitty.timers.cancel, handle)
    return true
  end
  return false
end

-- (Re)creates the timer set for the current plan; called at activation and on
-- config.reloaded. Hidden bars arm nothing (pause-on-hidden). Past the
-- activation window the live chain is kept (every chained tick re-polls the
-- reloaded plan through the shared `render`, at the previous cadences) and
-- only an immediate re-render is issued by the caller.
local function reschedule()
  if not registration_open() then
    return
  end
  for _, handle in ipairs(timers) do
    pcall(bitty.timers.cancel, handle)
  end
  timers = {}
  if not M.visible(bitty.workspace.list(), opts) then
    return
  end
  local count = 0
  for _, spec in ipairs(opts.specs) do
    local def = M.MODULES[spec.name]
    if def ~= nil and def.tick_ms ~= nil then
      count = count + 1
    end
  end
  local per = M.chain_ticks(count)
  for _, spec in ipairs(opts.specs) do
    local def = M.MODULES[spec.name]
    if def ~= nil and def.tick_ms ~= nil then
      arm_timer(spec.name, spec, per - 1)
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

-- Audio control commands (CTX-1220, bitty#2013): click mutes, wheel steps.
-- Both fail closed (false) when the control head is absent, denied, or
-- rate-limited; the bar re-polls `get()` for the new level on success.
bitty.commands.register({
  id = AUDIO_TOGGLE_COMMAND_ID,
  title = "Unified Bar: toggle audio mute",
  description = "Toggle the default sink mute through audio.control (pulseaudio module click target).",
  args_schema = {
    type = "object",
    additionalProperties = false,
  },
  run = function(_args)
    return M.audio_toggle()
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

bitty.commands.register({
  id = AUDIO_STEP_COMMAND_ID,
  title = "Unified Bar: step audio volume",
  description = "Step the default sink volume through audio.control (pulseaudio module wheel target; host-computed delta in signed lines).",
  args_schema = {
    type = "object",
    properties = {
      delta = { type = "number" },
    },
    required = { "delta" },
    additionalProperties = false,
  },
  run = function(args)
    local delta = nil
    local ok, raw = pcall(function()
      return args.delta
    end)
    if ok then
      delta = raw
    end
    return M.audio_step(delta)
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
  -- Grants may have changed with the reload: drop negotiated handles so the
  -- next poll re-negotiates instead of serving a revoked generation.
  M._providers = {}
  reschedule()
  render()
end)

reschedule()

return M
