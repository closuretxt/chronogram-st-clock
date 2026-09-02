// Chronogram tracker: builds the prompt, runs it through a SillyTavern
// Connection profile via ConnectionManagerRequestService, parses the result
// and applies the new world clock, daily schedules and objectives.
// Mirrors Persist's tracker pipeline 1:1 where possible.

import { substituteParams } from "../../../../../script.js";
import { extension_settings } from "../../../../extensions.js";
import { getWorldInfoPrompt } from "../../../../world-info.js";
import {
    logDebug,
    getST,
    resolveConnectionProfile,
    getProfileNameById,
    parse_reasoning,
    shouldRetryRequest,
    showErrorToast,
} from "../util/connectionProfiles.js";
import { swapProfile } from "../util/profileSwapper.js";
import { getChronoPrompt } from "../settings/defaultPrompt.js";
import {
    getStateRoot,
    getClock,
    setClock,
    advanceClock,
    getOrCreateParticipant,
    getParticipants,
    getActiveParticipants,
    updateActiveParticipants,
    replaceSchedule,
    pruneSchedules,
    getScheduleFor,
    addObjective,
    updateObjective,
    setObjectiveStatus,
    createSnapshot,
    restoreSnapshot,
    saveState,
    stripCurrentMarker,
} from "./state.js";
import { parseChronoResponse } from "./parser.js";
import { pipelineBar } from "../ui/pipelineBar.js";

export const extensionName = "Chronogram";

let isRunning = false;
let isCancelled = false;
let lastRunMessageId = -1; // Swipe/re-entry guard

function waitBeforeRequest() {
    const seconds = Math.min(300, Math.max(0, Number(extension_settings[extensionName]?.delayTrigger) || 0));
    if (seconds <= 0) return Promise.resolve();
    logDebug(`Waiting ${seconds} second(s) before Chronogram request.`);
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// Called by stop buttons / interrupting flows.
export function cancelTracker() {
    isCancelled = true;
}

export function resetTrackerGuard() {
    lastRunMessageId = -1;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Ghost/system messages (hidden narrator notes, injected system text, etc.)
// must never reach the tracker prompt.
function isGhostMessage(m) {
    if (!m) return true;
    if (m.is_system === true || m.is_system === "true") return true;
    if (m.is_hidden === true || m.is_hidden === "true") return true;
    if (!String(m.mes ?? "").trim()) return true;
    return false;
}

function getAutoRunInterval() {
    const settings = extension_settings[extensionName] || {};
    return Math.max(1, parseInt(settings.autoRunInterval, 10) || 1);
}


// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildCurrentStateBlock() {
    const settings = extension_settings[extensionName] || {};
    const trackCharacters = settings.trackCharacters !== false;
    const trackObjectives = settings.trackObjectives !== false;

    const clock = getClock();
    // Only participants still present in the story context reach the tracker:
    // archived ones keep their data but are invisible until they reappear.
    const participants = trackCharacters ? getActiveParticipants() : {};
    const objectives = (getStateRoot()?.objectives || []);
    const lines = [];

    lines.push(`<chronogram_state>`);
    lines.push(clock
        ? `Current world clock: Date:${clock.date} Time:${clock.time}`
        : "Current world clock: NOT ESTABLISHED YET");

    if (trackCharacters) {
        const entries = Object.entries(participants);
        if (entries.length === 0) {
            lines.push("Participants: none tracked yet.");
        } else {
            lines.push("Participants (PRESENT characters only - today's plan):");
            for (const [id, p] of entries) {
                lines.push(`<participant name="${id}">`);
                // ONLY today's plan (matching the current clock date) is injected.
                // Plans stored for other dates stay in state but are NEVER sent:
                // after a rollback or manual clock edit they desync from the world
                // clock and would inject a second, conflicting date/time into the
                // prompt (e.g. clock = 04/12 next to a "plan for 04/13").
                if (clock?.date) {
                    const sched = getScheduleFor(id, clock.date);
                    if (sched.length > 0) {
                        for (const e of sched) lines.push(`${e.time} ${stripCurrentMarker(e.activity)}`);
                    } else {
                        // Explicit demand instead of a passive note: without
                        // it a character that lost its schedule to a reset or
                        // rollback stayed "open" until the NEXT date change.
                        lines.push(`NO CHRONOGRAM for ${clock.date} - build a full schedule for this character in a <new_schedule> (Date:${clock.date}) this run.`);
                    }
                }
                lines.push(`</participant>`);
            }
        }
    }

    if (trackObjectives) {
        const active = objectives.filter(o => o.status === "active");
        const done = objectives.filter(o => o.status !== "active").slice(-5); // recent history only
        if (active.length === 0 && done.length === 0) {
            lines.push("Objectives: none yet.");
        } else {
            lines.push("Long-term objectives (reference Titles EXACTLY as written):");
            for (const o of [...active, ...done]) {
                const bits = [
                    `Owner:${o.owner}`,
                    `Title:${o.title}`,
                    o.description ? `Description:${o.description}` : "",
                    o.deadline ? `Deadline:${o.deadline}` : "",
                    o.steps ? `Steps:${o.steps}` : "",
                    o.progress ? `Progress:${o.progress}` : "",
                    `Status:${o.status}`,
                ].filter(Boolean);
                lines.push("- " + bits.join(" | "));
            }
        }
    }

    lines.push("</chronogram_state>");
    return lines.join("\n");
}

// History context + the exchanges to analyze, split into three explicit
// regions: CONTEXT (reference only), FROM (<last_tracked_turn> + state) and
// TO (<last_turn>, the only exchange that advances the clock).

// Shared message-set extraction so both context modes (flat block / roles)
// see exactly the same history and target messages.
function getContextMessages() {
    const st = getST();
    const settings = extension_settings[extensionName] || {};
    const depth = Math.max(0, settings.contextDepth ?? 10);
    const interval = getAutoRunInterval();

    const visibleChat = st.chat.filter(m => !isGhostMessage(m));
    const targetCount = Math.min(visibleChat.length, interval * 2);
    // The PREVIOUSLY tracked exchange: the targetCount messages right before
    // the current target. The world clock currently stands at the END of this
    // exchange, so it is tagged <last_tracked_turn> in the prompt as the
    // comparison anchor for the delta (everything after it is new).
    const previousStart = Math.max(0, visibleChat.length - targetCount * 2);
    const previous = visibleChat.slice(previousStart, visibleChat.length - targetCount);
    return {
        history: visibleChat.slice(0, previousStart).slice(-depth),
        previous,
        target: visibleChat.slice(-targetCount),
    };
}

function messageLine(m) {
    return `${m.name || (m.is_user ? "User" : "Assistant")}: ${m.mes}`;
}

function messageRole(m) {
    if (m.is_system === true || m.is_system === "true") return "system";
    return m.is_user ? "user" : "assistant";
}

// The header line that accompanies the exchange to analyze: setup announces
// the first run. Real-world time between runs is deliberately NOT sent - the
// LLM judges story time from the fiction alone; the elapsed clamps only act
// as the deterministic fallback tick when it emits nothing parseable.
function buildContextHeader(mode) {
    if (mode === "setup") {
        return "This is the FIRST Chronogram run for this chat: establish the clock, participants and schedules (see SETUP mode in your instructions).";
    }
    return "";
}

// Wording for the <last_tracked_turn> tag: the FROM anchor - the PREVIOUS
// exchange, which was already tracked (the world clock reflects its end), so
// the model compares FROM to TO and judges the delta instead of guessing.
const LAST_TRACKED_INTRO = "FROM (already tracked): the PREVIOUS exchange below was ALREADY tracked - the world clock in <chronogram_state> stands right after it ended. Reference only: never advance the clock for anything here. The exchange in <last_turn> is the TO anchor: NEW and NOT yet tracked.";

// CONTEXT region: older history (reference only) + the FROM anchor. Only
// meaningful once the clock exists (normal mode); in setup mode there is no
// previously tracked moment to anchor on.
function buildContextBlock(mode) {
    const { history, previous } = getContextMessages();

    const lines = [];

    if (history.length > 0) {
        const historyLines = history.map(messageLine).join("\n");
        lines.push(`<conversation_context>\nReference only - older history, already accounted for by previous runs:\n${historyLines}\n</conversation_context>`);
    }

    if (mode === "normal" && previous.length > 0) {
        const prevLines = previous.map(messageLine).join("\n\n");
        lines.push(`<last_tracked_turn>\n${LAST_TRACKED_INTRO}\n\n${prevLines}\n</last_tracked_turn>`);
    }

    return lines.join("\n\n");
}

// The TO anchor: the NEW, untracked exchange. Sent as a separate user message
// AFTER the <chronogram_state> block, so the model reads "here is where the
// clock stands" first and then the exchange (user + assistant turns) that
// advances it.
function buildExchangesBlock(mode) {
    const { target } = getContextMessages();
    const targetLines = target.map(messageLine).join("\n\n");

    const lines = [];
    const header = buildContextHeader(mode);
    if (header) lines.push(header);
    lines.push(`<exchanges_to_analyze>\nTO (analyze this): everything inside <last_turn> is NEW and NOT yet tracked - the ONLY exchange that advances the clock:\n<last_turn>\n${targetLines || "(no messages)"}\n</last_turn>\n</exchanges_to_analyze>`);
    return lines.join("\n\n");
}

// Optional story-reference data sent before the state block: user persona,
// scenario, character card, World Info and WI outlets. Every part is
// individually toggleable from the "Tracker Context" settings drawer.
async function buildStoryInfoBlock(chatStrings) {
    const settings = extension_settings[extensionName] || {};
    const st = getST();
    const parts = [];

    const persona = settings.trackerIncludePersona !== false
        ? String(substituteParams("{{persona}}") || "").trim() : "";
    const scenario = settings.trackerIncludeScenario !== false
        ? String(st.scenario || substituteParams("{{scenario}}") || "").trim() : "";

    let charBlock = "";
    if (settings.trackerIncludeCharCard !== false) {
        const char = st.characters?.[st.characterId];
        if (char) {
            const cardLines = [
                char.name ? `<name>${char.name}</name>` : "",
                char.description ? `<description>${char.description}</description>` : "",
                char.personality ? `<personality>${char.personality}</personality>` : "",
            ].filter(Boolean);
            if (cardLines.length > 0) charBlock = cardLines.join("\n");
        }
    }

    const infoLines = [
        persona ? `<user_persona>\n${persona}\n</user_persona>` : "",
        scenario ? `<scenario>\n${scenario}\n</scenario>` : "",
        charBlock ? `<char>\n${charBlock}\n</char>` : "",
    ].filter(Boolean);
    if (infoLines.length > 0) {
        parts.push(`<story_info>\n${infoLines.join("\n")}\n</story_info>`);
    }

    // World Info + outlets (Recast-style): fetched from the active World Info.
    const wantsWI = settings.trackerIncludeWorldInfo === true || settings.trackerIncludeWIOutlets === true;
    if (wantsWI && typeof getWorldInfoPrompt === "function") {
        try {
            const wi = await getWorldInfoPrompt(chatStrings, 100000, true);
            if (wi && typeof wi === "object") {
                if (settings.trackerIncludeWorldInfo === true) {
                    const wiText = `${wi.worldInfoBefore || ""}\n${wi.worldInfoAfter || ""}`.trim();
                    if (wiText) parts.push(`<world_info>\n${wiText}\n</world_info>`);
                }
                if (settings.trackerIncludeWIOutlets === true) {
                    for (const [name, contents] of Object.entries(wi.outletEntries || {})) {
                        const text = Array.isArray(contents) ? contents.join("\n") : String(contents);
                        if (text.trim()) parts.push(`<outlet name="${name}">\n${text}\n</outlet>`);
                    }
                }
            }
        } catch (e) {
            logDebug("Chronogram: World Info fetch failed (continuing without it):", e);
        }
    }

    return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Request execution (Connection profile aware)
// ---------------------------------------------------------------------------

async function requestTracker(messages, connectionProfileId) {
    const st = getST();
    const settings = extension_settings[extensionName];
    const TargetProfileName = getProfileNameById(st, connectionProfileId);
    const OriginalProfileName = st.extensionSettings?.connectionManager?.selectedProfileName
        || getProfileNameById(st, resolveConnectionProfile(st, ""));

    if (!st.ConnectionManagerRequestService?.sendRequest) {
        throw new Error("ConnectionManagerRequestService.sendRequest is unavailable. Is the Connection Manager extension enabled?");
    }

    let swappedProfile = false;

    async function doRequest(profileId) {
        if (settings.legacy_api && TargetProfileName && TargetProfileName !== OriginalProfileName) {
            const swapSuccess = await swapProfile(TargetProfileName, OriginalProfileName);
            if (swapSuccess) swappedProfile = true;
        }
        logDebug(`Chronogram request: profile='${profileId || "<same-as-current>"}'`);
        await waitBeforeRequest();
        if (isCancelled) return "";
        const createGenerator = await st.ConnectionManagerRequestService.sendRequest(
            profileId,
            messages,
            undefined,
            { stream: false }
        );

        if (typeof createGenerator === "function") {
            const generator = createGenerator();
            let streamResult = "";
            for await (const chunk of generator) {
                if (chunk && chunk.text !== undefined) streamResult = chunk.text;
            }
            return streamResult;
        }

        if (createGenerator && typeof createGenerator === "object") {
            return createGenerator.content || createGenerator.text || String(createGenerator);
        }
        return "";
    }

    try {
        return await doRequest(connectionProfileId);
    } catch (firstError) {
        const fallbackProfile = resolveConnectionProfile(st, "");
        if (shouldRetryRequest(firstError) && fallbackProfile !== connectionProfileId) {
            logDebug("Chronogram first request failed; retrying with fallback profile.");
            return await doRequest(fallbackProfile);
        }
        throw firstError;
    } finally {
        if (swappedProfile && OriginalProfileName) {
            try {
                await swapProfile(OriginalProfileName, TargetProfileName);
            } catch (e) {
                console.warn("[Chronogram] Failed to restore original connection profile:", e);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

// Applies one parsed update object to the state. Returns a summary for
// notifications.
function applyUpdate(update) {
    const beforeClock = getClock();
    const event = {
        oldDate: beforeClock?.date || null,
        newDate: null,
        newTime: null,
        schedules: 0,
        newObjectives: [],
        updatedObjectives: [],
        completedObjectives: [],
        abandonedObjectives: [],
    };

    // 1. Clock. The LLM is the ONLY source of time: setup runs (and any
    // absolute leftover) carry Date/Time directly; normal runs report a DELTA
    // (time passed since the state clock). No valid value = no advance.
    if (update.clock) {
        if (update.clock.date && update.clock.time) {
            setClock(update.clock.date, update.clock.time);
            event.newDate = update.clock.date;
            event.newTime = update.clock.time;
        } else if (beforeClock && Number.isFinite(update.clock.deltaMinutes)) {
            const advanced = advanceClock(beforeClock, update.clock.deltaMinutes * 60000);
            setClock(advanced.date, advanced.time);
            event.newDate = advanced.date;
            event.newTime = advanced.time;
        }
    }

    // 2. Schedules: only when character tracking is enabled.
    const trackCharacters = (extension_settings[extensionName] || {}).trackCharacters !== false;
    const trackObjectives = (extension_settings[extensionName] || {}).trackObjectives !== false;

    if (trackCharacters) {
        for (const sched of update.schedules) {
            getOrCreateParticipant(sched.ownerId, sched.displayName);
            replaceSchedule(sched.ownerId, sched.date, sched.entries);
            event.schedules++;
        }
        pruneSchedules(2);
    }

    // 4. Objectives: only when objective tracking is enabled.
    if (!trackObjectives) {
        saveState();
        return event;
    }
    for (const obj of update.newObjectives) {
        const created = addObjective(obj);
        if (created && !event.newObjectives.some(t => t === created.title)) {
            event.newObjectives.push(created.title);
        }
    }
    for (const uo of update.updateObjectives) {
        const updated = updateObjective(uo.ownerId, uo.title, { progress: uo.progress, deadline: uo.deadline });
        if (updated && !event.updatedObjectives.some(t => t === updated.title)) {
            event.updatedObjectives.push(updated.title);
        }
    }
    for (const co of update.completeTitles) {
        const done = setObjectiveStatus(co.ownerId, co.title, "completed");
        if (done && !event.completedObjectives.some(t => t === done.title)) {
            event.completedObjectives.push(done.title);
        }
    }
    for (const ao of update.abandonTitles) {
        const dropped = setObjectiveStatus(ao.ownerId, ao.title, "abandoned");
        if (dropped && !event.abandonedObjectives.some(t => t === dropped.title)) {
            event.abandonedObjectives.push(dropped.title);
        }
    }

    saveState();
    return event;
}

function notifyEvent(event) {
    if (typeof toastr === "undefined") return;
    const level = extension_settings[extensionName]?.notificationLevel || "reduced";
    if (level === "none") return;

    const dayChanged = event.newDate && event.oldDate && event.newDate !== event.oldDate;

    if (level === "reduced") {
        if (dayChanged) toastr.info(`A new day begins: ${event.newDate}.`, "Chronogram", { timeOut: 5000 });
        for (const title of event.completedObjectives) {
            toastr.success(`Objective complete: ${title}`, "Chronogram", { timeOut: 6000 });
        }
        return;
    }

    // "all": full detail toast.
    if (!dayChanged && event.newObjectives.length === 0
        && event.updatedObjectives.length === 0 && event.completedObjectives.length === 0
        && event.abandonedObjectives.length === 0 && event.schedules === 0) {
        return; // clock-only churn
    }
    const lines = [];
    if (event.newDate) lines.push(`Clock: ${event.newDate} ${event.newTime ?? ""}`);
    if (dayChanged) lines.push(`NEW DAY: ${event.newDate}`);
    if (event.schedules > 0) lines.push(`Schedules built: ${event.schedules}`);
    for (const t of event.newObjectives) lines.push(`New objective: ${t}`);
    for (const t of event.updatedObjectives) lines.push(`Updated objective: ${t}`);
    for (const t of event.completedObjectives) lines.push(`Completed objective: ${t}`);
    for (const t of event.abandonedObjectives) lines.push(`Abandoned objective: ${t}`);
    toastr.info(lines.join("<br>"), "Chronogram", { timeOut: 10000 });
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

export async function runTracker(messageId = null, options = {}) {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled) {
        return { skipped: true, reason: "disabled" };
    }
    if (isRunning) {
        logDebug("Chronogram already running; skipping.");
        return { skipped: true, reason: "busy" };
    }

    const st = getST();
    const startId = messageId ?? (st.chat?.length ?? 1) - 1;
    if (startId <= 0) {
        return { skipped: true, reason: "no_exchange" };
    }

    // Auto runs must be anchored to the message that fired the event. If that
    // message is empty/hidden it is a "ghost", and the walk-back below would
    // silently skip it and re-process an OLDER message instead - so empty AI
    // responses ended up triggering the tracker on stale content. Bail out
    // instead. (Manual runs keep the walk-back: pressing the button with an
    // empty last message should still track the latest real content.)
    const triggerMsg = st.chat[startId];
    if (options.manual !== true && triggerMsg && !triggerMsg.is_user && isGhostMessage(triggerMsg)) {
        logDebug(`Message ${startId} is empty/hidden; skipping auto run.`);
        return { skipped: true, reason: "empty_message" };
    }

    // Walk backwards to the most recent VALID target (a non-ghost AI message).
    let effectiveMessageId = -1;
    for (let i = startId; i > 0; i--) {
        const msg = st.chat[i];
        if (!msg || msg.is_user) continue;
        if (isGhostMessage(msg)) continue;
        effectiveMessageId = i;
        break;
    }
    if (effectiveMessageId < 0) {
        return { skipped: true, reason: "not_ai_message" };
    }
    if (effectiveMessageId === lastRunMessageId) {
        logDebug(`Message ${effectiveMessageId} already tracked (re-entry guard).`);
        return { skipped: true, reason: "already_tracked" };
    }

    // Skip short messages: nothing meaningful to track yet.
    const minLen = settings.minMessageLength ?? 50;
    const msgLength = String(st.chat[effectiveMessageId]?.mes ?? "").trim().length;
    if (msgLength < minLen && options.manual !== true) {
        logDebug(`Message ${effectiveMessageId} too short (${msgLength} < ${minLen} chars); skipping.`);
        return { skipped: true, reason: "too_short" };
    }

    isRunning = true;
    lastRunMessageId = effectiveMessageId;
    isCancelled = false;

    let barCompleted = false;
    try {
        const root = getStateRoot();
        const mode = root.anchored ? "normal" : "setup";

        // Presence pass: archive participants no longer mentioned in the
        // recent context so the tracker state only lists who is present.
        updateActiveParticipants();

        if (typeof st.ConnectionManagerRequestService?.sendRequest !== "function") {
            throw new Error("ConnectionManagerRequestService is unavailable. Is the Connection Manager extension enabled?");
        }

        // Progress bar with a stop button (mirrors Persist's pipeline bar).
        pipelineBar.init(cancelTracker);
        pipelineBar.start(1, String(st.chat[effectiveMessageId]?.mes ?? ""));
        pipelineBar.updatePass(0, "Tracking chronogram");

        // Assemble the tracker conversation in three explicit regions:
        // CONTEXT (system prompt + story info + older history + the FROM
        // anchor), the FROM state (<chronogram_state>), and finally the TO
        // anchor - the new exchange to analyze.
        const messages = [
            { role: "system", content: substituteParams(getChronoPrompt(mode, {
                trackCharacters: settings.trackCharacters !== false,
                trackObjectives: settings.trackObjectives !== false,
            })) },
        ];

        const storyInfo = await buildStoryInfoBlock(
            st.chat.filter(m => !isGhostMessage(m)).map(m => String(m.mes ?? "")).reverse()
        );
        if (storyInfo) messages.push({ role: "user", content: storyInfo });

        if (settings.contextAsRoles === true) {
            // "Send Context as Roles": history and the latest exchange go in as
            // proper user/assistant turns instead of one flat text block.
            // Order mirrors the flat mode: older history FIRST (context),
            // then the FROM anchor, the state, and finally the TO anchor.
            const { history, previous, target } = getContextMessages();
            for (const m of history) {
                messages.push({ role: messageRole(m), content: messageLine(m) });
            }
            if (mode === "normal" && previous.length > 0) {
                // FROM anchor: fenced between system-role tag markers so the
                // model knows where the clock stands.
                messages.push({ role: "system", content: `<last_tracked_turn>\n${LAST_TRACKED_INTRO}` });
                for (const m of previous) {
                    messages.push({ role: messageRole(m), content: messageLine(m) });
                }
                messages.push({ role: "system", content: "</last_tracked_turn>" });
            }
            // Current tracked state AFTER the FROM anchor, in its own user
            // message: the model reads where the clock stands (right after the
            // <last_tracked_turn> exchange), then gets the new exchange
            // (user + assistant turns) that advances it.
            messages.push({ role: "user", content: buildCurrentStateBlock() });
            // The latest exchange gets its own fence: this is the content the
            // delta is measured over.
            messages.push({ role: "system", content: "<last_turn>" });
            for (const m of target) {
                messages.push({ role: messageRole(m), content: messageLine(m) });
            }
            messages.push({ role: "system", content: "</last_turn>" });
            const header = buildContextHeader(mode);
            messages.push({
                role: "user",
                content: `${header ? header + "\n\n" : ""}<exchanges_to_analyze>\nTO (analyze this): the exchange above, wrapped in <last_turn>, is NEW and NOT yet tracked.\n</exchanges_to_analyze>`,
            });
        } else {
            messages.push({ role: "user", content: substituteParams(buildContextBlock(mode)) });
            // Current tracked state BEFORE the last exchange, in its own user
            // message (see the roles-mode comment above for the rationale).
            messages.push({ role: "user", content: buildCurrentStateBlock() });
            messages.push({ role: "user", content: substituteParams(buildExchangesBlock(mode)) });
        }

        if (isCancelled) return { skipped: true, reason: "cancelled" };
        const profileId = resolveConnectionProfile(st, settings.trackerProfile || "");
        const raw = await requestTracker(messages, profileId);
        if (isCancelled) return { skipped: true, reason: "cancelled" };

        const cleaned = parse_reasoning(raw, profileId);
        logDebug("Chronogram raw response:", cleaned);
        pipelineBar.updatePass(0, "Applying update");

        const update = parseChronoResponse(cleaned);
        const trackCharacters = settings.trackCharacters !== false;
        const trackObjectives = settings.trackObjectives !== false;
        const hasAnything = update.clock !== null
            || (trackCharacters && update.schedules.length > 0)
            || (trackObjectives && (update.newObjectives.length > 0
                || update.updateObjectives.length > 0
                || update.completeTitles.length > 0
                || update.abandonTitles.length > 0));

        if (!hasAnything) {
            logDebug("No Chronogram blocks found in tracker response.");
            return { skipped: true, reason: "no_updates" };
        }

        const event = applyUpdate(update);

        pipelineBar.complete();
        barCompleted = true;

        notifyEvent(event);
        const { refreshChronoPanel } = await import("./injection.js");
        refreshChronoPanel();

        saveSnapshotToMessage(effectiveMessageId);
        return { skipped: false, event };
    } catch (error) {
        console.error("[Chronogram] Tracker error:", error);
        showErrorToast("Chronogram Tracker", error);
        lastRunMessageId = -1; // Allow retry on failure
        return { skipped: true, reason: "error", error };
    } finally {
        if (!barCompleted) pipelineBar.hide();
        isRunning = false;
        isCancelled = false;
    }
}

export function runTrackerManual() {
    const st = getST();
    const visibleChat = (st.chat || []).filter(m => !isGhostMessage(m));

    if (visibleChat.length < 2) {
        if (typeof toastr !== "undefined") {
            toastr.warning(
                "Not enough context to run the chronogram: there is no complete exchange (a user message and an AI message) in this chat yet.",
                "Chronogram",
                { timeOut: 8000 }
            );
        }
        logDebug("Manual run aborted: no complete exchange available.");
        return;
    }

    // Always return to the PREVIOUS message's info first: drop the tracked
    // message's stale snapshot, restore the state from before it and reset
    // the guard, so this run's request doesn't duplicate the updates the
    // previous run already applied (same behavior as a swipe).
    const lastId = (st.chat?.length ?? 1) - 1;
    rollbackToBeforeMessage(lastId);

    runTracker(null, { manual: true }).then(result => {
        if (typeof toastr === "undefined") return;
        if (!result.skipped) {
            toastr.success("Chronogram updated.", "Chronogram");
            return;
        }
        switch (result.reason) {
            case "busy":
                toastr.warning("The chronogram tracker is already running.", "Chronogram", { timeOut: 5000 });
                break;
            case "no_updates":
                toastr.info("Chronogram finished: nothing new to track.", "Chronogram", { timeOut: 5000 });
                break;
            case "cancelled":
            case "error":
                break; // already reported where relevant
            default:
                logDebug(`Manual chronogram run skipped: ${result.reason}.`);
                break;
        }
    });
}

// ---------------------------------------------------------------------------
// Rollback (button / swipe recovery)
// ---------------------------------------------------------------------------

// Rolls the chronogram state back to what it was BEFORE `messageId` was
// tracked: the tracked message's stale snapshot is dropped and the nearest
// snapshot from an earlier message is restored (i.e. "the previous message's
// info"), so a re-run builds its request from that rolled-back state instead
// of stacking new updates on top of the old ones (which duplicated the
// clock/objective changes). Also resets the swipe/re-entry guard so the next
// run isn't discarded as "already_tracked".
export function rollbackToBeforeMessage(messageId) {
    const st = getST();
    const chat = st.chat || [];
    const startId = Math.min(Number(messageId) || 0, chat.length - 1);

    // Walk backwards exactly like runTracker does so we target the message
    // that was ACTUALLY tracked (skipping user/ghost messages), not just the
    // raw event id - otherwise the stale snapshot of the real tracked message
    // survives and the next request duplicates its updates.
    let trackedId = -1;
    for (let i = startId; i > 0; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user) continue;
        if (isGhostMessage(msg)) continue;
        trackedId = i;
        break;
    }
    if (trackedId < 0) return false;

    const hadSnapshot = Boolean(chat[trackedId]?.extra?.chrono_snapshot);
    clearMessageSnapshot(trackedId);
    const restored = restoreStateUpTo(trackedId - 1);
    resetTrackerGuard();
    logDebug(`Rolled back chronogram state before message ${trackedId} (stale snapshot removed: ${hadSnapshot}, previous state restored: ${restored}).`);
    return true;
}

// ---------------------------------------------------------------------------
// Per-message snapshots (swipe / delete recovery)
// ---------------------------------------------------------------------------

export function saveSnapshotToMessage(messageId) {
    const st = getST();
    const msg = st.chat?.[messageId];
    if (!msg) return;
    msg.extra = msg.extra || {};
    msg.extra.chrono_snapshot = createSnapshot();
    if (typeof st.saveChat === "function") st.saveChat();
}

export function clearMessageSnapshot(messageId) {
    const st = getST();
    const msg = st.chat?.[messageId];
    if (msg?.extra?.chrono_snapshot) {
        delete msg.extra.chrono_snapshot;
        if (typeof st.saveChat === "function") st.saveChat();
    }
}

export function restoreStateUpTo(messageId) {
    const st = getST();
    for (let i = messageId; i >= 0; i--) {
        const snap = st.chat?.[i]?.extra?.chrono_snapshot;
        if (snap) {
            restoreSnapshot(snap);
            return true;
        }
    }
    restoreSnapshot(null);
    return false;
}

// Keeps manual edits (clock, objectives) in sync with the newest per-message
// snapshot. The snapshot stores the state AS OF the moment its message was
// tracked, so anything changed by hand afterwards would be silently discarded
// on the next swipe or manual re-run (both restore from that snapshot).
// Refreshing it with a copy of the current state makes rollbacks land on the
// edited values instead of the stale ones.
export function updateLatestSnapshot() {
    const st = getST();
    const chat = st.chat || [];
    const fresh = createSnapshot();
    if (!fresh) return false;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.extra?.chrono_snapshot) {
            chat[i].extra.chrono_snapshot = fresh;
            if (typeof st.saveChat === "function") st.saveChat();
            return true;
        }
    }
    return false;
}

// Wipes every per-message snapshot in the chat. Used by the full "Reset Chat
// Data" flow: without this, the next swipe would restore an old snapshot and
// resurrect data the user just deleted.
export function clearAllSnapshots() {
    const st = getST();
    const chat = st.chat || [];
    let removed = 0;
    for (const msg of chat) {
        if (msg?.extra?.chrono_snapshot) {
            delete msg.extra.chrono_snapshot;
            removed++;
        }
    }
    if (removed > 0 && typeof st.saveChat === "function") st.saveChat();
    return removed;
}




