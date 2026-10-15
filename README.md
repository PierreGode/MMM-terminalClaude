# MMM-terminalClaude

A [MagicMirror²](https://magicmirror.builders) module that shows what Claude Code is doing on the box the mirror runs on.

- **Live topology map** (hybrid bus + star): the host drives a horizontal bus. Idle and waiting sessions tap off above it. Each busy session drops below the bus and becomes its own star of recent tool calls (files edited or read, commands, web lookups, MCP calls) and active subagents. Packets flow along the bus to busy sessions, and the running call pulses. Set `layout: "star"` for the plain star layout.
- **Usage bars**: session (5 h) usage and weekly usage as percentages, each with a countdown to its reset. A white tick on each bar marks how far into the window you are.
- **Only shown while Claude is working**: the module fades in when any session goes `busy` and fades out `hideDelay` ms after the last one stops.

## How it works

The node helper reads local files only:

| Source | Used for |
|---|---|
| `~/.claude/sessions/<pid>.json` | Live sessions and their status (`busy` / `idle` / `waiting`). Files whose PID is gone are ignored. |
| `~/.claude/projects/<cwd>/<session>.jsonl` (last 256 KB) | Recent tool calls for the topology map |
| `~/.claude/projects/<cwd>/<session>/subagents/*.jsonl` | Active subagents |
| `~/.claude/.credentials.json` | OAuth token used to read `https://api.anthropic.com/api/oauth/usage`. Fetched at startup, then at most every `usageInterval` while Claude is working. |

MagicMirror has to run as the same user that runs Claude Code, because these files are mode `0600`.

## Install

```bash
cd ~/MagicMirror/modules
git clone https://github.com/PierreGode/MMM-terminalClaude.git
```

There are no npm dependencies. It needs Node 18+ for the built-in `fetch`.

## Config

```js
{
  module: "MMM-terminalClaude",
  position: "bottom_left",
  config: {
    hideDelay: 30000,
  }
},
```

| Option | Default | Description |
|---|---|---|
| `claudeDir` | `~/.claude` | Claude Code config directory |
| `pollInterval` | `2000` | How often sessions and transcripts are scanned (ms) |
| `usageInterval` | `180000` | Minimum time between usage API calls (ms) |
| `hideDelay` | `30000` | How long the module stays visible after work stops (ms) |
| `layout` | `"hybrid"` | `"hybrid"` (bus of sessions, star per busy session) or `"star"` |
| `alwaysShow` | `false` | Never hide the module (for layout testing) |
| `showIdleSessions` | `true` | Draw idle and waiting sessions as dim nodes |
| `maxActivity` | `7` | Activity nodes shown per busy session |
| `maxSubagents` | `4` | Subagent nodes shown per session |
| `subagentActiveMs` | `60000` | A subagent counts as active if its transcript changed within this window |
| `mapWidth` / `mapHeight` | `560` / `340` | Size of the topology SVG (px) |

Node colours: orange = write, blue = read, green = exec, purple = net/MCP, pink = agent.
