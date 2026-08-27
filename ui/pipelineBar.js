// Chronogram tracker pipeline progress bar.
// Adapted from setup/pipelineBarExample.js: same API, but it creates its own
// DOM on init (the recast_* elements belong to another extension) and uses
// chrono_* ids. If streaming is on, updateChunk() compares word count between
// the last pass and the current one to fake progress; with stream:false the
// bar simply fills per pass.
//
// The floating bar can be disabled with the "Show Progress Bar" setting
// (showProgressBar); when off every lifecycle method no-ops.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "../settings/settingsManager.js";

export class PipelineBar {
    constructor() {
        this.progressBar = null;
        this.progressText = null;
        this.progressPercent = null;
        this.progressFill = null;
        this.spinnerIcon = null;
        this.formShield = null;

        this.totalPasses = 0;
        this.currentPassIndex = 0;
        this.basePercent = 0;
        this.passPercentInfluence = 0;
        this.previousPassWords = 1;
        this.isActive = false;
        this._hideTimer = null;
    }

    _isEnabled() {
        const s = extension_settings[extensionName];
        return !s || s.showProgressBar !== false;
    }

    _wordCount(text) {
        return text ? text.trim().split(/\s+/).length : 0;
    }

    _setPercent(p) {
        if (this.progressPercent) this.progressPercent.text(`${Math.round(p)}%`);
    }

    _show() {
        if (!this.progressBar || this.progressBar.length === 0) return;
        clearTimeout(this._hideTimer);
        this.progressBar.css("display", "block");
        requestAnimationFrame(() => this.progressBar.addClass("chrono-visible"));
    }

    _hideBarOnly(immediate = false) {
        if (!this.progressBar || this.progressBar.length === 0) return;
        clearTimeout(this._hideTimer);
        this.progressBar.removeClass("chrono-visible");
        if (immediate) {
            this.progressBar.css("display", "none");
        } else {
            this._hideTimer = setTimeout(() => this.progressBar.css("display", "none"), 300);
        }
    }

    // Guard used by every lifecycle method: if the bar was disabled mid-run,
    // hide the floating visuals but let the run itself continue.
    _checkEnabled() {
        if (this._isEnabled()) return true;
        this._hideBarOnly(true);
        this.isActive = false;
        return false;
    }

    init(stopCallback) {
        if (!this._isEnabled()) {
            this._hideBarOnly(true);
            return;
        }

        // Self-contained markup: create the bar once if it isn't there yet.
        if ($("#chrono_progress_bar").length === 0) {
            $("body").append(`
                <div id="chrono_progress_bar">
                    <div class="chrono-progress-row">
                        <i class="chrono-progress-spinner fa-solid fa-circle-notch"></i>
                        <span id="chrono_progress_text"></span>
                        <span id="chrono_progress_percent">0%</span>
                        <button id="chrono_stop_pipeline" class="chrono-stop-btn" title="Stop the chronogram tracker"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div id="chrono_progress_track"><div id="chrono_progress_fill"></div></div>
                </div>
            `);
        }

        this.progressBar = $("#chrono_progress_bar");
        this.progressText = $("#chrono_progress_text");
        this.progressPercent = $("#chrono_progress_percent");
        this.progressFill = $("#chrono_progress_fill");
        this.formShield = $("#form_sheld");
        this.spinnerIcon = this.progressBar.find(".chrono-progress-spinner");

        this.progressBar.find("#chrono_stop_pipeline").off("click").on("click", () => {
            this.hide();
            if (stopCallback) stopCallback();
        });
    }

    start(totalPasses, initialText) {
        if (!this._checkEnabled()) return;

        this.totalPasses = totalPasses;
        const wc = this._wordCount(initialText);
        this.previousPassWords = wc > 0 ? wc : 1;
        this.isActive = true;

        this.progressBar.removeClass("chrono-done");
        this.spinnerIcon.attr("class", "chrono-progress-spinner fa-solid fa-circle-notch");
        this.progressText.text(`Starting pipeline...`);
        this.progressFill.css("width", `0%`);
        this._setPercent(0);
        this.formShield.addClass("chrono-input-active");
        this._show();
    }

    updatePass(index, passName) {
        if (!this._checkEnabled()) return;

        this.currentPassIndex = index;
        this.basePercent = (index / this.totalPasses) * 100;
        this.passPercentInfluence = (1 / this.totalPasses) * 100;

        this.progressText.text(`Pass ${index + 1}/${this.totalPasses}: ${passName}`);
        this.progressFill.css("width", `${this.basePercent}%`);
        this._setPercent(this.basePercent);
    }

    updateChunk(currentText) {
        if (!this._checkEnabled() || !this.isActive || this.totalPasses === 0) return;

        // Progress up to influence minus 5%
        const maxChunkInfluence = Math.max(0, this.passPercentInfluence - 5);
        const currentWords = this._wordCount(currentText);

        if (currentWords >= this.previousPassWords) {
            this.previousPassWords = currentWords + 10;
        }

        const ratio = Math.min(currentWords / this.previousPassWords, 1.0);

        const currentPercent = this.basePercent + (ratio * maxChunkInfluence);
        this.progressFill.css("width", `${currentPercent}%`);
        this._setPercent(currentPercent);
    }

    finishPass(finalText) {
        if (!this._checkEnabled()) return;

        // Snap to the end of this pass's full slot before moving to the next
        const endPercent = this.basePercent + this.passPercentInfluence;
        this.progressFill.css("width", `${endPercent}%`);
        this._setPercent(endPercent);
        const wc = this._wordCount(finalText);
        this.previousPassWords = wc > 0 ? wc : 1;
    }

    complete() {
        if (!this._checkEnabled()) return;

        this.isActive = false;
        this.progressFill.css("width", `100%`);
        this._setPercent(100);
        this.progressText.text(`Pipeline complete!`);
        this.progressBar.addClass("chrono-done");
        this.spinnerIcon.attr("class", "chrono-progress-spinner fa-solid fa-check");
        clearTimeout(this._hideTimer);
        this._hideTimer = setTimeout(() => {
            this.hide();
        }, 1600);
    }

    hide() {
        this.isActive = false;
        this._hideBarOnly();
        if (this.formShield && this.formShield.length > 0) {
            this.formShield.removeClass("chrono-input-active");
        }
    }
}

export const pipelineBar = new PipelineBar();
