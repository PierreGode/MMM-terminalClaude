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
		showIdleSessions: true, // draw idle/waiting sessions as dim nodes
		maxActivity: 7, // activity nodes per busy session
		maxSubagents: 4,
		subagentActiveMs: 60 * 1000,
		layout: "hybrid", // "hybrid" (bus of sessions, star per busy session) or "star"
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
		const sig = JSON.stringify(sessions.map((s) => [s.id, s.status, s.activity.map((a) => [a.kind, a.target, a.tool, a.running, a.count]), s.subagents.map((a) => [a.id, a.current && a.current.target])]));
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
			...s.subagents.map((a) => ({ sub: true, kind: "agent", tool: a.type, target: a.description || (a.current && a.current.target), running: true }))
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

	/* Hybrid: a horizontal bus links every session. Each busy repo sits on the bus as
	 * the centre of its own star of activity; idle repos tap off the bus at the sides. */
	renderHybrid (sessions) {
		const W = this.config.mapWidth;
		const H = this.config.mapHeight;
		const busY = H / 2;
		const bx0 = 8;
		const bx1 = W - 8;
		const edges = [];
		const nodes = [];
		const anim = [];

		// Busy repos in the middle, idle ones split to either side
		const busy = sessions.filter((s) => this.isBusy(s));
		const idle = sessions.filter((s) => !this.isBusy(s));
		const half = Math.ceil(idle.length / 2);
		const order = [...idle.slice(0, half), ...busy, ...idle.slice(half)];

		edges.push(`<line class="tc-bus" x1="${bx0}" y1="${busY}" x2="${bx1}" y2="${busY}"/>`);
		for (const ex of [bx0, bx1]) edges.push(`<line class="tc-bus" x1="${ex}" y1="${busY - 6}" x2="${ex}" y2="${busY + 6}"/>`);
		nodes.push(`<text class="tc-hostlabel" x="${bx0}" y="${busY + 20}" text-anchor="start">${this.esc(this.tc.host)}</text>`);

		const weights = order.map((s) => (this.isBusy(s) ? 4 + this.children(s).length * 0.4 : 1));
		const total = weights.reduce((acc, w) => acc + w, 0) || 1;
		let x = bx0 + 10;
		let idleIdx = 0;
		order.forEach((s, i) => {
			const slotW = ((bx1 - bx0 - 20) * weights[i]) / total;
			const tx = x + slotW / 2;
			x += slotW;
			const cls = `tc-sess tc-${this.esc(s.status)}`;

			if (!this.isBusy(s)) {
				// alternate above/below the bus so neighbouring labels don't collide
				const up = idleIdx++ % 2 === 0;
				const ty = busY + (up ? -24 : 24);
				edges.push(`<line class="tc-edge" x1="${tx}" y1="${busY}" x2="${tx}" y2="${ty}"/>`);
				nodes.push(`<g class="${cls}"><circle cx="${tx}" cy="${ty}" r="5"/><text x="${tx}" y="${up ? ty - 10 : ty + 18}" text-anchor="middle">${this.esc(this.trunc(s.project, 16))}</text></g>`);
				return;
			}

			anim.push(`<circle class="tc-packet" r="3"><animateMotion dur="2s" repeatCount="indefinite" path="M${bx0},${busY} H${tx}"/></circle>`);
			anim.push(`<circle class="tc-packet" r="3"><animateMotion dur="2s" repeatCount="indefinite" path="M${bx1},${busY} H${tx}"/></circle>`);
			// activity alternates between the arc above and the arc below the bus
			const kids = this.children(s);
			const rx = Math.max(50, Math.min(slotW / 2 - 50, 170));
			const ry = busY - 26;
			const upper = kids.filter((k, j) => j % 2 === 0);
			const lower = kids.filter((k, j) => j % 2 === 1);
			const place = (list, sign) => list.forEach((k, n) => {
				const t = list.length === 1 ? 0.5 : n / (list.length - 1);
				const ka = sign * (0.18 + 0.64 * t) * Math.PI;
				const kr = n % 2 ? 0.8 : 1;
				this.kidNode(k, kids.indexOf(k), tx + Math.cos(ka) * rx * kr, busY + Math.sin(ka) * ry * kr, ka, tx, busY, edges, nodes);
			});
			place(upper, -1);
			place(lower, 1);
			nodes.push(`<g class="${cls} tc-busy tc-center"><circle cx="${tx}" cy="${busY}" r="15"/><text x="${tx}" y="${busY + 4}" text-anchor="middle">${this.esc(this.trunc(s.project, 18))}</text></g>`);
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
			nodes.push(`<g class="tc-sess tc-${this.esc(s.status)}${busy ? " tc-busy" : ""}"><circle cx="${sx}" cy="${sy}" r="${busy ? 9 : 6}"/><text x="${tx}" y="${ty}" text-anchor="${anchor}">${this.esc(this.trunc(s.project, 18))}</text></g>`);
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
			return `<div class="tc-now-row"><span class="tc-dot"></span><b>${this.esc(s.name)}</b> ${what}${subs}</div>`;
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
