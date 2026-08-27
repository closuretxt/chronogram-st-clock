// Chronogram default injection text for the {{chronogram}} macro.
// Kept separate from the macro/panel logic so the injected wording can be
// reviewed and edited in one place, exactly like settings/defaultPrompt.js
// holds the tracker LLM's system prompt.

export const DEFAULT_INJECTION_INTRO = `The following is persistent timekeeping and objective data for this story, tracked across the entire chat.

- The Date/Time values are the AUTHORITATIVE in-fiction current date and time. Treat them as fact even when your previous replies implied otherwise; keep narration consistent with them from now on.
- Only characters currently present in the story are listed. Anyone NOT listed is off-screen right now: don't place them in the scene or narrate their actions without a story reason. They live their lives elsewhere and can return naturally when the story brings them back.
- Each character has responsibilities and a daily plan. Respect what they are currently doing and where they are expected to be: a character at work is not instantly available; a king holds court whether {{user}} likes it or not. {{user}}'s own duties count too and may pull them away.
- Objectives are substantial, lasting goals for both User and characters. Characters pursue their own objectives off-screen when it makes sense; don't drop them just because they weren't mentioned recently.
- Do not repeat or quote this data verbatim in your reply.`;