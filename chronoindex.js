// HERE FOR EXAMPLE SAKE
// IMPORTS
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, generateRaw, updateMessageBlock, messageFormatting, scrollChatToBottom, setSendButtonState, isStreamingEnabled as isSTStreamingEnabled, showSwipeButtons, substituteParams } from "../../../../script.js";
import { power_user } from "../../../power-user.js"
import { applyStreamFadeIn } from "../../../util/stream-fadein.js";
import { getWorldInfoPrompt } from "../../../world-info.js";
import { macros as macroSystem } from "../../../macros/macro-system.js";
import { getRegexedString, regex_placement } from "../../regex/engine.js";
// Settings
import { loadSettings, saveSettings, defaultSettings, initSettingsListeners } from "./settings/settingsManager.js";
export { loadSettings, saveSettings, defaultSettings };

// Self Util
import { showDiffModal, initDiffViewer, updateRecastData, storeRecastData, injectReopenDiffButton, updateReopenDiffButtons, reopenDiffForMessage } from "./util/diffViewer.js";
import { swapProfile } from "./util/profileSwapper.js";
import { presetManager } from "./ui/presetManager.js";
// Compatibility Extensions
import { initCompatibilityListeners, shouldSkipStreamIntercept, shouldIgnoreMessageReceived } from "./util/compatibility.js";
// UI
import { pipelineBar } from "./ui/pipelineBar.js";
// Slash Commands
import { initSlashCommands } from "./util/slashCommands.js";

// Setup
export const extensionName = "Recast";
const extensionFolderPath = `scripts/extensions/third-party/recast-post-processing`;
const extensionSettings = extension_settings[extensionName];

// Starting variables
const recentProcessedMessages = new Set(); // Per message cooldown. Making sure other extensions won't trigger the pipeline twice. Yeah I know...
let isProcessing = false;
let currentMessageId = null;
// Set by GENERATION_STARTED so the MutationObserver can hide the incoming AI message block before streaming
let hideNextAiMessage = false;
let skipGenTypecheck = false;
// Intercept observer that blanks streaming tokens into .mes_text while the pipeline is pending
let streamInterceptObserver = null;
let isResettingStream = false;
let isPipelineCancelled = false;
let lastGenerationType = null;

// Pass utility and macro
const PassResults = {};
let OriginalResult = "";
let LatestResult = "";
let _passSnapshots = [];
let _passNames = [];

// Track which macros we registered so we can refresh cleanly
let _registeredRecastMacros = new Set();

// Base functions
// Utility to get ST variables
function getST() {
    return getContext();
}

// Debug function ofc
export function logDebug(...args) {
    if (extension_settings[extensionName].debug_mode) {
        console.log("[Recast Debug]", ...args);
    }
}
