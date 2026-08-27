// Chronogram tracker: builds the prompt, runs it through a SillyTavern
// Connection profile via ConnectionManagerRequestService, parses the result
// and applies the new world-clock / activities / schedules / objectives.
// Mirrors Persist's tracker pipeline 1:1 where possible.

import { substituteParams } from "../../../../../script.js";
import { extension_settings } from "../../../../extensions.js";
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
    replaceSchedule,
    pruneSchedules,
    getScheduleFor,
    addObjective,
    updateObjective,
    setObjectiveStatus,
    formatElapsed,
    createSnapshot,
    restoreSnapshot,
    saveState,
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
    const clock = getClock();
    const participants = getParticipants();
    const objectives = (getStateRoot()?.objectives || []);
    const lines = [];

    lines.push(`<chronogram_state>`);
    lines.push(clock
        ? `Current world clock: Date:${clock.date} Time:${clock.time}`
        : "Current world clock: NOT ESTABLISHED YET");

    const entries = Object.entries(participants);
    if (entries.length === 0) {
        lines.push("Participants: none tracked yet.");
    } else {
        lines.push("Participants (current activity + today's plan):");
        for (const [id, p] of entries) {
            lines.push(`<participant name="${id}">`);
            lines.push(`Doing:${p.activity || "(unknown)"}`);
            if (clock?.date) {
                const sched = getScheduleFor(id, clock.date);
                if (sched.length > 0) {
                    for (const e of sched) lines.push(`${e.time} ${e.activity}`);
                } else {
                    lines.push("(no schedule for today)");
                }
            }
            lines.push(`</participant>`);
        }
    }

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

    lines.push("</chronogram_state>");
    return lines.join("\n");
}

// History context + the exchanges to analyze, with the elapsed-time header.
function buildContextBlock(elapsedText, mode) {
    const st = getST();
    const settings = extension_settings[extensionName] || {};
    const depth = Math.max(0, settings.contextDepth ?? 10);
    const interval = getAutoRunInterval();

    const visibleChat = st.chat.filter(m => !isGhostMessage(m));
    const targetCount = Math.min(visibleChat.length, interval * 2);
    const target = visibleChat.slice(-targetCount);
    const history = visibleChat.slice(0, visibleChat.length - targetCount).slice(-depth);

    const lines = [];
    if (mode === "setup") {
        lines.push("This is the FIRST Chronogram run for this chat: establish the clock, participants and schedules (see SETUP mode in your instructions).");
    } else if (elapsedText) {
        lines.push(`Time Passed since the previously tracked moment: ${elapsedText}`);
    }

    if (history.length > 0) {
        const historyLines = history.map(m => `${m.name || (m.is_user ? "User" : "Assistant")}: ${m.mes}`).join("\n");
        lines.push(`<conversation_context>\n${historyLines}\n</conversation_context>`);
    }

    const targetLines = target.map(m => `${m.name || (m.is_user ? "User" : "Assistant")}: ${m.mes}`).join("\n\n");
    lines.push(`<exchanges_to_analyze>\nAnalyze the latest exchange:\n\n${targetLines || "(no messages)"}\n</exchanges_to_analyze>`);

    return lines.join("\n\n");
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
        activities: [],
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

    // 2. Activities.
    for (const act of update.activities) {
        if (!act.doing) continue;
        const p = getOrCreateParticipant(act.ownerId, act.displayName);
        if (p) {
            p.activity = act.doing;
            event.activities.push(`${p.name}: ${act.doing}`);
        }
    }

    // 3. Schedules.
    for (const sched of update.schedules) {
        getOrCreateParticipant(sched.ownerId, sched.displayName);
        replaceSchedule(sched.ownerId, sched.date, sched.entries);
        event.schedules++;
    }
    pruneSchedules(2);

    // 4. Objectives.
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
    if (!dayChanged && event.activities.length === 0 && event.newObjectives.length === 0
        && event.updatedObjectives.length === 0 && event.completedObjectives.length === 0
        && event.abandonedObjectives.length === 0 && event.schedules === 0) {
        return; // clock-only churn
    }
    const lines = [];
    if (event.newDate) lines.push(`Clock: ${event.newDate} ${event.newTime ?? ""}`);
    if (dayChanged) lines.push(`NEW DAY: ${event.newDate}`);
    for (const a of event.activities) lines.push(`Activity - ${a}`);
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

        if (typeof st.ConnectionManagerRequestService?.sendRequest !== "function") {
            throw new Error("ConnectionManagerRequestService is unavailable. Is the Connection Manager extension enabled?");
        }

        // Progress bar with a stop button (mirrors Persist's pipeline bar).
        pipelineBar.init(cancelTracker);
        pipelineBar.start(1, String(st.chat[effectiveMessageId]?.mes ?? ""));
        pipelineBar.updatePass(0, "Tracking chronogram");

        const messages = [
            { role: "system", content: substituteParams(getChronoPrompt(mode)) },
            { role: "user", content: buildCurrentStateBlock() },
            { role: "user", content: substituteParams(buildContextBlock(formatElapsed(elapsedMs ?? 0), mode)) },
        ];

        if (isCancelled) return { skipped: true, reason: "cancelled" };
        const profileId = resolveConnectionProfile(st, settings.trackerProfile || "");
        const raw = await requestTracker(messages, profileId);
        if (isCancelled) return { skipped: true, reason: "cancelled" };

        const cleaned = parse_reasoning(raw, profileId);
        logDebug("Chronogram raw response:", cleaned);
        pipelineBar.updatePass(0, "Applying update");

        const update = parseChronoResponse(cleaned);
        const hasAnything = update.clock !== null
            || update.activities.length > 0
            || update.schedules.length > 0
            || update.newObjectives.length > 0
            || update.updateObjectives.length > 0
            || update.completeTitles.length > 0
            || update.abandonTitles.length > 0;

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

    // If the latest message was already tracked (it carries a snapshot),
    // imitate swipe behavior: roll state back, drop the stale snapshot and
    // reset the guard so this run isn't discarded as a dupe.
    const lastId = (st.chat?.length ?? 1) - 1;
    const lastMsg = st.chat[lastId];
    if (lastMsg && !lastMsg.is_user && lastMsg.extra?.chrono_snapshot) {
        clearMessageSnapshot(lastId);
        restoreStateUpTo(lastId - 1);
        resetTrackerGuard();
        logDebug(`Manual run: rolled back state before message ${lastId}.`);
    }
    resetTrackerGuard();

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




