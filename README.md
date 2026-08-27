# Chronogram | SillyTavern Clock & Objective Tracker

⚠️ NO IDEA if it works for other people. I made it just for myself and wanted to share.

## 🚀 Installation

1. Open SillyTavern, go to the Extensions menu (boxes icon).
2. Click "Install Extension" at the top right.
3. Paste this URL and click 'Install for me':
```plaintext
https://github.com/closuretxt/persist-ST-relationship-tracker
```
4. REQUIRES the addition of the macro {{chronogram}} in order to work. I recommend it after the character description at system level. Keep caching in mind.

## About Chronogram

**Chronogram** is a SillyTavern extension that gives your story a real sense of TIME and RESPONSIBILITY:

- **World clock**: a per-chat in-fiction date (MM/DD/YYYY) and time (HH:MM), tracked by a separate LLM pass that advances it according to what happened in the scene (a quiet exchange is +10m, sleeping overnight jumps to the next morning).
- **Chronograms (daily schedules)**: when the clock crosses into a new day, the tracker builds a step-by-step schedule for every known participant - the king wakes at 8, holds court at 10, lunch at 13... The story LLM knows where everyone is supposed to be, including {{user}}.
- **Current activities**: who is doing what right now, so even a simple single-character story respects that both {{user}} and {{char}} have obligations.
- **Long-term objectives**: durable goals for User AND characters, persisted across days and scenes, updated/completed/abandoned by the tracker.

All of this is injected through the {{chronogram}} macro as a `<chronogram>` block, and can be inspected/edited any time in the draggable popup window ("Chronogram Window" button).

⚠️ *This system makes use of multiple API calls, proceed at your own responsability and beware of usage costs.* ⚠️

## Notes

- The clock's time granularity follows real elapsed time between runs (floored/capped by "Min Time Per Turn" / "Max Advance Per Run"), with the LLM having final say over the absolute date/time.
- Data lives in the chat metadata (`chat_metadata.chronogram`) and survives swipes/deletes via snapshots, exactly like Persist keeps relationships.
- Works alongside Persist; they don't share any state.

## Slopfest

This is vibecoded. Thanks for dealing with my slop.

## 📄 License

AGPL-3.0 LICENSE || Copyright (C) 2026 closuretxt || Please read LICENSE for more information.