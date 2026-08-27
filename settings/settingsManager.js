import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";

export const extensionName = "Chronogram";

export const defaultSettings = {
    enabled: true, // Master switch for the whole extension
    autorun: true, // Run the tracker automatically after AI messages
    trackCharacters: true, // Track per-character activities + daily chronograms
    trackObjectives: true, // Track long-term objectives
    autoRunInterval: 1, // Run every X turns (a turn = one user+AI exchange)
    delayTrigger: 0, // Seconds to wait before sending the tracker request
    contextDepth: 10, // How many past messages are sent to the tracker FOR CONTEXT ONLY
    minMessageLength: 50, // Skip tracker runs on very short AI messages
    minMinutesPerTurn: 10, // Floor for story-time advance between two runs
    maxAdvanceHours: 24, // Cap on story-time advance per single run (anti-idle-jump guard)
    injectFormat: "full", // "full" = wrapped with explanation; "raw" = bare block; "none" = not injected
    notificationLevel: "reduced", // "all" | "reduced" | "none"
    trackerProfile: "", // Connection Manager profile id used for the tracker LLM ("" = same as current)
    legacy_api: false, // Swaps connection profiles via slash command before the request
    // Tracker context enrichment (each part individually toggleable)
    trackerIncludePersona: true, // {{user}} persona description
    trackerIncludeScenario: true, // {{scenario}}
    trackerIncludeCharCard: true, // {{char}} card (name/description/personality)
    trackerIncludeWorldInfo: false, // Active World Info entries
    trackerIncludeWIOutlets: false, // WI outlet entries as <outlet> blocks
    contextAsRoles: false, // Send conversation context as user/assistant role messages instead of one flat block
    debug_mode: false,
    // Popup window customizations (position/size/open state are persisted here).
    chronoWindowOpen: false,
    chronoWindowWidth: 400,
    chronoWindowHeight: 600,
    chronoWindowTop: null,
    chronoWindowLeft: null,
};

export function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const s = extension_settings[extensionName];
    // Fill in any defaults added after the settings were first written.
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (s[key] === undefined) s[key] = value;
    }
    return s;
}

export function populateConnectionDropdown(selectElement, currentValue) {
    const ctx = window.SillyTavern?.getContext?.() ?? null;
    selectElement.empty();
    selectElement.append($("<option></option>").val("").text("Same as Current"));

    let profiles = [];
    try {
        const cmActive = !ctx?.extensionSettings?.disabledExtensions?.includes("connection-manager")
            && !!ctx?.extensionSettings?.connectionManager;
        if (cmActive) {
            profiles = ctx.extensionSettings.connectionManager.profiles || [];
        }
    } catch {
        profiles = [];
    }

    for (const p of profiles) {
        selectElement.append($("<option></option>").val(p.id).text(p.name));
    }

    selectElement.val(currentValue || "");
}

let _debounceTimer = null;
function debounce(fn) {
    return (...args) => {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => fn(...args), 500);
    };
}

export function initSettingsListeners() {
    $("#chrono_enabled, #chrono_autorun, #chrono_track_characters, #chrono_track_objectives, #chrono_legacy_api, #chrono_debug_mode, #chrono_include_persona, #chrono_include_scenario, #chrono_include_char_card, #chrono_include_world_info, #chrono_include_wi_outlets, #chrono_context_as_roles").on("change", saveSettings);
    $("#chrono_inject_format, #chrono_notification_level").on("change", saveSettings);
    $("#chrono_profile").on("change", saveSettings);

    // Debounced saving for number/text fields (also fires on blur/change).
    $("#chrono_auto_run_interval, #chrono_context_depth, #chrono_min_message_length, #chrono_delay_trigger, #chrono_min_minutes_turn, #chrono_max_advance_hours")
        .on("input change blur", debounce(saveSettings));
}

export function saveSettings() {
    const s = extension_settings[extensionName];
    if (!s) return;

    s.enabled = $("#chrono_enabled").prop("checked");
    s.autorun = $("#chrono_autorun").prop("checked");
    s.trackCharacters = $("#chrono_track_characters").prop("checked");
    s.trackObjectives = $("#chrono_track_objectives").prop("checked");
    s.legacy_api = $("#chrono_legacy_api").prop("checked");
    s.debug_mode = $("#chrono_debug_mode").prop("checked");
    s.trackerIncludePersona = $("#chrono_include_persona").prop("checked");
    s.trackerIncludeScenario = $("#chrono_include_scenario").prop("checked");
    s.trackerIncludeCharCard = $("#chrono_include_char_card").prop("checked");
    s.trackerIncludeWorldInfo = $("#chrono_include_world_info").prop("checked");
    s.trackerIncludeWIOutlets = $("#chrono_include_wi_outlets").prop("checked");
    s.contextAsRoles = $("#chrono_context_as_roles").prop("checked");
    s.autoRunInterval = Math.max(1, parseInt($("#chrono_auto_run_interval").val(), 10) || 1);
    s.contextDepth = Math.max(0, parseInt($("#chrono_context_depth").val(), 10) || 10);
    s.minMessageLength = Math.max(0, parseInt($("#chrono_min_message_length").val(), 10) || 50);
    s.delayTrigger = Math.min(300, Math.max(0, parseFloat($("#chrono_delay_trigger").val()) || 0));
    s.minMinutesPerTurn = Math.max(0, parseFloat($("#chrono_min_minutes_turn").val()) || 10);
    s.maxAdvanceHours = Math.max(0, parseFloat($("#chrono_max_advance_hours").val()) || 24);
    s.injectFormat = ["full", "raw", "none"].includes($("#chrono_inject_format").val())
        ? $("#chrono_inject_format").val() : "full";
    s.notificationLevel = String($("#chrono_notification_level").val() || "reduced");
    s.trackerProfile = String($("#chrono_profile").val() || "");

    saveSettingsDebounced();
}

// Pushes current stored settings back into the UI (called at startup).
export function applySettingsToUI() {
    const s = extension_settings[extensionName];
    if (!s) return;

    $("#chrono_enabled").prop("checked", s.enabled === true);
    $("#chrono_autorun").prop("checked", s.autorun === true);
    $("#chrono_track_characters").prop("checked", s.trackCharacters !== false);
    $("#chrono_track_objectives").prop("checked", s.trackObjectives !== false);
    $("#chrono_legacy_api").prop("checked", s.legacy_api === true);
    $("#chrono_debug_mode").prop("checked", s.debug_mode === true);
    $("#chrono_include_persona").prop("checked", s.trackerIncludePersona !== false);
    $("#chrono_include_scenario").prop("checked", s.trackerIncludeScenario !== false);
    $("#chrono_include_char_card").prop("checked", s.trackerIncludeCharCard !== false);
    $("#chrono_include_world_info").prop("checked", s.trackerIncludeWorldInfo === true);
    $("#chrono_include_wi_outlets").prop("checked", s.trackerIncludeWIOutlets === true);
    $("#chrono_context_as_roles").prop("checked", s.contextAsRoles === true);
    $("#chrono_auto_run_interval").val(s.autoRunInterval ?? 1);
    $("#chrono_context_depth").val(s.contextDepth ?? 10);
    $("#chrono_min_message_length").val(s.minMessageLength ?? 50);
    $("#chrono_delay_trigger").val(s.delayTrigger ?? 0);
    $("#chrono_min_minutes_turn").val(s.minMinutesPerTurn ?? 10);
    $("#chrono_max_advance_hours").val(s.maxAdvanceHours ?? 24);
    $("#chrono_inject_format").val(s.injectFormat || "full");
    $("#chrono_notification_level").val(s.notificationLevel || "reduced");

    populateConnectionDropdown($("#chrono_profile"), s.trackerProfile);
}
