// Tolerant regex-based parser for Chronogram tracker LLM output.

import { resolveOwnerId, parseDateMDY, parseTimeHM, getClock } from "./state.js";

const CLOCK_RE = /<clock_update>([\s\S]*?)<\/\s*clock_update>/gi;
const SCHEDULE_RE = /<new_schedule>([\s\S]*?)<\/\s*new_schedule>/gi;
const NEW_OBJ_RE = /<new_objective>([\s\S]*?)<\/\s*new_objective>/gi;
const UPDATE_OBJ_RE = /<update_objective>([\s\S]*?)<\/\s*update_objective>/gi;
const COMPLETE_OBJ_RE = /<complete_objective>([\s\S]*?)<\/\s*complete_objective>/gi;
const ABANDON_OBJ_RE = /<abandon_objective>([\s\S]*?)<\/\s*abandon_objective>/gi;

// Parses "Key: Value" lines inside a block body.
function parseFields(body) {
    const fields = {};
    const lines = String(body || "").split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/^\s*([A-Za-z_ ]+?)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].trim();
        const value = m[2].trim();
        if (key && !(key in fields && fields[key])) {
            fields[key] = value;
        }
    }
    return fields;
}

// Models sometimes copy the "MM/DD/YYYY" template literally and emit dates
// like "04/12/YYYY". Repair those: fill the placeholder year from the tracked
// clock (so it stays in the story's timeline), falling back to the real-world
// current year.
function fallbackYear() {
    const fromClock = getClock()?.date?.match(/(\d{4})\s*$/);
    if (fromClock) return fromClock[1];
    return String(new Date().getFullYear());
}

function repairDate(value) {
    const date = String(value || "").replace(/\u200b/g, "").trim();
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)) return date;
    // "04/12/YYYY", "04/12/YY", "04/12/__", "04/12/" or bare "04/12"
    const partial = date.match(/^(\d{1,2})\/(\d{1,2})\s*\/?\s*(?:Y{2,4}|y{2,4}|\?+|_+|X{2,4})?$/);
    if (partial) {
        return `${partial[1].padStart(2, "0")}/${partial[2].padStart(2, "0")}/${fallbackYear()}`;
    }
    return date;
}

// Parses the free lines of a <new_schedule> body into [{time, activity}].
// Expected shape: "08:00 wakes up" (also tolerates "- 8:00 AM - text").
function parseScheduleEntries(body) {
    const entries = [];
    const lines = String(body || "").split(/\r?\n/);
    for (const line of lines) {
        const cleaned = line.replace(/^[\s\-*•]+/, "").trim();
        if (!cleaned || /^[A-Za-z_ ]+\s*:/.test(cleaned)) continue; // field lines like Owner:/Date:
        const m = cleaned.match(/^(\d{1,2}:\d{2})\s*(?:(?:AM|PM)\s*)?[-–—:.]?\s*(.+)$/i)
            || cleaned.match(/^(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\s*[-–—:.]?\s*(.+)$/i);
        if (m && parseTimeHM(m[1]) !== null) {
            entries.push({ time: m[1].trim(), activity: m[2].trim() });
        }
    }
    return entries;
}

// True when at least one known block type was matched.
export function hasChronoBlocks(text) {
    const src = String(text || "");
    return [CLOCK_RE, SCHEDULE_RE, NEW_OBJ_RE, UPDATE_OBJ_RE, COMPLETE_OBJ_RE, ABANDON_OBJ_RE]
        .some(re => (re.lastIndex = 0) === 0 && re.test(src));
}

// Returns a parsed update object:
// { clock, schedules[], newObjectives[], updateObjectives[],
//   completeTitles[{owner,title}], abandonTitles[{owner,title}] }
export function parseChronoResponse(responseText) {
    const text = String(responseText || "");
    const result = {
        clock: null,
        schedules: [],
        newObjectives: [],
        updateObjectives: [],
        completeTitles: [],
        abandonTitles: [],
    };

    let m;

    CLOCK_RE.lastIndex = 0;
    while ((m = CLOCK_RE.exec(text)) !== null) {
        const f = parseFields(m[1]);
        const date = repairDate(f.Date);
        const time = String(f.Time || "").trim();
        if (parseDateMDY(date) && parseTimeHM(time) !== null) {
            result.clock = { date, time };
        }
    }

    SCHEDULE_RE.lastIndex = 0;
    while ((m = SCHEDULE_RE.exec(text)) !== null) {
        const inner = m[1];
        const f = parseFields(inner);
        if (!f.Owner) continue;
        const date = repairDate(f.Date);
        if (!parseDateMDY(date)) continue;
        const entries = parseScheduleEntries(inner);
        if (entries.length === 0) continue;
        result.schedules.push({
            ownerId: resolveOwnerId(f.Owner),
            displayName: f.Owner.trim(),
            date,
            entries,
        });
    }

    NEW_OBJ_RE.lastIndex = 0;
    while ((m = NEW_OBJ_RE.exec(text)) !== null) {
        const f = parseFields(m[1]);
        if (!f.Title || !f.Owner) continue;
        result.newObjectives.push({
            ownerId: resolveOwnerId(f.Owner),
            title: f.Title.trim(),
            description: String(f.Description || "").trim(),
            deadline: String(f.Deadline || "").replace(/\(optional.*$/i, "").trim(),
            steps: String(f.Steps || "").trim(),
        });
    }

    UPDATE_OBJ_RE.lastIndex = 0;
    while ((m = UPDATE_OBJ_RE.exec(text)) !== null) {
        const f = parseFields(m[1]);
        if (!f.Title) continue;
        result.updateObjectives.push({
            ownerId: f.Owner ? resolveOwnerId(f.Owner) : null,
            title: f.Title.trim(),
            progress: String(f.Progress || "").trim(),
            deadline: String(f.Deadline || "").replace(/\(only if.*$/i, "").trim(),
        });
    }

    const parseTitleOnly = (regex) => {
        const out = [];
        regex.lastIndex = 0;
        while ((m = regex.exec(text)) !== null) {
            const f = parseFields(m[1]);
            if (!f.Title) continue;
            out.push({
                ownerId: f.Owner ? resolveOwnerId(f.Owner) : null,
                title: f.Title.trim(),
            });
        }
        return out;
    };

    result.completeTitles = parseTitleOnly(COMPLETE_OBJ_RE);
    result.abandonTitles = parseTitleOnly(ABANDON_OBJ_RE);

    return result;
}
