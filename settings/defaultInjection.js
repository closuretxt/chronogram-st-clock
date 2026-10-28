// Chronogram default injection text for the {{chronogram}} macro.
// Kept separate from the macro/panel logic so the injected wording can be
// reviewed and edited in one place, exactly like settings/defaultPrompt.js
// holds the tracker LLM's system prompt.

const INTRO_HEADER = `Background timekeeping info for this story, tracked across the chat.`;

const INTRO_CLOCK = `- The date and time below are the current in-fiction moment; keep the narration consistent with them.`;

// Split mode: the clock is injected separately by {{chronogram_time}}.
const INTRO_CLOCK_SPLIT = `- The current in-fiction date and time are given separately in <chronogram_time>; keep the narration consistent with them.`;

const INTRO_PRESENCE = `- The characters listed are around right now. Anyone not listed is elsewhere, living their own day.`;

const INTRO_SCHEDULE = `- Each character shows what they're up to now and a rough outline of the rest of their day. Someone mid-task won't be instantly free, and {{user}} has plans of their own that may pull them away too.`;

// Stable mode: the whole day is listed with no Now/Next markers.
const INTRO_SCHEDULE_STABLE = `- Each character shows their full plan for today. Work out what they're doing right now from the current time. Someone mid-task won't be instantly free, and {{user}} has plans of their own that may pull them away too.`;

const INTRO_RULES = `- If any, objectives are slower-burning goals that keep unfolding in the background, even when nobody mentions them for a while.
- The schedule is a loose reference, not a script. If an activity runs long, stay in it: don't rush, skip ahead, or have characters bring up upcoming items (like dinner) before the current scene actually ends.
- If the narration is stuck mid another scene, ignore the schedule for this beat; the timeline catches up afterward.`;

export function buildInjectionIntro({ split = false, stable = false } = {}) {
    return [
        INTRO_HEADER,
        split ? INTRO_CLOCK_SPLIT : INTRO_CLOCK,
        INTRO_PRESENCE,
        stable ? INTRO_SCHEDULE_STABLE : INTRO_SCHEDULE,
        INTRO_RULES,
    ].join("\n");
}

export const DEFAULT_INJECTION_INTRO = buildInjectionIntro();
