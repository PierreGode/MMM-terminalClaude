/* MMM-terminalClaude
 * Live topology of what Claude Code is doing on this box + plan usage bars.
 * The module is only shown while a Claude session is working.
 */
Module.register("MMM-terminalClaude", {
	defaults: {
		claudeDir: "~/.claude",
		pollInterval: 2000, // session/transcript scan (ms)
		usageInterval: 3 * 60 * 1000, // usage endpoint poll while working (ms)
		hideDelay: 30 * 1000, // keep visible this long after work stops (ms)
		alwaysShow: false, // debug: never hide
		showIdleSessions: false, // star layout: also draw idle/waiting sessions as dim nodes
		maxActivity: 14, // recent distinct actions per busy session
		maxRepos: 3, // hybrid: buses (repos) drawn at once
		maxGroups: 6, // hybrid: folder stars per bus
		maxLeaves: 4, // hybrid: files per folder star
		maxSubagents: 4,
		subagentActiveMs: 60 * 1000,
		layout: "hybrid", // "hybrid" (repo bus with a star per folder) or "star"
		mapWidth: 560,
		mapHeight: 340,
		fadeSpeed: 1000
	},

	KIND_COLORS: {
		write: "#ffb04a",
		read: "#5aa9ff",
		exec: "#5be37d",
		net: "#c58bff",
		agent: "#ff6fae",
		other: "#9aa4b2"
	},

	start () {
		this.tc = null;
		this.lastWorking = 0;
		this.mapSig = "";
		this.built = false;
		this.sendSocketNotification("TC_CONFIG", this.config);
		setInterval(() => {
			this.updateUsage();
			this.updateVisibility();
		}, 1000);
	},

	getStyles () {
		return ["MMM-terminalClaude.css"];
	},

	notificationReceived (notification) {
		if (notification === "MODULE_DOM_CREATED" && !this.config.alwaysShow) {
			this.hide(0, { lockString: this.identifier });
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "TC_DATA") return;
		this.tc = payload;
		if (payload.working) this.lastWorking = Date.now();
		this.updateMap();
		this.updateNow();
		this.updateUsage();
		this.updateVisibility();
	},

	updateVisibility () {
		const visible = this.config.alwaysShow || Date.now() - this.lastWorking < this.config.hideDelay;
		if (visible && this.hidden) this.show(this.config.fadeSpeed, { lockString: this.identifier });
		else if (!visible && !this.hidden) this.hide(this.config.fadeSpeed, { lockString: this.identifier });
	},

	/* ---------- DOM ---------- */

	getDom () {
		const w = document.createElement("div");
		w.className = "tc-wrap";
		w.innerHTML = `
			<div class="tc-left">
				<div class="tc-map"></div>
				<div class="tc-now"></div>
			</div>
			<div class="tc-usage"></div>`;
		this.el = {
			map: w.querySelector(".tc-map"),
			now: w.querySelector(".tc-now"),
			usage: w.querySelector(".tc-usage")
		};
		this.mapSig = "";
		this.updateMap();
		this.updateNow();
		this.updateUsage();
		return w;
	},

	esc (s) {
		return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
	},

	trunc (s, n) {
		s = String(s ?? "");
		return s.length > n ? `${s.slice(0, n - 1)}…` : s;
	},

	/* ---------- topology map ---------- */

	updateMap () {
		if (!this.el || !this.tc) return;
		const sessions = this.tc.sessions.filter((s) => this.config.showIdleSessions || s.status === "busy" || s.subagents.length);
		// Only rebuild the SVG when the structure changes, so CSS animations don't restart
		const sig = JSON.stringify(sessions.map((s) => [s.id, s.status, s.activity.map((a) => [a.repo, a.group, a.kind, a.target, a.tool, a.running, a.count]), s.subagents.map((a) => [a.id, a.current && a.current.target])]));
		if (sig === this.mapSig) return;
		this.mapSig = sig;
		this.el.map.innerHTML = this.config.layout === "star" ? this.renderStar(sessions) : this.renderHybrid(sessions);
	},

	isBusy (s) {
		return s.status === "busy" || s.subagents.length > 0;
	},

	children (s) {
		return [
			...s.activity.map((a) => ({ ...a, sub: false })),
			...s.subagents.map((a) => ({ sub: true, kind: "agent", tool: a.type, target: a.description || (a.current && a.current.target), running: true, repo: s.repo, repoName: s.repoName, group: "agents" }))
		];
	},

	// One activity/subagent node at (kx, ky), wired to its hub at (hx, hy); ka = angle from hub (label side)
	kidNode (k, j, kx, ky, ka, hx, hy, edges, nodes) {
		const col = this.KIND_COLORS[k.kind] || this.KIND_COLORS.other;
		const op = k.running ? 1 : Math.max(0.35, 1 - j * 0.1);
		edges.push(`<line class="tc-edge ${k.running ? "tc-flow" : ""}" style="stroke:${col};opacity:${op * 0.7}" x1="${hx}" y1="${hy}" x2="${kx}" y2="${ky}"/>`);
		const anchor = Math.cos(ka) > 0.25 ? "start" : Math.cos(ka) < -0.25 ? "end" : "middle";
		const dx = anchor === "start" ? 9 : anchor === "end" ? -9 : 0;
		const dy = anchor === "middle" ? (Math.sin(ka) > 0 ? 18 : -10) : 4;
		const shape = k.sub
			? `<rect x="${kx - 5}" y="${ky - 5}" width="10" height="10" transform="rotate(45 ${kx} ${ky})" style="fill:${col}"/>`
			: `<circle cx="${kx}" cy="${ky}" r="${4 + Math.min(k.count || 1, 4)}" style="fill:${col}"/>`;
		const label = `${k.tool}${k.target ? ` · ${this.trunc(k.target, 18)}` : ""}${k.count > 1 ? ` ×${k.count}` : ""}`;
		nodes.push(`<g class="tc-kid ${k.running ? "tc-running" : ""}" style="opacity:${op}">${k.running ? `<circle class="tc-ping" cx="${kx}" cy="${ky}" r="8" style="stroke:${col}"/>` : ""}${shape}<text x="${kx + dx}" y="${ky + dy}" text-anchor="${anchor}">${this.esc(label)}</text></g>`);
	},

	textWidth (text, font) {
		this.measureCtx = this.measureCtx || document.createElement("canvas").getContext("2d");
		this.measureCtx.font = font;
		return this.measureCtx.measureText(text).width;
	},

	/* Hybrid: one bus per repo being worked on. The repo is the orange pill at the far
	 * left; every folder touched taps off the bus (alternating above/below) and is the hub
	 * of a star of the files touched in it. Commands, web lookups and subagents get their
	 * own pseudo-folders. */
	renderHybrid (sessions) {
		const W = this.config.mapWidth;
		const H = this.config.mapHeight;
		const edges = [];
		const nodes = [];
		const anim = [];

		// Gather activity per repo across all busy sessions, most recently worked-on repo first
		const repos = [];
		const byRepo = new Map();
		for (const s of sessions.filter((x) => this.isBusy(x))) {
			for (const k of this.children(s)) {
				const key = k.repo || s.repo;
				if (!byRepo.has(key)) {
					const r = { name: k.repoName || s.repoName, kids: [] };
					byRepo.set(key, r);
					repos.push(r);
				}
				byRepo.get(key).kids.push(k);
			}
		}
		const rows = repos.slice(0, this.config.maxRepos);
		const rowH = H / Math.max(1, rows.length);

		rows.forEach((r, row) => {
			const busY = rowH * row + rowH / 2;
			const name = this.trunc(r.name, 22);
			const pillW = Math.ceil(this.textWidth(name, "bold 12px 'Roboto Condensed', sans-serif")) + 22;
			const pillX = 2;
			const busX = pillX + pillW;
			const busEnd = W - 8;
			const live = r.kids.some((k) => k.running);
			edges.push(`<line class="tc-bus" x1="${busX}" y1="${busY}" x2="${busEnd}" y2="${busY}"/>`);
			edges.push(`<line class="tc-bus" x1="${busEnd}" y1="${busY - 6}" x2="${busEnd}" y2="${busY + 6}"/>`);
			nodes.push(`<g class="tc-repo${live ? " tc-repo-live" : ""}"><rect x="${pillX}" y="${busY - 13}" width="${pillW}" height="26" rx="13"/><text x="${pillX + pillW / 2}" y="${busY + 4}" text-anchor="middle">${this.esc(name)}</text></g>`);

			// Group by folder, most recently touched first
			const groups = [];
			const byName = new Map();
			for (const k of r.kids) {
				const gname = k.group || k.tool;
				if (!byName.has(gname)) {
					const g = { name: gname, kids: [] };
					byName.set(gname, g);
					groups.push(g);
				}
				byName.get(gname).kids.push(k);
			}
			const G = Math.min(groups.length, this.config.maxGroups);
			const tap = Math.min(rowH * 0.17, 48);
			const leafR = Math.max(26, Math.min(rowH / 2 - tap - 24, 58));
			const gx0 = busX + 40;
			const gw = (busEnd - 40 - gx0) / Math.max(1, G);

			groups.slice(0, G).forEach((g, gi) => {
				const up = gi % 2 === 0;
				const sign = up ? -1 : 1;
				const hx = gx0 + gw * (gi + 0.5);
				const hy = busY + sign * tap;
				const running = g.kids.some((k) => k.running);
				const col = this.KIND_COLORS[g.kids[0].kind] || this.KIND_COLORS.other;
				edges.push(`<line class="tc-edge${running ? " tc-flow" : ""}" style="stroke:${col}" x1="${hx}" y1="${busY}" x2="${hx}" y2="${hy}"/>`);
				if (running) anim.push(`<circle class="tc-packet" r="3"><animateMotion dur="1.8s" repeatCount="indefinite" path="M${busX},${busY} H${hx} V${hy}"/></circle>`);

				const leaves = g.kids.slice(0, this.config.maxLeaves);
				const extra = g.kids.length - leaves.length;
				const spread = Math.min(Math.PI * 0.8, (Math.PI / 4) * (leaves.length - 1));
				leaves.forEach((k, li) => {
					const t = leaves.length === 1 ? 0 : li / (leaves.length - 1) - 0.5;
					const ka = sign * Math.PI / 2 + spread * t;
					const lx = hx + Math.cos(ka) * leafR;
					const ly = hy + Math.sin(ka) * leafR;
					const lc = this.KIND_COLORS[k.kind] || this.KIND_COLORS.other;
					const op = k.running ? 1 : Math.max(0.45, 1 - gi * 0.12);
					const anchor = Math.cos(ka) > 0.3 ? "start" : Math.cos(ka) < -0.3 ? "end" : "middle";
					const dx = anchor === "start" ? 8 : anchor === "end" ? -8 : 0;
					const dy = anchor === "middle" ? (up ? -10 : 18) : 4;
					const label = `${this.trunc(k.target || k.tool, 16)}${k.count > 1 ? ` ×${k.count}` : ""}`;
					edges.push(`<line class="tc-edge${k.running ? " tc-flow" : ""}" style="stroke:${lc};opacity:${op * 0.7}" x1="${hx}" y1="${hy}" x2="${lx}" y2="${ly}"/>`);
					const shape = k.sub
						? `<rect x="${lx - 5}" y="${ly - 5}" width="10" height="10" transform="rotate(45 ${lx} ${ly})" style="fill:${lc}"/>`
						: `<circle cx="${lx}" cy="${ly}" r="${3 + Math.min(k.count || 1, 3)}" style="fill:${lc}"/>`;
					nodes.push(`<g class="tc-kid${k.running ? " tc-running" : ""}" style="opacity:${op}">${k.running ? `<circle class="tc-ping" cx="${lx}" cy="${ly}" r="7" style="stroke:${lc}"/>` : ""}${shape}<text x="${lx + dx}" y="${ly + dy}" text-anchor="${anchor}">${this.esc(label)}</text></g>`);
				});

				const folder = g.name === "." ? "./" : g.name.split("/").filter(Boolean).slice(-1)[0] || g.name;
				nodes.push(`<g class="tc-hub${running ? " tc-hub-live" : ""}"><rect x="${hx - 6}" y="${hy - 6}" width="12" height="12" rx="2" style="stroke:${col}"/><text x="${hx + 9}" y="${(busY + hy) / 2 + 4}" text-anchor="start">${this.esc(this.trunc(folder, 18))}${extra > 0 ? ` +${extra}` : ""}</text></g>`);
			});
		});

		return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${edges.join("")}${anim.join("")}${nodes.join("")}</svg>`;
	},

	/* Star: host in the centre, sessions on an inner ring, activity on an outer ring. */
	renderStar (sessions) {
		const W = this.config.mapWidth;
		const H = this.config.mapHeight;
		const cx = W / 2;
		const cy = H / 2;
		// Elliptical rings; keep room at the sides for outer labels
		const LABEL = 140;
		const R2x = Math.max(60, W / 2 - LABEL);
		const R2y = H / 2 - 22;
		const R1x = R2x * 0.55;
		const R1y = R2y * 0.55;
		const edges = [];
		const nodes = [];

		nodes.push(`<g class="tc-host"><circle cx="${cx}" cy="${cy}" r="15"/><text x="${cx}" y="${cy + 30}" text-anchor="middle">${this.esc(this.tc.host)}</text></g>`);

		const children = (s) => this.children(s);
		const weights = sessions.map((s) => 1 + children(s).length * 0.6);
		const total = weights.reduce((a, b) => a + b, 0) || 1;
		let ang = -Math.PI / 2 - ((weights[0] || 0) / total) * Math.PI;

		sessions.forEach((s, i) => {
			const span = (weights[i] / total) * Math.PI * 2;
			const a = ang + span / 2;
			ang += span;
			const sx = cx + Math.cos(a) * R1x;
			const sy = cy + Math.sin(a) * R1y;
			const busy = this.isBusy(s);
			edges.push(`<line class="tc-edge ${busy ? "tc-flow" : ""}" x1="${cx}" y1="${cy}" x2="${sx}" y2="${sy}"/>`);

			const kids = busy ? children(s) : [];
			const kSpan = Math.min(span * 0.9, Math.PI * 0.9);
			kids.forEach((k, j) => {
				const ka = kids.length === 1 ? a : a - kSpan / 2 + (kSpan * j) / (kids.length - 1);
				const kr = j % 2 ? 0.92 : 1;
				this.kidNode(k, j, cx + Math.cos(ka) * R2x * kr, cy + Math.sin(ka) * R2y * kr, ka, sx, sy, edges, nodes);
			});

			const anchor = kids.length ? "middle" : Math.cos(a) > 0.25 ? "start" : Math.cos(a) < -0.25 ? "end" : "middle";
			const tx = sx + (anchor === "start" ? 12 : anchor === "end" ? -12 : 0);
			const ty = anchor === "middle" ? sy - 13 : sy + 4;
			nodes.push(`<g class="tc-sess tc-${this.esc(s.status)}${busy ? " tc-busy" : ""}"><circle cx="${sx}" cy="${sy}" r="${busy ? 9 : 6}"/><text x="${tx}" y="${ty}" text-anchor="${anchor}">${this.esc(this.trunc(s.repoName || s.project, 18))}</text></g>`);
		});

		return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${edges.join("")}${nodes.join("")}</svg>`;
	},

	updateNow () {
		if (!this.el || !this.tc) return;
		const busy = this.tc.sessions.filter((s) => s.status === "busy" || s.subagents.length);
		this.el.now.innerHTML = busy.map((s) => {
			const c = s.current || s.activity[0];
			const what = c ? `<span style="color:${this.KIND_COLORS[c.kind]}">${this.esc(c.tool)}</span> ${this.esc(this.trunc(c.target, 46))}` : "thinking…";
			const subs = s.subagents.length ? ` <span class="tc-dim">+${s.subagents.length} agent${s.subagents.length > 1 ? "s" : ""}</span>` : "";
			const repo = (c && c.repoName) || s.repoName || s.name;
			return `<div class="tc-now-row"><span class="tc-dot"></span><b>${this.esc(repo)}</b> ${what}${subs}</div>`;
		}).join("");
	},

	/* ---------- usage bars ---------- */

	fmtLeft (iso) {
		if (!iso) return "–";
		let s = Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));
		const d = Math.floor(s / 86400);
		s %= 86400;
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		if (d) return `${d}d ${h}h`;
		if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
		return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	},

	bar (label, w, windowMs) {
		if (!w) return `<div class="tc-bar"><div class="tc-bar-head"><span>${label}</span><span>–</span></div><div class="tc-track"></div></div>`;
		const pct = Math.max(0, Math.min(100, w.pct || 0));
		const lvl = pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok";
		const left = Math.max(0, Date.parse(w.resetsAt) - Date.now());
		const timePct = windowMs ? Math.max(0, Math.min(100, 100 - (left / windowMs) * 100)) : 0;
		return `<div class="tc-bar tc-${lvl}">
			<div class="tc-bar-head"><span>${label}</span><span class="tc-pct">${Math.round(pct)}%</span></div>
			<div class="tc-track"><div class="tc-fill" style="width:${pct}%"></div><div class="tc-timemark" style="left:${timePct}%"></div></div>
			<div class="tc-reset">resets in <b>${this.fmtLeft(w.resetsAt)}</b></div>
		</div>`;
	},

	updateUsage () {
		if (!this.el || !this.tc) return;
		const u = this.tc.usage;
		this.el.usage.innerHTML = `
			<div class="tc-title">Claude usage</div>
			${this.bar("Session", u && u.session, 5 * 3600e3)}
			${this.bar("Weekly", u && u.weekly, 7 * 86400e3)}
			${this.tc.usageError ? `<div class="tc-err">${this.esc(this.tc.usageError)}</div>` : ""}
			<div class="tc-legend">${Object.entries(this.KIND_COLORS).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join("")}</div>`;
	}
});
