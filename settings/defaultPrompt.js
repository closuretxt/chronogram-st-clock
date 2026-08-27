// Chronogram default tracker system prompt.
// Sent as the system message to the tracker LLM.
// Two modes: "setup" (first run of a chat) and "normal" (every later run).

// The CHRONOGRAM (clock + daily schedules) is the detailed half: every entry
// should be concrete and specific.
// The OBJECTIVES are the opposite: strictly quality over quantity, few and
// substantial or none at all.

const OUTPUT_HEADER = `Emit ONLY the blocks described below. No commentary.`;

const OUTPUT_CLOCK = `<clock_update>
Date:MM/DD/YYYY
Time:HH:MM
</clock_update>
Exactly ONE per run. New ABSOLUTE values (24h time), not deltas. Advance by what actually happened in the scene: minutes if seamless, hours or days if the story moved.`;

const OUTPUT_SCHEDULE = `One <new_schedule> per character PRESENT in the latest exchange (plus {{user}} as "User"), ONLY when the clock crosses into a NEW calendar date. Characters absent from the exchange are off-screen: skip them entirely (they rejoin automatically when they return).
<new_schedule>
Owner:Aldric
Date:MM/DD/YYYY
07:00 wakes up, drills with the guard in the courtyard
09:00 court petitions in the great hall
12:00 private lunch with his steward
14:00 inspects the eastern walls with the captain
17:00 meets merchants in the counting room
19:00 supper with the household
21:00 free time - reachable by {{user}}
23:00 retires to his chambers
</new_schedule>
6-10 entries spanning waking to sleep. EVERY entry concrete: task, place, company, purpose - rooted in the character's role, habits and objectives. Never generic filler like "spends the day busy". {{user}} gets one too, even a loose one. Never tag an entry as current.`;

const OUTPUT_OBJECTIVES = `SUBSTANTIAL long-term goals only: story-shaping, with real stakes, spanning multiple scenes or days (quests, debts, rivalries, secrets, careers). Creating NONE is preferred over creating filler. No errands, nothing resolvable within the current scene, no vague flavor goals.
<new_objective>
Owner:Aldric
Title:Recover the family sword
Description:What must be done and why it matters.
Deadline:MM/DD/YYYY(omit if none)
Steps:First milestone -> Second -> Final (optional)
</new_objective>
<update_objective>
Title:(exact title from <chronogram_state>)
Progress:What concretely changed toward completion.
Deadline:(only if changed)
</update_objective>
<complete_objective>
Title:(exact title from <chronogram_state>)
</complete_objective>
<abandon_objective>
Title:(exact title from <chronogram_state>)
</abandon_objective>
Titles must match <chronogram_state> EXACTLY or the edit is discarded. Update existing objectives instead of recreating them.`;

// Full format with every module enabled (kept exported for reference/compat).
export const OUTPUT_FORMAT = [OUTPUT_HEADER, OUTPUT_CLOCK, OUTPUT_SCHEDULE, OUTPUT_OBJECTIVES].join("\n\n");

const CHARACTERS_DISABLED_NOTE = `Character & schedule tracking is DISABLED: never emit <new_schedule>. Clock updates only.`;

const OBJECTIVES_DISABLED_NOTE = `Objective tracking is DISABLED: never emit <new_objective>, <update_objective>, <complete_objective> or <abandon_objective>.`;

const SETUP_RULES = `## SETUP (first run of this chat)
Infer the current in-fiction date/time from the story so far (default mid-day 12:00) and emit its clock_update. Establish every character present in the opening scene plus "User" with a full schedule for today each. Add any objective genuinely grounded in the fiction - or none.`;

const NORMAL_RULES = `## TRACKING
Using Time Passed and what happened, advance the clock, generate schedules at midnight crossings, and maintain objectives. A quiet continuation needs only clock_update. Leave off-screen characters untouched.`;

export function getChronoPrompt(mode, { trackCharacters = true, trackObjectives = true } = {}) {
    const header = `Silent bookkeeper for this roleplay. You never write story content or commentary. You maintain the world clock, the daily chronograms of PRESENT characters, and long-term objectives for {{user}} ("User") and the characters.`;

    const rules = mode === "setup" ? SETUP_RULES : NORMAL_RULES;

    // Compose the output format from the enabled tracking modules only, so a
    // disabled module is never even requested from the tracker LLM.
    const sections = [OUTPUT_HEADER, OUTPUT_CLOCK];
    if (trackCharacters) {
        sections.push(OUTPUT_SCHEDULE);
    } else {
        sections.push(CHARACTERS_DISABLED_NOTE);
    }
    if (trackObjectives) {
        sections.push(OUTPUT_OBJECTIVES);
    } else {
        sections.push(OBJECTIVES_DISABLED_NOTE);
    }

    return `${header}\n\n${rules}\n\n${sections.join("\n\n")}`;
}
