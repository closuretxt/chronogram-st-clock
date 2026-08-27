// Injection: registers the {{chronogram}} macro which renders the world
// clock, participants' current activities, today's schedules and long-term
// objectives as a single <chronogram> block for the story LLM.
// Also renders the Chronogram viewer panel (drawer + popup window share it).

import { macros as macroSystem } from "../../../../macros/macro-system.js";
import { extension_settings } from "../../../../extensions.js";
import {
    getClock,
    getParticipants,
    getScheduleFor,
    getObjectives,
    setClock,
    resetState,
    addObjective,
    removeObjectiveById,
    setObjectiveStatusById,
    parseTimeHM,
    parseDateMDY,
} from "./state.js";
import { DEFAULT_INJECTION_INTRO } from "../settings/defaultInjection.js";

export const extensionName = "Chronogram";

const MACRO_KEY = "chronogram";

function escapeHtml(text) {
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

// The injected wording lives in its own file (mirrors settings/defaultPrompt.js
// for the tracker prompt) so the format can be tuned without touching logic.
export { DEFAULT_INJECTION_INTRO };

// Builds the full injected text for the macro.
export function buildInjectionText() {
    const settings = extension_settings[extensionName] || {};
    const format = ["full", "raw", "none"].includes(settings.injectFormat) ? settings.injectFormat : "full";
    if (format === "none") return "";

    const clock = getClock();
    const participants = getParticipants();
    const objectives = getObjectives();

    const lines = [];
    if (clock) {
        lines.push(`<Date>${clock.date}</Date>`);
        lines.push(`<Time>${clock.time}</Time>`);
    } else {
        lines.push("<Date>(not yet established)</Date>");
        lines.push("<Time>(not yet established)</Time>");
    }

    for (const [id, p] of Object.entries(participants)) {
        lines.push(`<person name="${escapeHtml(p.name || id)}">`);
        if (p.activity) lines.push(`Doing:${p.activity}`);
        if (clock?.date) {
            const sched = getScheduleFor(id, clock.date);
            if (sched.length > 0) {
                lines.push(`Plan for today: ${sched.map(e => `${e.time} ${e.activity}`).join("; ")}.`);
            }
        }
        lines.push("</person>");
    }

    const active = objectives.filter(o => o.status === "active");
    if (active.length > 0) {
        lines.push("<objectives>");
        for (const o of active) {
            const ownerName = o.owner === "user" ? "User" : (participants[o.owner]?.name || o.owner);
            const bits = [`Owner:${ownerName}`, `Title:${o.title}`];
            if (o.description) bits.push(`About:${o.description}`);
            if (o.deadline) bits.push(`Deadline:${o.deadline}`);
            if (o.progress) bits.push(`Progress:${o.progress}`);
            lines.push("- " + bits.join(" | "));
        }
        lines.push("</objectives>");
    }

    const body = lines.join("\n");

    if (format === "raw") return body;
    return `<chronogram>\n${DEFAULT_INJECTION_INTRO}\n${body}\n</chronogram>`;
}

// ---------------------------------------------------------------------------
// Macro registration
// ---------------------------------------------------------------------------

function registerMacro() {
    try {
        macroSystem.registry.registerMacro(MACRO_KEY, {
            category: macroSystem.category?.MISC ?? "misc",
            description: "Persistent world clock, per-character activities/daily chronograms and long-term objectives tracked by Chronogram.",
            handler: () => buildInjectionText(),
        });
    } catch (e) {
        // Already registered (e.g. hot reload); re-register to refresh the handler.
        try {
            macroSystem.registry.unregisterMacro(MACRO_KEY);
            macroSystem.registry.registerMacro(MACRO_KEY, {
                category: macroSystem.category?.MISC ?? "misc",
                description: "Persistent world clock, activities, schedules and objectives tracked by Chronogram.",
                handler: () => buildInjectionText(),
            });
        } catch (e2) {
            console.warn("[Chronogram] Failed to register {{chronogram}} macro.", e2);
        }
    }
}

export function registerInjectionMacro() {
    registerMacro();
}

export function unregisterInjectionMacro() {
    try {
        macroSystem.registry.unregisterMacro(MACRO_KEY);
    } catch {
        // Not registered; fine.
    }
}

// ---------------------------------------------------------------------------
// Chronogram viewer panel
// ---------------------------------------------------------------------------

function statusBadge(status) {
    const map = {
        active: '<span class="chrono-badge chrono-badge-active">Active</span>',
        completed: '<span class="chrono-badge chrono-badge-completed">Completed</span>',
        abandoned: '<span class="chrono-badge chrono-badge-abandoned">Abandoned</span>',
    };
    return map[status] || "";
}

function renderObjectiveCard(o) {
    const ownerName = o.owner === "user" ? "User" : (getParticipants()[o.owner]?.name || o.owner);
    return `
        <div class="chrono-objective ${o.status !== "active" ? "chrono-objective-inactive" : ""}" data-obj="${escapeHtml(o.id)}">
            <div class="chrono-objective-header">
                <span class="chrono-objective-title">${escapeHtml(o.title)}</span>
                <span class="chrono-owner-tag">${escapeHtml(ownerName)}</span>
                ${statusBadge(o.status)}
                <div class="chrono-actions">
                    ${o.status === "active"
                        ? `<button class="menu_button menu_button_icon chrono-obj-complete" data-obj="${escapeHtml(o.id)}" title="Mark as completed"><i class="fa-solid fa-check"></i></button>
                           <button class="menu_button menu_button_icon chrono-obj-abandon" data-obj="${escapeHtml(o.id)}" title="Abandon this objective"><i class="fa-solid fa-xmark"></i></button>`
                        : `<button class="menu_button menu_button_icon chrono-obj-reactivate" data-obj="${escapeHtml(o.id)}" title="Set back to active"><i class="fa-solid fa-rotate-left"></i></button>`}
                    <button class="menu_button menu_button_icon chrono-obj-remove" data-obj="${escapeHtml(o.id)}" title="Delete permanently"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>
            ${o.description ? `<div class="chrono-objective-desc">${escapeHtml(o.description)}</div>` : ""}
            ${o.deadline ? `<div class="chrono-objective-meta"><i class="fa-solid fa-hourglass-half"></i> Deadline: ${escapeHtml(o.deadline)}</div>` : ""}
            ${o.progress ? `<div class="chrono-objective-meta"><i class="fa-solid fa-forward"></i> ${escapeHtml(o.progress)}</div>` : ""}
        </div>`;
}

function renderParticipantCard(id, p) {
    const clock = getClock();
    const sched = clock?.date ? getScheduleFor(id, clock.date) : [];
    const nowMin = clock ? parseTimeHM(clock.time) : null;
    const currentEntry = (() => {
        if (nowMin === null) return null;
        let current = null;
        for (const e of sched) {
            const t = parseTimeHM(e.time);
            if (t !== null && t <= nowMin) current = e;
        }
        return current;
    })();

    const schedLines = sched.map(e => (
        `<div class="chrono-sched-entry${e === currentEntry ? " chrono-sched-now" : ""}">`
        + `<span class="chrono-sched-time">${escapeHtml(e.time)}</span>${escapeHtml(e.activity)}</div>`
    )).join("");

    return `
        <div class="chrono-participant">
            <div class="chrono-participant-header">
                <span class="chrono-name">${escapeHtml(p.name || id)}</span>
                ${id === "user" ? '<span class="chrono-badge">You</span>' : ""}
            </div>
            ${p.activity ? `<div class="chrono-doing"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(p.activity)}</div>` : ""}
            ${schedLines
                ? `<div class="chrono-schedule">${schedLines}</div>`
                : '<div class="chrono-empty-small">No chronogram for today yet.</div>'}
        </div>`;
}

// Whether the "add objective" form is folded open. Kept at module level so
// panel re-renders (which happen on every tracker run) don't slam it shut.
let _addFormOpen = false;
// Whether the Objectives drawer is expanded.
let _objectivesOpen = true;

// The shared HTML used by BOTH the settings-drawer panel and the popup window.
export function renderPanelHTML() {
    const clock = getClock();
    const participants = Object.entries(getParticipants());
    const objectives = getObjectives();

    if (!clock && participants.length === 0) {
        return '<div class="chrono-empty">No chronogram yet. Run the tracker to establish the current date and time.</div>';
    }

    const objectiveCards = objectives.map(renderObjectiveCard).join("")
        || '<div class="chrono-empty-small">No objectives tracked.</div>';

    return `
        <div class="chrono-clock-card">
            <div class="chrono-clock-header"><i class="fa-solid fa-clock"></i><span>World Clock</span></div>
            <div class="chrono-clock-value">
                <input type="text" id="chrono_clock_date" class="text_pole" value="${escapeHtml(clock?.date ?? "")}" placeholder="MM/DD/YYYY" maxlength="10" style="width:110px;">
                <input type="text" id="chrono_clock_time" class="text_pole" value="${escapeHtml(clock?.time ?? "")}" placeholder="HH:MM" maxlength="5" style="width:70px;">
                <button id="chrono_clock_save" class="menu_button menu_button_icon" title="Save the clock manually"><i class="fa-solid fa-floppy-disk"></i></button>
            </div>
        </div>
        <div class="chrono-section-header"><i class="fa-solid fa-users"></i><span>Participants</span></div>
        ${participants.map(([id, p]) => renderParticipantCard(id, p)).join("") || '<div class="chrono-empty-small">No participants yet.</div>'}
        <div class="chrono-drawer${_objectivesOpen ? "" : " chrono-drawer-closed"}">
            <div class="chrono-drawer-header" id="chrono_objectives_header" title="Click to collapse or expand objectives">
                <i class="fa-solid fa-list-check"></i><span>Objectives</span>
                <button id="chrono_toggle_add_objective" class="menu_button menu_button_icon" title="${_addFormOpen ? "Close the add-objective form" : "Add an objective"}"><i class="fa-solid fa-${_addFormOpen ? "chevron-up" : "plus"}"></i></button>
                <i class="fa-solid fa-chevron-down chrono-drawer-chevron"></i>
            </div>
            <div class="chrono-drawer-content">
                ${objectiveCards}
                ${_addFormOpen ? `
                <div class="chrono-add-objective">
                    <input type="text" id="chrono_new_title" class="text_pole" placeholder="New objective title..." style="flex:2;">
                    <input type="text" id="chrono_new_owner" class="text_pole" placeholder="Owner (blank = User)" style="flex:1;">
                    <button id="chrono_add_objective" class="menu_button menu_button_icon" title="Add objective"><i class="fa-solid fa-check"></i></button>
                </div>` : ""}
            </div>
        </div>`;
}

// Re-renders the drawer panel and keeps the floating popup in sync.
export function refreshChronoPanel() {
    const html = renderPanelHTML();
    const $container = $("#chrono_panel");
    if ($container.length > 0) {
        $container.html(html);
    }
    import("../ui/popupWindow.js").then(({ refreshPopupContent }) => refreshPopupContent(html)).catch(() => {});
}

// Handlers are delegated on the document ONCE, so they work for both the
// settings-drawer panel and the floating popup no matter which one is created
// first (the popup's DOM didn't exist at startup, which is why per-container
// binding silently never bound popup handlers). Lookups are scoped through
// .closest() because the same markup/ids exist in both containers.
function bindPanelHandlers() {
    const $doc = $(document);

    const warn = (msg) => { if (typeof toastr !== "undefined") toastr.warning(msg, "Chronogram"); };

    $doc.on("click", "#chrono_clock_save", function () {
        const $row = $(this).closest(".chrono-clock-value");
        const date = String($row.find("#chrono_clock_date").val() || "").trim();
        const time = String($row.find("#chrono_clock_time").val() || "").trim();
        if (!parseDateMDY(date)) {
            warn("Use MM/DD/YYYY for the date.");
            return;
        }
        if (parseTimeHM(time) === null) {
            warn("Use HH:MM (24h) for the time.");
            return;
        }
        setClock(date, time);
        refreshChronoPanel();
    });

    $doc.on("click", ".chrono-obj-complete", function () {
        setObjectiveStatusById(String($(this).data("obj")), "completed");
        refreshChronoPanel();
    });

    $doc.on("click", ".chrono-obj-abandon", function () {
        setObjectiveStatusById(String($(this).data("obj")), "abandoned");
        refreshChronoPanel();
    });

    $doc.on("click", ".chrono-obj-reactivate", function () {
        setObjectiveStatusById(String($(this).data("obj")), "active");
        refreshChronoPanel();
    });

    $doc.on("click", ".chrono-obj-remove", function () {
        removeObjectiveById(String($(this).data("obj")));
        refreshChronoPanel();
    });

    // Collapse/expand the objectives drawer (the "+" button inside is excluded).
    $doc.on("click", "#chrono_objectives_header", (e) => {
        if ($(e.target).closest("#chrono_toggle_add_objective").length > 0) return;
        _objectivesOpen = !_objectivesOpen;
        refreshChronoPanel();
    });

    // "+" in the Objectives header folds the add form in/out.
    $doc.on("click", "#chrono_toggle_add_objective", () => {
        _addFormOpen = !_addFormOpen;
        refreshChronoPanel();
    });

    const submitNewObjective = ($form) => {
        const title = String($form.find("#chrono_new_title").val() || "").trim();
        if (!title) {
            warn("Give the objective a title first.");
            return;
        }
        const ownerInput = String($form.find("#chrono_new_owner").val() || "").trim();
        addObjective({ owner: ownerInput || "user", title });
        _addFormOpen = false;
        refreshChronoPanel();
    };

    $doc.on("click", "#chrono_add_objective", function () {
        submitNewObjective($(this).closest(".chrono-add-objective"));
    });

    // Enter inside the form submits it; Escape folds it away.
    $doc.on("keydown", "#chrono_new_title, #chrono_new_owner", function (e) {
        if (e.key === "Enter") {
            e.preventDefault();
            submitNewObjective($(this).closest(".chrono-add-objective"));
        } else if (e.key === "Escape") {
            _addFormOpen = false;
            refreshChronoPanel();
        }
    });
}

let _handlersBound = false;

export function initPanelHandlers() {
    if (_handlersBound) return;
    _handlersBound = true;
    bindPanelHandlers();
}

// Manual reset button support.
export function resetChatData() {
    resetState();
    refreshChronoPanel();
}



