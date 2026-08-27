// Chronogram floating popup window: the chronogram viewer as a draggable,
// resizable window (Persist side-panel pattern). Opened/closed via the
// "Chronogram Window" button in the extension settings; position, size and
// open state are persisted so it reopens exactly where you left it.

import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";

const PANEL_KEY = "Chronogram";
const DEFAULT_POS = { width: 400, height: 600, top: null, left: null };

function getSavedState() {
    return extension_settings[PANEL_KEY] || {};
}

function savePanelState(patch) {
    if (!extension_settings[PANEL_KEY]) extension_settings[PANEL_KEY] = {};
    Object.assign(extension_settings[PANEL_KEY], patch);
    saveSettingsDebounced();
}

export class ChronoWindow {
    constructor() {
        this.$panel = null;
        this.isOpen = false;
        const saved = getSavedState();
        // Restore size/position if previously saved, otherwise defaults.
        this.pos = {
            width: Number(saved.chronoWindowWidth) || DEFAULT_POS.width,
            height: Number(saved.chronoWindowHeight) || DEFAULT_POS.height,
            top: saved.chronoWindowTop != null ? Number(saved.chronoWindowTop) : null,
            left: saved.chronoWindowLeft != null ? Number(saved.chronoWindowLeft) : null,
        };
    }

    init() {
        if (this.$panel) return;

        $("body").append(`
            <div id="chrono_window" style="display:none;">
                <div id="chrono_window_header">
                    <i class="fa-solid fa-clock"></i>
                    <span>Chronogram</span>
                    <button id="chrono_window_close" title="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div id="chrono_window_content">
                    <div class="chrono-empty">Loading...</div>
                </div>
                <div id="chrono_window_resize"></div>
            </div>
        `);

        this.$panel = $("#chrono_window");

        $("#chrono_window_close").on("click", () => this.close());

        this.initDrag();
        this.initResize();

        // Re-fit when the browser window changes size, so the chronogram
        // window can never end up taller than the viewport.
        $(window).on("resize.chronoWindow", () => {
            if (this.isOpen) this.applyPosition();
        });

        // Restore last session state: reopen if the user left it open.
        if (getSavedState().chronoWindowOpen === true) {
            this.open();
        }
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }

    open() {
        this.init();
        if (this.isOpen) return;
        this.applyPosition();
        // Re-assert flex BEFORE showing: the inline template style is
        // display:none, and jQuery's fadeIn would otherwise restore the div
        // to its default display:block.
        this.$panel.css("display", "flex").hide().fadeIn(150);
        this.layoutContent();
        this.isOpen = true;
        savePanelState({ chronoWindowOpen: true });
    }

    close() {
        this.$panel.fadeOut(150);
        this.isOpen = false;
        savePanelState({ chronoWindowOpen: false });
    }

    refreshContent(html) {
        const $content = $("#chrono_window_content");
        if ($content.length === 0) return;
        // Keep the reader's place: re-renders happen on every tracker run.
        const scrollTop = $content.scrollTop();
        $content.html(typeof html === "string" && html.trim()
            ? html
            : '<div class="chrono-empty">No chronogram yet.</div>');
        this.layoutContent();
        $content.scrollTop(scrollTop);
    }

    // Pins the scrollable content exactly below the header (measured, so any
    // font/padding change is handled) and above the window's bottom edge.
    layoutContent() {
        const $header = $("#chrono_window_header");
        const $content = $("#chrono_window_content");
        if ($header.length === 0 || $content.length === 0) return;
        const top = Math.max(0, Math.round($header.outerHeight()) || 41);
        $content.css("top", `${top}px`);
    }

    applyPosition() {
        // Keep the window fully inside the viewport: clamp the saved top so
        // the header stays reachable, then fit the height into what's left.
        let top = this.pos.top ?? Math.max(0, Math.round((window.innerHeight - this.pos.height) / 2));
        top = Math.max(0, Math.min(top, window.innerHeight - 120));
        const left = this.pos.left ?? Math.max(0, window.innerWidth - this.pos.width - 40);
        const height = Math.max(240, Math.min(this.pos.height, window.innerHeight - top - 10));
        this.pos.top = top;
        this.pos.height = height;
        this.$panel.css({ width: this.pos.width, height, top, left });
        this.layoutContent();
    }

    // --- dragging (header) ------------------------------------------------------

    initDrag() {
        let drag = null;

        $("#chrono_window_header").on("mousedown", (e) => {
            // Ignore drags that start on the close button.
            if ($(e.target).closest("#chrono_window_close").length > 0) return;
            const rect = this.$panel[0].getBoundingClientRect();
            drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
            e.preventDefault();
        });

        $(document).on("mousemove.chronoWindow", (e) => {
            if (!drag) return;
            const left = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - 100);
            const top = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 40);
            this.pos.left = left;
            this.pos.top = top;
            this.$panel.css({ left, top });
        });

        $(document).on("mouseup.chronoWindow", () => {
            if (!drag) return;
            drag = null;
            savePanelState({ chronoWindowTop: this.pos.top, chronoWindowLeft: this.pos.left });
        });
    }

    // --- resizing (corner handle) ---------------------------------------------

    initResize() {
        const handle = $("#chrono_window_resize");
        let resize = null;

        handle.on("mousedown", (e) => {
            const rect = this.$panel[0].getBoundingClientRect();
            resize = { startX: e.clientX, startY: e.clientY, startW: rect.width, startH: rect.height };
            e.preventDefault();
            e.stopPropagation();
        });

        $(document).on("mousemove.chronoWindowResize", (e) => {
            if (!resize) return;
            const w = Math.max(300, resize.startW + (e.clientX - resize.startX));
            // Hard cap: the window must never grow past the viewport bottom,
            // otherwise the content scrollbar is off-screen and unreachable.
            const currentTop = parseFloat(this.$panel.css("top")) || 0;
            const maxH = Math.max(240, window.innerHeight - currentTop - 10);
            const h = Math.max(240, Math.min(resize.startH + (e.clientY - resize.startY), maxH));
            this.pos.width = w;
            this.pos.height = h;
            this.$panel.css({ width: w, height: h });
        });

        $(document).on("mouseup.chronoWindowResize", () => {
            if (!resize) return;
            resize = null;
            savePanelState({ chronoWindowWidth: this.pos.width, chronoWindowHeight: this.pos.height });
        });
    }
}

export function refreshPopupContent(html) {
    chronoWindow.refreshContent(html);
}

export function toggleChronoWindow() {
    chronoWindow.init();
    chronoWindow.toggle();
}

export function initPopupWindow() {
    chronoWindow.init();
    // Keep content fresh once the panel module has rendered its first pass.
    import("../chronogram/injection.js")
        .then(({ renderPanelHTML }) => refreshPopupContent(renderPanelHTML()))
        .catch(() => {});
}

export const chronoWindow = new ChronoWindow();

