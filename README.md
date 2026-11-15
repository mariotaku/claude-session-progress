# session-progress

A Claude Code mod that adds a **Progress** pane beside the chat. The pane shows how the session's work is going: the goal, the tickets, the time left, and what needs you. Claude fills it in through a tool while it works.

## Install

At the prompt of a terminal session:

```
/plugin install session-progress --marketplace mariotaku/claude-session-progress
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install session-progress --marketplace mariotaku/claude-session-progress
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `mariotaku/claude-session-progress`, then **Add plugin**.

## What the pane shows

From top to bottom:

- **Run header.** The goal, `Stop when: <stop condition>`, a status, the percent of estimated work done, elapsed time, and time left (`~25m left`). Time left is always a length of time, never a clock time.
- **Bar.** One segment for each ticket, sized by its estimate. Green is done, amber is working, red is blocked, gray is not started. The bar stays on one line.
- **Ticker.** One line that says what Claude does right now.
- **Tabs.** Keys `1`, `2` and `3` switch them. The pane remembers the open tab.
  - **Tickets** (`T01`, `T02`, …): estimate, status, stage, progress and "waits for". Click a ticket to see its timeline, questions, deliverables and activity.
  - **Deliverables**: files and links.
  - **Activity**: what Claude logged. `git commit`, `git push`, `glab mr create` and `gh pr create` are logged on their own.
- **Needs you.** Stuck items and open questions (`Q1`, `Q2`, …). Each question has lettered options and a recommendation. Pick an option and the pane puts `Q1: A — …` into the prompt. Send the prompt to record the answer.
- **Pill.** A small line above the prompt. It shows only while a question is open or work is stuck.

An empty pane says what it is for and how to fill it. The pane does not open on its own while it is empty. It opens once, when the first run or ticket is recorded.

### Status

| Status | Meaning |
| --- | --- |
| working | A turn of Claude's runs. |
| idle | No turn runs. |
| stuck | Claude reported a stuck item, or a working ticket is past its estimate. |
| possibly stale | Tickets are open, no turn runs, and nothing changed for 15 minutes. |
| finished | Claude called `finish`. Open questions and stuck marks are hidden. |

### How the numbers are made

- **Percent** = estimated minutes done ÷ total estimated minutes. A started ticket counts by its progress. Skipped tickets are left out.
- **Active time** is the time inside Claude's own turns. Subagent turns do not add to it. Time left, pace, each ticket's worked time and the "past estimate" check all use active time. A run that waits for you does not run down the clock.
- **Elapsed time** is calendar time. Past one day the pane also shows the start date: `4d10h since 11/06`.
- A ticket that waits for another open ticket is never "past estimate".
- The pane redraws every 30 seconds.

## `/progress [focus]`

Opens the pane and asks Claude to work on it.

- **Empty pane:** Claude surveys the work and fills the pane in. The survey is read-only. It uses only the branch's own commits (`git log <default>..HEAD`). Merged MRs on the default branch are earlier work.
- **Filled pane:** Claude compares the pane with what happened since the last update, and sends only what changed.

`focus` is optional text that narrows the request: `/progress the importer only`.

## The `progress` tool

Claude calls `mcp__session-progress__progress`. Every field is optional.

| Field | Use |
| --- | --- |
| `start {title, doneWhen, startedAt}` | Begin a run. `startedAt` fixes the start time. |
| `tickets [{id?, title, estimate, status, stage, progress, waitsFor, source}]` | Create or update tickets. `estimate` is in minutes. `status` is `not_started`, `working`, `blocked`, `done` or `skipped`. |
| `ticker` | The line for "right now". |
| `activity` | One line for the log. |
| `deliverable` | A file or a link. |
| `stuck` / `unstuck` | Report or resolve a stuck item. |
| `ask {title, question, options[], recommend}` | Ask you a question. |
| `answer {id, answer}` | Record your answer. `Q-1` is read as `Q1`. |
| `pastActivity [{text, at}]` | Milestones from before now, with their real times. |
| `finish` | The stop condition is met. |
| `clear` | Empty the pane and delete its saved data. |

The tool gives out the ids (`T01`…, `Q1`…, `S1`…) and returns them in its result.

`pastActivity` with an older time moves the run start earlier, and the result says so. `start.startedAt` fixes the start. After that, `pastActivity` cannot change it.

`TaskCreate`, `TaskUpdate` and `TodoWrite` calls become tickets on their own. A ticket made this way starts with a 15-minute estimate.

## Settings

**While a question waits** (`whileQuestionWaits`) says what Claude does while a question has no answer. Set it in `/config`.

| Value | Claude's behavior |
| --- | --- |
| `stop` | Stop and wait for the answer. |
| `work_around` (default) | Work on tickets that do not depend on the answer. |
| `keep_building` | Go on with its recommended option, and redo the work if your answer differs. |

The tool result tells Claude which value applies.

## Language

The pane follows Claude Code's `language` setting. `japanese`, `日本語` or `ja` gives Japanese. Any other value gives English.

Only the text you see is translated: the pane, the pill, the log and the `/progress` output. The text Claude reads (the tool description, the tool results and the `/progress` request) stays in English.

## Saved data

- The mod saves the pane to `$.store`, one key for each session id. It saves 0.5 seconds after each change and when the session ends.
- It loads the data back when a session starts and when you resume one.
- It keeps the 20 newest sessions of the last 30 days and deletes older ones.
- The open tab and the open ticket are not saved.

Limits:

- **`/clear`** empties the pane at once. The data of the session before the `/clear` stays saved.
- **Resume in the same process:** the mod checks the session id when each turn starts and on its 30-second tick. The resumed session's data can take up to 30 seconds to show.
- **A fork starts empty.** The mod cannot tell a fork from a resume, and a fork has a new session id with no saved data.
- The mod does not use `classic.SessionStart`. In Team and Enterprise organizations the built-in `cc-plugin-sec-default` blocks classic hooks from installed mods.
- Data saved by a version without work spans counts wall time until the next turn starts.

## Credits

The idea of this pane comes from [paseo-progress](https://github.com/stevecastaneda/paseo-plugins/tree/main/progress) by Steve Castaneda, a progress dashboard plugin for Paseo (MIT license). session-progress is a separate implementation for Claude Code and shares no code with it.

## License

MIT. See [LICENSE](LICENSE).

## Develop

```
hooks/register.tsx     the hooks: tool, command, pane, pill, saving
hooks/logic.ts         pure logic: data model, time math, bar geometry
hooks/i18n.ts          English and Japanese strings
hooks/claude-text.ts   text Claude reads: tool description, /progress requests
tests/                 *.test.ts(x) and the test kit (kit.ts)
```

Run the mod from its folder:

```
claude --plugin-dir /path/to/claude-session-progress
```

Check and test it:

```
claude plugin validate .
claude plugin test .
```

The engine writes the API types to `.claude-plugin/types/` when it loads the mod from this folder. After that, `tsc -p .` type-checks the mod.

Notes for changes:

- `claude plugin validate` accepts `$` only in functions declared at the top of `register.tsx`. Keep helpers that take `$` there.
- A command's own hook cannot await a prompt that it submits. `/progress` submits its request from a 1 ms timer.
- Choose the rendering by `e.surface`. The terminal's element table has an `Svg` stand-in that draws nothing. The terminal gets a `█`/`░` text bar and a text divider. Desktop, VS Code and mobile get an SVG bar and divider.
- Put new user-facing text in `i18n.ts` in both languages. Put new Claude-facing text in `claude-text.ts`.
