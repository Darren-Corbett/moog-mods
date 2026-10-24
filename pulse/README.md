# Pulse

A live, animated graph of what Claude is doing, in a pane beside the chat.

```
Pulse · Refactor auth… · 3m 41s · ● working  [-] [+]
⠀⠀⢀⣀⣠⣴⣶⣦⣤⣀⡀⠀⠀⠀⢀⣤⣶⣿⣿⣶⣤⡀⠀⠀⠀⠀⣀⣤⣶⣦⣤⣀⠀⠀⠀
████████████▓▓▓▓▓▓▓▓░░░░░░░░░░░░    step 2 of 4
■ read ■ search ■ edit ■ run ■ fail      ~ 14/min
────────────────────────────────────────────────
▸ 0:42 ago  Edit  session.ts  (+12 −4)
```

- **Header:** the job, its elapsed time, and a status dot. The dot pulses while Claude works, turns amber when Claude needs you, red when stuck and green when done. Below 41 columns it shortens to the dot, the time and a trimmed job name.
- **Width buttons:** `[-]` and `[+]` at the header's right make the pane 8 columns narrower or wider, between 28 and 72 (the keys `-` and `+` do the same once the graph has the focus). The width is kept for next time.
- **Activity wave:** tool calls per column, coloured by the most common kind: read and search blue, edit green, run amber, failed red. A column is 5 seconds; while a job is too short to fill the pane its columns are shorter (down to half a second), so the wave spreads across the width. While Claude thinks without calling tools, a soft sweep runs along the baseline.
- **Step bar:** one segment per task-list step, sized by time spent: done solid, active shaded, upcoming dotted.
- **Legend and rate:** the colour key, plus calls over the last minute, shortened to fit. Hidden below 41 columns.
- **Detail line:** hover a column or step to see what happened there, and click to pin it (click again to unpin). With nothing hovered it shows the latest call.

Every row fits the pane with a column to spare, even in a terminal that draws symbols like ● and · or CJK and emoji two cells wide, and is cut rather than wrapped if it ever doesn't, and a click acts the moment the button goes down; the graph then drops its pointer listener rather than holding the mouse until the button comes up. Once you've clicked the graph, ← and → move along the columns, Enter pins one and Escape returns to the prompt.

## Install

In a Claude Code terminal session:

```
/plugin install pulse --marketplace Darren-Corbett/moog-mods
```

## Use

- `/pulse` opens or closes the pane. If you leave it open, it reopens in your next session.
- `/pulse width <28-72>` sets the pane's width directly; `/pulse width` says what it is.
- `/pulse mouse off` stops the graph listening to the mouse at all (the keys still work); `/pulse mouse on` turns it back on. Kept across sessions.
- `/pulse mouse debug` shows the last pointer position and what it landed on in the detail line, to check clicks by eye; `/pulse mouse debug off` hides it.
- `/pulse doctor` prints the Claude Code version, whether the graph is running, the width and mouse setting, and any errors caught.

In VS Code, or if the graph ever fails, the pane shows a plain text summary instead.

Pulse only watches and draws. It adds no tools or prompt text, makes no model calls and never blocks a tool call. It draws only in its own pane, so it works alongside Clean View.
