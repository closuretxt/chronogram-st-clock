// Chronogram default injection text for the {{chronogram}} macro.
// Kept separate from the macro/panel logic so the injected wording can be
// reviewed and edited in one place, exactly like settings/defaultPrompt.js
// holds the tracker LLM's system prompt.

export const DEFAULT_INJECTION_INTRO = `Background timekeeping info for this story, tracked across the chat.
- The date and time below are the current in-fiction moment; keep the narration consistent with them.
- The characters listed are around right now. Anyone not listed is elsewhere, living their own day.
- Each character shows what they're up to now and a rough outline of the rest of their day. Someone mid-task won't be instantly free, and {{user}} has plans of their own that may pull them away too.
- If any, objectives are slower-burning goals that keep unfolding in the background, even when nobody mentions them for a while.
- The schedule is a loose reference, not a script. If an activity runs long, stay in it: don't rush, skip ahead, or have characters bring up upcoming items (like dinner) before the current scene actually ends.
- If the narration is stuck mid another scene, ignore the schedule for this beat; the timeline catches up afterward.`;