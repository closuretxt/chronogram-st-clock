// Legacy API support: swaps the active Connection Manager profile via slash
// command before the tracker request, then restores it afterwards.
import { SlashCommandParser } from "../../../../slash-commands/SlashCommandParser.js";
import { event_types, online_status, eventSource } from "../../../../../script.js";

const LOG_PREFIX = "[Chronogram Profile Swapper]";

function waitUntilCondition(conditionFn, timeout = 5000, interval = 100) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const check = () => {
            if (conditionFn()) {
                resolve();
            } else if (Date.now() - startTime > timeout) {
                reject(new Error("Timeout waiting for condition"));
            } else {
                setTimeout(check, interval);
            }
        };
        check();
    });
}

function waitForEvent(eventType, timeout = 5000) {
    return new Promise((resolve, reject) => {
        let timeoutId;
        const handler = () => {
            clearTimeout(timeoutId);
            eventSource.removeListener(eventType, handler);
            resolve();
        };
        timeoutId = setTimeout(() => {
            eventSource.removeListener(eventType, handler);
            reject(new Error(`Timeout waiting for event ${eventType}`));
        }, timeout);
        eventSource.on(eventType, handler);
    });
}

export async function swapProfile(targetProfileName, currentProfileName) {
    if (!targetProfileName || targetProfileName === 'None') {
        console.error(LOG_PREFIX, 'No target profile selected');
        return false;
    }

    if (currentProfileName === targetProfileName) {
        console.warn(`${LOG_PREFIX} Target profile is already active. Aborting swap process.`);
        return true;
    }

    console.warn(`${LOG_PREFIX} Swapping to profile ${targetProfileName}`);

    try {
        const waitForProfileLoad = waitForEvent(event_types.CONNECTION_PROFILE_LOADED, 5000);

        await SlashCommandParser.commands['profile'].callback(
            {
                await: 'true',
                _scope: null,
                _abortController: null,
            },
            targetProfileName,
        );

        await waitUntilCondition(() => online_status === 'no_connection', 5000, 100).catch(() => {});
        await waitForProfileLoad.catch(() => {});
        await waitUntilCondition(() => online_status !== 'no_connection', 5000, 100).catch(() => {});

        await new Promise(resolve => setTimeout(resolve, 1500)); // Some APIs load twice; always wait.

        console.warn(`${LOG_PREFIX} Successfully swapped to profile`);
        return true;
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed to swap to profile: ${error}`);
        return false;
    }
}
