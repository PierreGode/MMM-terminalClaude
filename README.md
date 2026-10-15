# MMM-terminalClaude

A [MagicMirror²](https://magicmirror.builders) module that shows what Claude Code is doing on the box the mirror runs on.

- **Live topology map** (hybrid bus + star): the repo Claude is working in is the orange pill at the far left of a bus, with its name inside. Every folder touched branches off the bus, alternating above and below, as the hub of a star of the files touched in it. Shell commands, web lookups and subagents get their own hubs (`$ shell`, `web`, `agents`). Packets run along the bus to the folder being worked on, and the running action pulses. Only repos Claude is actively working in are shown. If it works across several repos, each gets its own bus. Set `layout: "star"` for the plain star layout with the host in the centre.
- **Usage bars**: session (5 h) usage and weekly usage as percentages, each with a countdown to its reset. A bar turns orange at 70% and red at 90%. A white tick on each bar marks how far into the window you are, so a fill past the tick means you are using it faster than an even pace.
- **Only shown while Claude is working**: the module fades in when any session goes `busy` and fades out `hideDelay` ms after the last one stops.

## How it works

The node helper reads local files only:

| Source | Used for |
|---|---|
| `~/.claude/sessions/<pid>.json` | Live sessions and their status (`busy` / `idle` / `waiting`). Files whose PID is gone are ignored. |
| `~/.claude/projects/<cwd>/<session>.jsonl` (last 256 KB) | Recent tool calls for the topology map |
| `.git` in the touched folders | The repo each action belongs to: the nearest enclosing git repo of the file, or of the directory a shell command `cd`s into. It doesn't depend on the folder the Claude session was started in. |
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
| `layout` | `"hybrid"` | `"hybrid"` (a bus per repo, with a star per folder touched) or `"star"` (host in the centre) |
| `alwaysShow` | `false` | Never hide the module (for layout testing) |
| `showIdleSessions` | `false` | Star layout only: also draw idle and waiting sessions as dim nodes |
| `maxActivity` | `14` | Recent distinct actions tracked per busy session |
| `maxRepos` | `3` | Hybrid layout: buses (repos) drawn at once |
| `maxGroups` | `6` | Hybrid layout: folder stars per bus |
| `maxLeaves` | `4` | Hybrid layout: files shown per folder star (the rest are counted as `+n`) |
| `maxSubagents` | `4` | Subagent nodes shown per session |
| `subagentActiveMs` | `60000` | A subagent counts as active if its transcript changed within this window |
| `mapWidth` / `mapHeight` | `560` / `340` | Size of the topology SVG (px) |
| `fadeSpeed` | `1000` | Fade in/out duration when the module shows or hides (ms) |

Node colours: orange = write, blue = read, green = exec, purple = net/MCP, pink = agent, grey = other. Subagents are drawn as diamonds. A bigger dot or `×n` means the same thing was touched several times.
