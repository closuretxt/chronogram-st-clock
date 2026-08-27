// Connection Manager helpers for the Chronogram tracker LLM.
// Adapted from Persist's reference implementation so the tracker can run
// through a dedicated SillyTavern Connection profile.
import { getContext, extension_settings } from "../../../../extensions.js";

export function logDebug(...args) {
    if (extension_settings?.Chronogram?.debug_mode) {
        console.log("[Chronogram Debug]", ...args);
    }
}

export function getST() {
    return getContext();
}

export function getErrorStatusCode(error) {
    return error?.response?.status
        ?? error?.status
        ?? error?.error?.status
        ?? error?.cause?.status
        ?? error?.cause?.response?.status
        ?? null;
}

export function shouldRetryRequest(error) {
    const StatusCode = getErrorStatusCode(error);
    return StatusCode === 400 || StatusCode === 401 || StatusCode === 403;
}

export function isConnectionManagerActive(st) {
    return !st?.extensionSettings?.disabledExtensions?.includes("connection-manager")
        && !!st?.extensionSettings?.connectionManager;
}

export function getConnectionProfiles(st) {
    if (!isConnectionManagerActive(st)) {
        return [];
    }
    return st.extensionSettings.connectionManager.profiles || [];
}

export function hasConnectionProfile(st, profileId) {
    if (!profileId) return true;
    const Profiles = getConnectionProfiles(st);
    return Profiles.some(p => p.id === profileId);
}

export function getProfileNameById(st, profileId) {
    if (!profileId) return null;
    const Profiles = getConnectionProfiles(st);
    const profile = Profiles.find(p => p.id === profileId);
    return profile ? profile.name : null;
}

// Preferred profile -> globally selected profile -> "" (current connection)
export function resolveConnectionProfile(st, preferredProfileId = "") {
    const SelectedProfile = st?.extensionSettings?.connectionManager?.selectedProfile || "";

    if (!isConnectionManagerActive(st)) {
        return "";
    }

    if (preferredProfileId && hasConnectionProfile(st, preferredProfileId)) {
        return preferredProfileId;
    }

    if (preferredProfileId && !hasConnectionProfile(st, preferredProfileId)) {
        console.warn(`[Chronogram] Requested profile '${preferredProfileId}' not found. Falling back to current profile.`);
    }

    if (SelectedProfile && hasConnectionProfile(st, SelectedProfile)) {
        return SelectedProfile;
    }

    return "";
}

// Strips reasoning content from a raw completion using the reasoning template
// configured on the Connection profile. Thanks qvink for the approach.
export function parse_reasoning(text, profile_id) {
    const st = getST();

    if (typeof st?.parseReasoningFromString !== "function" || typeof st?.getReasoningTemplateByName !== "function") {
        return text;
    }

    const Profiles = getConnectionProfiles(st);
    const profile_data = Profiles.find(p => p.id === profile_id);
    if (!profile_data) return text;

    const template_name = profile_data["reasoning-template"];
    if (!template_name) return text;

    const template = st.getReasoningTemplateByName(template_name);
    if (!template) return text;

    const parsed = st.parseReasoningFromString(text, {}, template);
    if (!parsed?.reasoning) return text; // No reasoning present

    return parsed.content || text;
}

export function showErrorToast(contextName, error) {
    if (typeof toastr !== "undefined" && toastr.error) {
        let errorMsg = error?.message || String(error);
        const statusCode = getErrorStatusCode(error);

        if (errorMsg === "[object Object]") {
            try {
                errorMsg = JSON.stringify(error);
            } catch {
                errorMsg = "Unknown object error";
            }
        }

        if (statusCode !== null && statusCode !== undefined) {
            errorMsg = `HTTP ${statusCode}: ${errorMsg}`;
        }

        toastr.error(`Check your Connection Profile. Error in "${contextName}": ${errorMsg}`, "Chronogram Error", { timeOut: 10000 });
    }
}
