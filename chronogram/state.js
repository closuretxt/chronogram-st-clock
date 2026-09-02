// Per-chat persistent Chronogram state store.
// State lives in chat_metadata.chronogram so it is saved/restored with the
// chat itself, exactly like Persist keeps its relationship data.

import { getContext } from "../../../../extensions.js";

const STATE_KEY = "chronogram";

// ---------------------------------------------------------------------------
// Date/time helpers (everything uses MM/DD/YYYY + 24h HH:MM)
// ---------------------------------------------------------------------------

export function pad2(n) {
    return String(n).padStart(2, "0");
}

export function formatDate(d) {
    return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
}

export function formatTime(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function nowDateTime() {
    const n = new Date();
    return { date: formatDate(n), time: formatTime(n) };
}

// "12/05/2026" -> Date | null
export function parseDateMDY(s) {
    const m = String(s || "").match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
    if (!m) return null;
    const d = new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    return isNaN(d.getTime()) ? null : d;
}

// "14:30" or "2:30 PM" best-effort -> minutes since midnight | null
export function parseTimeHM(s) {
    const str = String(s || "").trim();
    let m = str.match(/^(\d{1,2}):(\d{2})/);
    if (m) {
        const h = ((parseInt(m[1], 10) % 24) + 24) % 24;
        return h * 60 + Math.min(59, parseInt(m[2], 10));
    }
    m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*$/i);
    if (m) {
        let h = parseInt(m[1], 10) % 12;
        if (/pm/i.test(m[3])) h += 12;
        return h * 60 + Math.min(59, parseInt(m[2] || "0", 10));
    }
    return null;
}

export function isValidDateString(s) {
    return parseDateMDY(s) !== null;
}

// {date,time} (or Date) -> Date instance carrying both fields.
export function toClockDate(clock) {
    if (clock instanceof Date) return isNaN(clock.getTime()) ? null : clock;
    const base = parseDateMDY(clock?.date);
    if (!base) return null;
    const t = parseTimeHM(clock?.time);
    if (t !== null) base.setMinutes(t);
    return base;
}

export function clampClockToDate(clockDate) {
    if (!(clockDate instanceof Date) || isNaN(clockDate.getTime())) return null;
    return {
        date: formatDate(clockDate),
        time: formatTime(clockDate),
    };
}

// Advances a stored clock by ms. Returns the NEW stored value.
export function advanceClock(clock, ms) {
    const base = toClockDate(clock) ?? new Date();
    return clampClockToDate(new Date(base.getTime() + ms));
}

// Formats a duration as compact shorthand: "1d 3h 45m".
export function formatElapsed(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const minutes = mins % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
    return parts.join(" ");
}

// Any owner reported by the LLM that means the user ("User", "{{user}}",
// "You", or literally the current persona's name) resolves to the reserved
// id "user". Without the persona-name match the tracker would file the
// user's own schedule/objectives under a separate look-alike
// participant whenever the model wrote Owner:<persona name>.
export function resolveOwnerId(name) {
    const n = String(name || "").trim();
    if (!n || /^(?:\{\{user\}\}|user|you)$/i.test(n)) return "user";
    if (isPersonaName(n)) return "user";
    return n.replace(/\s+/g, "_");
}

function getCurrentPersonaName() {
    try {
        return String(window.SillyTavern?.getContext?.()?.name1 || "").trim();
    } catch {
        return "";
    }
}

// True when the given owner string refers to the user's persona
// ("Curren Chan", "curren_chan", etc.).
function isPersonaName(s) {
    const persona = getCurrentPersonaName().toLowerCase();
    if (!persona) return false;
    const norm = String(s || "").trim().toLowerCase().replaceAll("_", " ");
    return !!norm && norm === persona;
}

export function getDisplayName(ownerId) {
    if (ownerId === "user") {
        try {
            const name = window.SillyTavern?.getContext?.()?.name1;
            if (name) return name;
        } catch { /* ignore */ }
        return "User";
    }
    return getParticipants()[ownerId]?.name || ownerId;
}

// ---------------------------------------------------------------------------
// State root
// ---------------------------------------------------------------------------

function defaultRoot() {
    return {
        anchored: false, // false until the setup run establishes the clock
        clock: null, // { date: "MM/DD/YYYY", time: "HH:MM" } - shared world clock
        participants: {}, // id -> { name, active }
        schedules: {}, // ownerId -> { [dateStr]: [{ time, activity }] }
        objectives: [], // long-term objectives across days
        lastRunAt: null, // epoch ms of the previously tracked moment
        timeLocked: false, // true = freeze the clock, skip all automatic runs
    };
}

export function getStateRoot() {
    const st = getContext();
    if (!st?.chatMetadata) return null;
    if (!st.chatMetadata[STATE_KEY]) {
        st.chatMetadata[STATE_KEY] = defaultRoot();
    }
    const root = st.chatMetadata[STATE_KEY];
    // Defensive migration for fields added later.
    if (typeof root.anchored !== "boolean") root.anchored = false;
    if (typeof root.timeLocked !== "boolean") root.timeLocked = false;
    if (!root.participants || typeof root.participants !== "object") root.participants = {};
    if (!root.schedules || typeof root.schedules !== "object") root.schedules = {};
    if (!Array.isArray(root.objectives)) root.objectives = [];
    // Migration: participants gained an `active` presence flag later on.
    for (const p of Object.values(root.participants)) {
        if (typeof p.active !== "boolean") p.active = true;
    }
    migrateUserAlias(root);
    return root;
}

// Older tracker runs could file the user's data under their persona name
// (e.g. id "Curren_Chan") instead of the reserved "user" id, leaving the
// user without a card. Merge any such look-alike participant into "user":
// schedules and objectives all move across, the duplicate is
// deleted. Runs at most once per session.
let _userAliasMigrated = false;
function migrateUserAlias(root) {
    if (_userAliasMigrated) return;
    const persona = getCurrentPersonaName();
    if (!persona) return;
    _userAliasMigrated = true;

    const aliasIds = Object.keys(root.participants).filter(id => {
        if (id === "user") return false;
        const p = root.participants[id];
        return id.replaceAll("_", " ").toLowerCase() === persona.toLowerCase()
            || String(p?.name || "").trim().toLowerCase() === persona.toLowerCase();
    });
    if (aliasIds.length === 0) return;

    const user = root.participants.user = root.participants.user
        || { name: persona, active: true };
    user.name = persona; // the user card always shows the persona's name
    user.active = true;

    for (const aliasId of aliasIds) {
        const aliasSched = root.schedules[aliasId] || {};
        root.schedules.user = root.schedules.user || {};
        for (const [date, entries] of Object.entries(aliasSched)) {
            const existing = root.schedules.user[date];
            if (!Array.isArray(existing) || existing.length === 0) {
                root.schedules.user[date] = entries;
            }
        }
        delete root.schedules[aliasId];
        delete root.participants[aliasId];
    }

    let touchedObjectives = false;
    for (const o of root.objectives) {
        if (aliasIds.includes(o.owner)) {
            o.owner = "user";
            touchedObjectives = true;
        }
    }
    if (aliasIds.length > 0 || touchedObjectives) saveState();
}

export function saveState() {
    const st = getContext();
    if (typeof st?.saveMetadataDebounced === "function") {
        st.saveMetadataDebounced();
    } else if (typeof st?.saveChat === "function") {
        st.saveChat();
    }
}

export function resetState() {
    const st = getContext();
    if (st?.chatMetadata && STATE_KEY in st.chatMetadata) {
        delete st.chatMetadata[STATE_KEY];
        saveState();
    }
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

export function getParticipants() {
    return getStateRoot()?.participants || {};
}

// Active participants only: used by the drawer, the injection and the tracker
// state. Inactive (off-context) participants keep ALL their stored data
// (schedules, objectives) but are hidden everywhere until they are
// mentioned in the chat again.
export function getActiveParticipants() {
    return Object.fromEntries(
        Object.entries(getParticipants()).filter(([, p]) => p?.active !== false)
    );
}

// Lowercased needles that count as "this character is mentioned in the text".
function participantNeedles(id, p) {
    const needles = new Set();
    const add = (v) => {
        const s = String(v ?? "").trim().toLowerCase();
        if (s.length >= 3 && s !== "user") needles.add(s);
    };
    add(p?.name);
    if (id !== "user") add(id.replaceAll("_", " "));
    // Multi-word names are usually referenced by the first name alone.
    const first = String(p?.name ?? "").trim().split(/\s+/)[0];
    if (first.length >= 4) add(first);
    return [...needles];
}

// True when the character's name/id appears in the given text.
export function isMentionedIn(text, id, p) {
    const hay = String(text ?? "").toLowerCase();
    if (!hay) return false;
    return participantNeedles(id, p).some(n => hay.includes(n));
}

// How many recent visible messages count as "the current context" for presence.
const ACTIVE_LOOKBACK = 20;

// Recomputes every participant's active flag from the recent chat: mentioned
// in the last ACTIVE_LOOKBACK visible messages -> active, otherwise inactive
// (archived, but their schedule/data stays fetchable). The user is always
// active.
export function updateActiveParticipants() {
    const st = getContext();
    const root = getStateRoot();
    if (!st?.chat || !root) return;
    const recent = st.chat
        .filter(m => m
            && m.is_system !== true && m.is_system !== "true"
            && m.is_hidden !== true && m.is_hidden !== "true"
            && String(m.mes ?? "").trim())
        .slice(-ACTIVE_LOOKBACK)
        // Count BOTH the message text and its author: a character who just
        // spoke is present even if nobody said their name in the prose
        // (the user's own persona name almost never appears in their own
        // messages, yet they are obviously in the scene).
        .map(m => `${String(m.name ?? "")}\n${String(m.mes ?? "")}`.toLowerCase())
        .join("\n");
    for (const [id, p] of Object.entries(root.participants)) {
        if (id === "user") {
            p.active = true;
            continue;
        }
        p.active = isMentionedIn(recent, id, p);
    }
    saveState();
}

export function getOrCreateParticipant(ownerId, displayName = null) {
    const root = getStateRoot();
    if (!root) return null;
    const id = resolveOwnerId(ownerId);
    let p = root.participants[id];
    if (!p) {
        p = { name: displayName || (id === "user" ? "User" : id), active: true };
        root.participants[id] = p;
    } else if (displayName && p.name !== displayName && p.name === id) {
        p.name = displayName; // upgrade placeholder names
    }
    return p;
}

export function removeParticipant(ownerId) {
    const root = getStateRoot();
    if (!root) return;
    const id = resolveOwnerId(ownerId);
    delete root.participants[id];
    delete root.schedules[id];
    saveState();
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export function getClock() {
    return getStateRoot()?.clock || null;
}

export function setClock(date, time) {
    const root = getStateRoot();
    if (!root) return null;
    root.clock = { date: String(date).trim(), time: String(time).trim() };
    root.anchored = true;
    // A clock set (manually via the panel, or by the tracker) becomes the new
    // "previously tracked moment": the NEXT run's elapsed-time computation
    // must measure from HERE, not from the previous automatic run. Without
    // this, a manual edit doesn't move the tracker's reference point and the
    // LLM advances the clock relative to the pre-edit timeline.
    root.lastRunAt = Date.now();
    saveState();
    return root.clock;
}

// Clock lock: when set, every automatic tracker run is skipped entirely so
// the world time stays exactly where the user left it (panel lock button).
export function isTimeLocked() {
    return getStateRoot()?.timeLocked === true;
}

export function setTimeLocked(locked) {
    const root = getStateRoot();
    if (!root) return false;
    root.timeLocked = locked === true;
    saveState();
    return root.timeLocked;
}

// Deterministic fallback when the LLM reports no <clock_update>:
// simply push the stored clock forward by `ms`.
export function tickClock(ms) {
    const root = getStateRoot();
    if (!root?.clock) return null;
    root.clock = advanceClock(root.clock, ms);
    root.lastRunAt = Date.now(); // this run just re-anchored the timeline
    saveState();
    return root.clock;
}

// ---------------------------------------------------------------------------
// Schedules (per participant, per date)
// ---------------------------------------------------------------------------

export function getSchedules() {
    return getStateRoot()?.schedules || {};
}

// The tracker sometimes annotates entries with "(Current)". The current slot
// is derived from the world clock, so such markers are stripped everywhere.
export function stripCurrentMarker(text) {
    return String(text ?? "")
        .replace(/\s*\(\s*current\s*\)\s*$/i, "")
        .trim();
}

// entries: [{time, activity}] sorted by parsed time-of-day.
export function replaceSchedule(ownerId, dateStr, entries) {
    const root = getStateRoot();
    if (!root) return;
    const id = resolveOwnerId(ownerId);
    if (!isValidDateString(dateStr)) return;
    const clean = (Array.isArray(entries) ? entries : [])
        .map(e => ({ time: String(e.time || "").trim(), activity: stripCurrentMarker(e.activity) }))
        .filter(e => e.time && e.activity)
        .sort((a, b) => (parseTimeHM(a.time) ?? 0) - (parseTimeHM(b.time) ?? 0));
    root.schedules[id] = root.schedules[id] || {};
    root.schedules[id][dateStr.trim()] = clean;
    saveState();
}

// Schedule entries for an owner on a date.
export function getScheduleFor(ownerId, dateStr) {
    return getSchedules()[resolveOwnerId(ownerId)]?.[String(dateStr)] || [];
}

// Keeps only the newest `keepCount` dates per owner so old plans don't pile up.
export function pruneSchedules(keepCount = 2) {
    const root = getStateRoot();
    if (!root) return;
    for (const owner of Object.keys(root.schedules)) {
        const dates = Object.keys(root.schedules[owner]);
        if (dates.length <= keepCount) continue;
        dates.sort((a, b) => (parseDateMDY(a)?.getTime() ?? 0) - (parseDateMDY(b)?.getTime() ?? 0));
        for (const stale of dates.slice(0, dates.length - keepCount)) {
            delete root.schedules[owner][stale];
        }
    }
}

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export function getObjectives() {
    return getStateRoot()?.objectives || [];
}

export function findObjectiveByTitleAny(title) {
    const needle = String(title || "").toLowerCase().trim();
    return getObjectives().find(o => o.title.toLowerCase().trim() === needle) || null;
}

export function findObjective(ownerId, title) {
    const id = resolveOwnerId(ownerId);
    const needle = String(title || "").toLowerCase().trim();
    return getObjectives().find(o => o.owner === id && o.title.toLowerCase().trim() === needle) || null;
}

export function addObjective({ owner, title, description = "", deadline = "", steps = "" }) {
    const root = getStateRoot();
    if (!root) return null;
    const id = resolveOwnerId(owner);
    const existing = findObjective(id, title);
    if (existing) return existing; // never duplicate
    const obj = {
        id: `obj_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
        owner: id,
        title: String(title || "Untitled").trim(),
        description: String(description || "").trim(),
        deadline: String(deadline || "").trim(),
        steps: String(steps || "").trim(),
        progress: "",
        status: "active", // active | completed | abandoned
        createdDate: root.clock?.date || "",
    };
    root.objectives.push(obj);
    saveState();
    return obj;
}

export function updateObjective(ownerId, title, { progress, deadline } = {}) {
    // ownerId null = match by title across all owners.
    const obj = ownerId === null ? findObjectiveByTitleAny(title) : findObjective(ownerId, title);
    if (!obj) return null;
    if (progress !== undefined && progress !== null && progress !== "") obj.progress = String(progress).trim();
    if (deadline !== undefined && deadline !== null && deadline !== "") obj.deadline = String(deadline).trim();
    saveState();
    return obj;
}

export function setObjectiveStatus(ownerId, title, status) {
    const obj = ownerId === null ? findObjectiveByTitleAny(title) : findObjective(ownerId, title);
    if (!obj) return null;
    obj.status = status === "completed" ? "completed" : status === "abandoned" ? "abandoned" : "active";
    saveState();
    return obj;
}

export function setObjectiveStatusById(objId, status) {
    const obj = getObjectives().find(o => o.id === objId);
    if (!obj) return null;
    obj.status = status;
    saveState();
    return obj;
}

export function removeObjectiveById(objId) {
    const root = getStateRoot();
    if (!root) return false;
    const before = root.objectives.length;
    root.objectives = root.objectives.filter(o => o.id !== objId);
    if (root.objectives.length !== before) {
        saveState();
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Snapshots (swipe / delete recovery, mirrors Persist's approach)
// ---------------------------------------------------------------------------

export function createSnapshot() {
    const root = getStateRoot();
    if (!root) return null;
    return JSON.parse(JSON.stringify({
        anchored: root.anchored,
        clock: root.clock,
        participants: root.participants,
        schedules: root.schedules,
        objectives: root.objectives,
        lastRunAt: root.lastRunAt,
        timeLocked: root.timeLocked,
    }));
}

export function restoreSnapshot(snapshot) {
    const st = getContext();
    if (!st?.chatMetadata) return;
    if (!snapshot) {
        st.chatMetadata[STATE_KEY] = defaultRoot();
        saveState();
        return;
    }
    const current = getStateRoot();
    current.anchored = snapshot.anchored === true;
    current.clock = snapshot.clock || null;
    current.participants = snapshot.participants || {};
    current.schedules = snapshot.schedules || {};
    current.objectives = Array.isArray(snapshot.objectives) ? snapshot.objectives : [];
    current.lastRunAt = snapshot.lastRunAt ?? null;
    current.timeLocked = snapshot.timeLocked === true;
    saveState();
}




