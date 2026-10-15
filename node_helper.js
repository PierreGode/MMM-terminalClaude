/* MMM-terminalClaude node_helper
 * Watches local Claude Code sessions (~/.claude/sessions) and their transcripts,
 * builds a live topology snapshot, and polls the plan usage endpoint.
 */
const NodeHelper = require("node_helper");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TAIL_BYTES = 256 * 1024;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

module.exports = NodeHelper.create({
	start () {
		this.config = null;
		this.timer = null;
		this.usage = null;
		this.usageFetchedAt = 0;
		this.usageError = null;
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "TC_CONFIG") return;
		this.config = payload;
		this.claudeDir = (payload.claudeDir || "~/.claude").replace(/^~/, os.homedir());
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(() => this.tick(), payload.pollInterval);
		this.tick();
	},

	async tick () {
		let sessions = [];
		try {
			sessions = this.readSessions();
		} catch (e) {
			console.error("[MMM-terminalClaude] session scan failed:", e.message);
		}
		const working = sessions.some((s) => s.status === "busy" || s.subagents.length > 0);

		// Usage: refresh while working (or once at startup), never faster than usageInterval
		const now = Date.now();
		if ((working || !this.usage) && now - this.usageFetchedAt > this.config.usageInterval) {
			this.usageFetchedAt = now;
			await this.fetchUsage();
		}

		this.sendSocketNotification("TC_DATA", {
			host: os.hostname(),
			working,
			sessions,
			usage: this.usage,
			usageError: this.usageError,
			ts: now
		});
	},

	/* ---------- sessions ---------- */

	readSessions () {
		const dir = path.join(this.claudeDir, "sessions");
		const out = [];
		this.repoCache = new Map();
		for (const f of fs.readdirSync(dir)) {
			if (!/^\d+\.json$/.test(f)) continue;
			let s;
			try {
				s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			} catch (e) {
				continue;
			}
			if (!s.pid || !fs.existsSync(`/proc/${s.pid}`)) continue; // stale file
			const transcriptDir = path.join(this.claudeDir, "projects", (s.cwd || "").replace(/[^A-Za-z0-9]/g, "-"));
			const transcript = path.join(transcriptDir, `${s.sessionId}.jsonl`);
			const busy = s.status === "busy";
			const sess = {
				id: s.sessionId,
				pid: s.pid,
				name: s.name || path.basename(s.cwd || "") || String(s.pid),
				cwd: s.cwd,
				project: path.basename(s.cwd || "") || "/",
				status: s.status || "unknown",
				waitingFor: s.waitingFor || null,
				statusSince: s.statusUpdatedAt || s.updatedAt || null,
				repo: null,
				repoName: null,
				activity: [],
				current: null,
				model: null,
				subagents: []
			};
			if (busy) {
				const t = this.parseTranscript(transcript, this.config.maxActivity, s.cwd);
				sess.activity = t.activity;
				sess.current = t.current;
				sess.model = t.model;
			}
			// Main repo: where the latest action happened, else the repo the session started in
			sess.repo = (sess.activity[0] && sess.activity[0].repo) || this.repoRootOf(s.cwd) || s.cwd;
			sess.repoName = this.repoName(sess.repo);
			sess.subagents = this.readSubagents(path.join(transcriptDir, s.sessionId, "subagents"), s.cwd);
			out.push(sess);
		}
		const order = { busy: 0, waiting: 1, idle: 2 };
		out.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.name.localeCompare(b.name));
		return out;
	},

	readSubagents (dir, cwd) {
		const out = [];
		let files;
		try {
			files = fs.readdirSync(dir);
		} catch (e) {
			return out;
		}
		const now = Date.now();
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const p = path.join(dir, f);
			let st;
			try {
				st = fs.statSync(p);
			} catch (e) {
				continue;
			}
			if (now - st.mtimeMs > this.config.subagentActiveMs) continue;
			let meta = {};
			try {
				meta = JSON.parse(fs.readFileSync(p.replace(/\.jsonl$/, ".meta.json"), "utf8"));
			} catch (e) { /* no meta */ }
			const t = this.parseTranscript(p, 1, cwd);
			out.push({
				id: f.replace(/\.jsonl$/, ""),
				type: meta.agentType || "agent",
				description: meta.description || "",
				current: t.current || t.activity[0] || null
			});
		}
		return out.slice(0, this.config.maxSubagents);
	},

	tailLines (file) {
		let fd;
		try {
			fd = fs.openSync(file, "r");
			const size = fs.fstatSync(fd).size;
			const start = Math.max(0, size - TAIL_BYTES);
			const buf = Buffer.alloc(size - start);
			fs.readSync(fd, buf, 0, buf.length, start);
			const lines = buf.toString("utf8").split("\n");
			if (start > 0) lines.shift(); // partial first line
			return lines;
		} catch (e) {
			return [];
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	},

	// Nearest enclosing git repo of a directory (.git folder or file), or null
	repoRootOf (dir) {
		if (!dir) return null;
		if (this.repoCache.has(dir)) return this.repoCache.get(dir);
		let root = null;
		for (let d = dir; ; d = path.dirname(d)) {
			if (fs.existsSync(path.join(d, ".git"))) {
				root = d;
				break;
			}
			if (path.dirname(d) === d) break;
		}
		this.repoCache.set(dir, root);
		return root;
	},

	repoName (root) {
		if (!root) return "?";
		return root === os.homedir() ? "~" : path.basename(root) || root;
	},

	// Folder of a location relative to its repo ("." = repo root); "~/…" when it is outside any repo
	folderIn (dir, root) {
		if (!root) return dir.replace(os.homedir(), "~");
		return path.relative(root, dir) || ".";
	},

	// Directory a shell command switches to when it starts with "cd <dir> &&" / "cd <dir>;"
	leadingCd (command, base) {
		const m = /^\s*(?:[A-Za-z_]\w*=(?!\$\()\S*\s*;?\s*)*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/.exec(command);
		if (!m) return null;
		const dir = m[1].replace(/^["']|["']$/g, "");
		if (dir.includes("$")) return null;
		return path.resolve(base, dir.replace(/^~(?=$|\/)/, os.homedir()));
	},

	describeTool (name, input = {}) {
		const base = (p) => path.basename(String(p));
		let target = "";
		if (input.file_path || input.notebook_path) target = base(input.file_path || input.notebook_path);
		else if (input.description && name === "Bash") target = String(input.description);
		else if (input.command) {
			// Drop leading "VAR=x;" / "cd dir &&" noise so the real command shows
			target = String(input.command).replace(/\s+/g, " ").trim()
				.replace(/^(?:(?:[A-Za-z_]\w*=(?!\$\()\S*\s*;?\s*)|(?:cd\s+\S+\s*(?:&&|;)\s*))+/, "");
		}
		else if (input.pattern) target = String(input.pattern);
		else if (input.url) {
			try {
				target = new URL(input.url).host;
			} catch (e) {
				target = String(input.url);
			}
		} else if (input.query) target = String(input.query);
		else if (input.description) target = String(input.description);
		else if (input.skill) target = String(input.skill);
		else if (input.path) target = base(input.path);
		const kind = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) ? "write"
			: /^(Read|Grep|Glob|LSP)$/.test(name) ? "read"
				: name === "Bash" ? "exec"
					: /^(WebFetch|WebSearch)$/.test(name) || name.startsWith("mcp__") ? "net"
						: /^(Agent|Task)$/.test(name) ? "agent" : "other";
		const short = name.startsWith("mcp__") ? name.split("__").slice(-1)[0] : name;
		return { tool: short, kind, target: target.slice(0, 60) };
	},

	/* Work out which repo, and which folder inside it, an action belongs to.
	 * Files resolve to their nearest git repo. Shell commands use the directory of a
	 * leading "cd", or the shell's tracked directory (it persists between commands).
	 * Anything without a repo of its own lands on the repo worked in most recently. */
	locate (name, input, st) {
		const d = this.describeTool(name, input);
		let loc = null;
		let folderAt = null;
		const file = input.file_path || input.notebook_path;
		if (file) {
			loc = path.dirname(String(file));
			folderAt = loc;
		} else if (input.path && d.kind === "read") {
			loc = path.resolve(st.shellDir, String(input.path));
			try {
				if (fs.statSync(loc).isFile()) loc = path.dirname(loc);
			} catch (e) { /* gone or unreadable: treat as a folder */ }
			folderAt = loc;
		} else if (d.kind === "exec" && input.command) {
			const cd = this.leadingCd(String(input.command), st.shellDir);
			loc = cd || st.shellDir;
			// The shell keeps its directory between commands, but Claude Code resets it
			// to the project dir when a command leaves the project
			if (cd) st.shellDir = !st.cwd || !path.relative(st.cwd, cd).startsWith("..") ? cd : st.cwd;
		}
		const own = this.repoRootOf(loc);
		if (own) st.lastRepo = own;
		const repo = own || st.lastRepo || st.cwd || "";
		const group = folderAt ? this.folderIn(folderAt, own)
			: d.kind === "exec" ? "$ shell"
				: d.kind === "net" ? "web"
					: d.kind === "agent" ? "agents" : d.tool;
		return { ...d, repo, repoName: this.repoName(repo), group };
	},

	parseTranscript (file, max, cwd = null) {
		const uses = [];
		const done = new Set();
		let model = null;
		const st = { cwd, shellDir: cwd || os.homedir(), lastRepo: this.repoRootOf(cwd) };
		for (const line of this.tailLines(file)) {
			if (!line) continue;
			let e;
			try {
				e = JSON.parse(line);
			} catch (err) {
				continue;
			}
			const msg = e.message;
			if (!msg || !Array.isArray(msg.content)) continue;
			if (msg.role === "assistant") {
				if (msg.model) model = msg.model;
				for (const c of msg.content) {
					if (c.type === "tool_use") {
						uses.push({ id: c.id, ts: Date.parse(e.timestamp) || 0, ...this.locate(c.name, c.input || {}, st) });
					}
				}
			} else if (msg.role === "user") {
				for (const c of msg.content) if (c.type === "tool_result") done.add(c.tool_use_id);
			}
		}
		const last = uses[uses.length - 1];
		const current = last && !done.has(last.id) ? { ...last, running: true } : null;
		// newest first, merge repeats of the same target in the same place
		const activity = [];
		const seen = new Map();
		for (let i = uses.length - 1; i >= 0 && activity.length < max; i--) {
			const u = uses[i];
			const key = `${u.repo}|${u.group}|${u.kind}:${u.target || u.tool}`;
			if (seen.has(key)) {
				seen.get(key).count++;
				continue;
			}
			const item = { tool: u.tool, kind: u.kind, target: u.target, repo: u.repo, repoName: u.repoName, group: u.group, ts: u.ts, count: 1, running: !!(current && current.id === u.id) };
			seen.set(key, item);
			activity.push(item);
		}
		return { activity, current, model };
	},

	/* ---------- usage ---------- */

	async fetchUsage () {
		try {
			const creds = JSON.parse(fs.readFileSync(path.join(this.claudeDir, ".credentials.json"), "utf8"));
			const oauth = creds.claudeAiOauth;
			if (!oauth || !oauth.accessToken) throw new Error("no OAuth token");
			if (oauth.expiresAt && oauth.expiresAt < Date.now()) throw new Error("token expired (run claude to refresh)");
			const res = await fetch(USAGE_URL, {
				headers: {
					Authorization: `Bearer ${oauth.accessToken}`,
					"anthropic-beta": "oauth-2025-04-20",
					"User-Agent": "MMM-terminalClaude"
				},
				signal: AbortSignal.timeout(10000)
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const d = await res.json();
			const pick = (w) => (w ? { pct: w.utilization, resetsAt: w.resets_at } : null);
			this.usage = {
				session: pick(d.five_hour),
				weekly: pick(d.seven_day),
				fetchedAt: Date.now()
			};
			this.usageError = null;
		} catch (e) {
			this.usageError = e.message;
			console.error("[MMM-terminalClaude] usage fetch failed:", e.message);
		}
	}
});
