# usage-stats

A Claude Code mod that shows what your work costs and how far along it is.

**Usage pane** (session sidebar):

- Weekly and 5-hour limit used, with time to reset
- This week (all projects), this project, this task (session) and the last turn
- For each: estimated API cost, tokens and time

**Status scanner** in the band above the prompt, with the percent done next to it:

- Red light sweeping both ways while Claude works
- Solid green when the turn is finished
- Pulsing amber when a question waits for you (a question box, a plan to approve, or a turn that ends asking you something)

The desktop app draws it as an animated vector image; the terminal draws a plain colored bar.

**Progress line** on the working spinner:

```
████░░░░░░ 37% · step 2/4: Write code · 1m 0s · ~1m 40s left
```

The percentage follows Claude's task list (finished steps count fully, the running step counts half). The time left is a rough estimate from the pace of the finished steps. Without a task list it shows elapsed time only.

## Install

At the prompt of a terminal session:

```
/plugin install usage-stats --marketplace HelloMooove/claude-usage-stats
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install usage-stats --marketplace HelloMooove/claude-usage-stats
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `HelloMooove/claude-usage-stats`, then Add plugin.

Run `/usage-stats` to reopen the pane if you close it.

## Notes

- Cost is the same estimate `/cost` shows, at API list prices.
- Week and project totals count sessions that ran with the mod installed, from the day you install it. Each machine (and WSL) keeps its own totals.
- Time is the main conversation's wall clock; subagents run inside it and are not added on top.
