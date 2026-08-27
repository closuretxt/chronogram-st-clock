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
    tickClock,
    getOrCreateParticipant,
    getParticipants,
    getActiveParticipants,
    updateActiveParticipants,
    replaceSchedule,
    pruneSchedules,
    getScheduleFor,
    getSchedules,
    addObjective,
    updateObjective,
    setObjectiveStatus,
    formatElapsed,
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

// Story-time that passed since the previous tracked moment. Simple rules:
// real time between runs, floored by minMinutesPerTurn and capped by
// maxAdvanceHours (so an AFK night doesn't skip a year by accident).
function computeElapsedMs() {
    const settings = extension_settings[extensionName] || {};
    const root = getStateRoot();
    if (!root?.lastRunAt) return null;
    let ms = Date.now() - root.lastRunAt;
    const floorMs = Math.max(0, Number(settings.minMinutesPerTurn) || 0) * 60000;
    const capMs = Math.max(0, Number(settings.maxAdvanceHours) || 0) * 3600000;
    if (ms < floorMs) ms = floorMs;
    if (capMs > 0 && ms > capMs) ms = capMs;
    return ms;
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
                // Previous tracker info: plans kept from earlier dates are sent
                // too, so a midnight crossing doesn't start from a blank page.
                const allScheds = getSchedules()[id] || {};
                for (const d of Object.keys(allScheds).filter(d => d !== clock?.date).sort()) {
                    const prev = allScheds[d] || [];
                    if (prev.length > 0) {
                        lines.push(`Previous plan (${d}): ${prev.map(e => `${e.time} ${stripCurrentMarker(e.activity)}`).join("; ")}`);
                    }
                }
                if (clock?.date) {
                    const sched = getScheduleFor(id, clock.date);
                    if (sched.length > 0) {
                        for (const e of sched) lines.push(`${e.time} ${stripCurrentMarker(e.activity)}`);
                    } else {
                        lines.push("(no schedule for today)");
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

// History context + the exchanges to analyze, with the elapsed-time header.

// Shared message-set extraction so both context modes (flat block / roles)
// see exactly the same history and target messages.
function getContextMessages() {
    const st = getST();
    const settings = extension_settings[extensionName] || {};
    const depth = Math.max(0, settings.contextDepth ?? 10);
    const interval = getAutoRunInterval();

    const visibleChat = st.chat.filter(m => !isGhostMessage(m));
    const targetCount = Math.min(visibleChat.length, interval * 2);
    return {
        history: visibleChat.slice(0, visibleChat.length - targetCount).slice(-depth),
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

// The elapsed/setup header lines that precede the conversation data.
function buildContextHeader(elapsedText, mode) {
    if (mode === "setup") {
        return "This is the FIRST Chronogram run for this chat: establish the clock, participants and schedules (see SETUP mode in your instructions).";
    }
    return elapsedText
        ? `Time Passed since the previously tracked moment: ${elapsedText}`
        : "";
}

function buildContextBlock(elapsedText, mode) {
    const { history, target } = getContextMessages();

    const lines = [];
    const header = buildContextHeader(elapsedText, mode);
    if (header) lines.push(header);

    if (history.length > 0) {
        const historyLines = history.map(messageLine).join("\n");
        lines.push(`<conversation_context>\n${historyLines}\n</conversation_context>`);
    }

    const targetLines = target.map(messageLine).join("\n\n");
    lines.push(`<exchanges_to_analyze>\nAnalyze the latest exchange:\n\n${targetLines || "(no messages)"}\n</exchanges_to_analyze>`);

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
function applyUpdate(update, elapsedMs) {
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

    // 1. Clock. LLM is authoritative; deterministic tick is the fallback.
    if (update.clock) {
        setClock(update.clock.date, update.clock.time);
        event.newDate = update.clock.date;
        event.newTime = update.clock.time;
    } else if (elapsedMs !== null) {
        const ticked = tickClock(elapsedMs);
        event.newDate = ticked?.date ?? null;
        event.newTime = ticked?.time ?? null;
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
        const elapsedMs = mode === "normal" ? computeElapsedMs() : null;

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

        // Assemble the tracker conversation: system prompt, optional story
        // reference info (persona/scenario/char card/WI/outlets), the current
        // tracked state, then the conversation context (flat block or roles).
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

        messages.push({ role: "user", content: buildCurrentStateBlock() });

        if (settings.contextAsRoles === true) {
            // "Send Context as Roles": history and the latest exchange go in as
            // proper user/assistant turns instead of one flat text block.
            const { history, target } = getContextMessages();
            for (const m of [...history, ...target]) {
                messages.push({ role: messageRole(m), content: messageLine(m) });
            }
            const header = buildContextHeader(formatElapsed(elapsedMs ?? 0), mode);
            messages.push({
                role: "user",
                content: `${header ? header + "\n\n" : ""}<exchanges_to_analyze>\nAnalyze the latest exchange above.\n</exchanges_to_analyze>`,
            });
        } else {
            messages.push({ role: "user", content: substituteParams(buildContextBlock(formatElapsed(elapsedMs ?? 0), mode)) });
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

        const event = applyUpdate(update, elapsedMs);

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




