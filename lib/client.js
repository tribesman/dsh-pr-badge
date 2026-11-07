/**
 * @dsh-plugins/pr-badge — browser half.
 *
 * Hand-written lazy-CJS bundle in the DSH client-module factory form: running
 * this script only REGISTERS the factory; everything below runs at
 * materialization. Only the shell-seeded baseline (`react`) is required.
 *
 * The badge mounts into the stock `sidebar.session.row.trailing` seat, the same
 * strip the shell uses for its own row icons, so it sits after the Session
 * title instead of competing with it. Every row shares one module-level state
 * snapshot: the host route is polled once per interval for all Sessions, which
 * keeps a long sidebar at a single request instead of one per row.
 */

window.__ModuleLoader__.load({
	id: "@dsh-plugins/pr-badge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		/** Locale namespace owned by this plugin. */
		const NS = "pr-badge";
		/** Host route registered by this package's server half. */
		const STATES_URL = "/pr-badge/api/states";
		/** How often the snapshot is refreshed while the page is visible. */
		const POLL_MS = 45_000;
		/** A snapshot older than this is refreshed as soon as a row mounts. */
		const STALE_MS = 40_000;

		//#region styles
		const CSS_ID = "dsh-plugin-pr-badge";
		const CSS =
			"span.dsh-pr-badge{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;" +
			"height:16px;min-width:16px;padding:0 5px;border-radius:999px;flex:none;" +
			"font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10px;font-weight:600;line-height:1;" +
			"text-decoration:none;white-space:nowrap;border:.5px solid transparent}" +
			"span.dsh-pr-badge[data-state=OPEN]{color:#1a7f37;background:#dafbe1;border-color:#aceebb}" +
			"span.dsh-pr-badge[data-state=DRAFT]{color:#59636e;background:#eff2f5;border-color:#d1d9e0}" +
			"span.dsh-pr-badge[data-state=MERGED]{color:#8250df;background:#fbefff;border-color:#ecd8ff}" +
			"span.dsh-pr-badge[data-state=CLOSED]{color:#cf222e;background:#ffebe9;border-color:#ffcecb}" +
			"body[data-ds-dark-theme] span.dsh-pr-badge[data-state=OPEN]{color:#3fb950;background:#12261e;border-color:#1f4429}" +
			"body[data-ds-dark-theme] span.dsh-pr-badge[data-state=DRAFT]{color:#9198a1;background:#21262d;border-color:#3d444d}" +
			"body[data-ds-dark-theme] span.dsh-pr-badge[data-state=MERGED]{color:#ab7df8;background:#251b3a;border-color:#3c2a5e}" +
			"body[data-ds-dark-theme] span.dsh-pr-badge[data-state=CLOSED]{color:#f85149;background:#2d1214;border-color:#5b1f1f}";

		/** Inject the stylesheet once per document, tagged so the shell can drop it. */
		function installStyles() {
			try {
				if (typeof document === "undefined") return;
				if (document.head.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return;
				const style = document.createElement("style");
				style.dataset.pluginCss = CSS_ID;
				style.textContent = CSS;
				document.head.appendChild(style);
			} catch {
				/* Without styles the badge still shows its number and tooltip. */
			}
		}
		//#endregion

		//#region snapshot store
		/** Latest `{ sessionId: { branch, pr } }` snapshot shared by every row. */
		let snapshot = {};
		/** When the snapshot was taken, in epoch milliseconds. */
		let takenAt = 0;
		/** In-flight request, so concurrent rows share one fetch. */
		let inflight = null;
		/** Rows currently mounted, notified after each successful refresh. */
		const listeners = new Set();

		/** Notify every mounted row about a new snapshot. */
		function publish() {
			for (const listener of listeners) {
				try {
					listener();
				} catch {
					/* One broken row must not starve the others. */
				}
			}
		}

		/** Fetch one snapshot, unless a request is already in flight. */
		function refresh() {
			if (inflight !== null) return inflight;
			inflight = (async () => {
				try {
					const response = await fetch(STATES_URL, {
						credentials: "same-origin",
						cache: "no-store",
						headers: { accept: "application/json" }
					});
					if (!response.ok) return;
					const body = await response.json();
					const states = body?.states;
					if (states === null || typeof states !== "object") return;
					snapshot = states;
					takenAt = Date.now();
					publish();
				} catch {
					/* Keep the previous snapshot; the next tick retries. */
				} finally {
					inflight = null;
				}
			})();
			return inflight;
		}

		/** Poll while at least one row is mounted and the tab is visible. */
		const timer = setInterval(() => {
			if (listeners.size === 0) return;
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
			void refresh();
		}, POLL_MS);
		if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") timer.unref();

		/**
		 * Read one Session's entry from the shared snapshot.
		 * @param sessionId - Session the row draws.
		 * @returns `{ branch, pr }` or undefined when the Session is not listed.
		 */
		function entryOf(sessionId) {
			const entry = snapshot[sessionId];
			return entry !== null && typeof entry === "object" ? entry : undefined;
		}

		/**
		 * Subscribe one row to the shared snapshot.
		 * @param sessionId - Session the row draws.
		 * @returns the current entry, refreshed on every publish.
		 */
		function useEntry(sessionId) {
			const [entry, setEntry] = react.useState(() => entryOf(sessionId));
			react.useEffect(() => {
				const listener = () => setEntry(entryOf(sessionId));
				listeners.add(listener);
				listener();
				if (Date.now() - takenAt > STALE_MS) void refresh();
				return () => {
					listeners.delete(listener);
				};
			}, [sessionId]);
			return entry;
		}
		//#endregion

		/**
		 * The visible state word for a pull request.
		 * @param pr - reported pull request.
		 * @returns a locale key suffix.
		 */
		function stateKey(pr) {
			if (pr.draft && pr.state === "OPEN") return "draft";
			return pr.state.toLowerCase();
		}

		/**
		 * One pull-request badge for a Session row.
		 *
		 * The seat is documented as non-interactive: it sits inside the row's own
		 * button, so the badge is an `img`-role glyph rather than a link. The full
		 * title travels in the tooltip and the accessible name.
		 *
		 * @param props - slot props: the row's Session and the seat translator.
		 * @returns the badge, or null when the branch has no pull request.
		 */
		function PrBadge(props) {
			const entry = useEntry(props?.sessionId);
			const pr = entry?.pr;
			if (pr === undefined || pr === null) return null;
			installStyles();
			const t = typeof props?.t === "function" ? props.t : undefined;
			const state = pr.draft && pr.state === "OPEN" ? "DRAFT" : pr.state;
			let stateWord = state;
			if (t !== undefined) {
				try {
					const key = `state.${stateKey(pr)}`;
					const translated = t(key);
					if (typeof translated === "string" && translated !== "" && translated !== key) stateWord = translated;
				} catch {
					/* Fall back to the English state word. */
				}
			}
			const label = `PR #${pr.number} · ${stateWord}${pr.title === "" ? "" : ` · ${pr.title}`}`;
			return react.createElement("span", {
				className: "dsh-pr-badge",
				"data-state": state,
				"data-dsh-pr-badge": "true",
				role: "img",
				title: label,
				"aria-label": label
			}, `#${pr.number}`);
		}
		//#endregion

		const inject = ["slots", "locale"];

		/**
		 * Mount the badge into the Session row trailing seat.
		 * @param ctx - client context with the slot registry and the locale service.
		 */
		function apply(ctx) {
			const locale = ctx.locale;
			if (locale !== undefined && locale !== null) {
				try {
					locale.register(NS, {
						en: {
							"state.open": "open",
							"state.draft": "draft",
							"state.merged": "merged",
							"state.closed": "closed"
						},
						ru: {
							"state.open": "открыт",
							"state.draft": "черновик",
							"state.merged": "влит",
							"state.closed": "закрыт"
						},
						zh: {
							"state.open": "开放",
							"state.draft": "草稿",
							"state.merged": "已合并",
							"state.closed": "已关闭"
						}
					});
				} catch {
					/* Translation is cosmetic; English state words stay. */
				}
			}
			ctx.slots.inject("sidebar.session.row.trailing", () => ctx.slots.register({
				name: "sidebar.session.row.trailing",
				id: "pr-badge",
				order: 15,
				locale: NS
			}, PrBadge));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
