/**
 * @dsh-plugins/pr-badge — browser half.
 *
 * Hand-written lazy-CJS client bundle in the DSH client-module factory form:
 * executing the script only REGISTERS the factory; the body below runs at
 * materialization. Externals are limited to the shell-seeded baseline
 * (`react`), because this plugin contributes no React tree of its own.
 *
 * The stock session-list renderer exposes no per-row slot (`sidebar.workspaces`
 * is a single-registration seat covering the whole tree), so the badge is
 * painted into the DOM: for every sidebar session row the plugin inserts one
 * `<a class="dsh-pr-badge">` carrying GitHub's pull-request octicon directly
 * left of the row title, colored by the host feed's state, linking to the PR in
 * a new tab.
 *
 * Matching is by session id first: the row's React fiber chain is walked up to
 * the `SessionNodeItem` props, whose `node.id` is the stable session id. Rows
 * whose fiber chain is unreadable (a future React change, or a non-React row)
 * fall back to matching the normalized row title. A row that matches nothing is
 * left exactly as the shell drew it.
 *
 * Every node this plugin adds is its own — it never rewrites React-managed
 * children — so unmounting the plugin restores the stock shell.
 */
window.__ModuleLoader__.load({
	id: "@dsh-plugins/pr-badge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		//#region styles
		/** GitHub's pull-request octicon, verbatim, recolored with `currentColor`. */
		const OCTICON_PULL_REQUEST =
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14"` +
			` fill="currentColor" aria-hidden="true" focusable="false"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>`;

		const css =
			"a.dsh-pr-badge{display:inline-flex;align-items:center;justify-content:center;" +
			"width:14px;height:14px;flex:none;margin:0 5px 0 1px;border-radius:3px;" +
			"color:#3fb950;background:none;text-decoration:none;opacity:.9;cursor:pointer}" +
			"a.dsh-pr-badge:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}" +
			"a.dsh-pr-badge:focus-visible{outline:1px solid var(--dsw-alias-border-l3,#4a4a52);outline-offset:1px}" +
			"a.dsh-pr-badge svg{display:block;width:14px;height:14px;fill:currentColor}" +
			'a.dsh-pr-badge[data-pr-badge="green"]{color:#3fb950}' +
			'a.dsh-pr-badge[data-pr-badge="orange"]{color:#d29922}' +
			'a.dsh-pr-badge[data-pr-badge="purple"]{color:#a371f7}' +
			'a.dsh-pr-badge[data-pr-badge="grey"]{color:#8b949e}';

		const tagId = "@dsh-plugins/pr-badge/badge.css";
		if (
			typeof document !== "undefined" &&
			typeof document.querySelector === "function" &&
			document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-plugins/pr-badge";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region row reconciliation
		const STATES_POLL_MS = 60_000;
		const RESCAN_DEBOUNCE_MS = 200;
		const BADGE_ATTRIBUTE = "data-pr-badge";
		const BADGE_CLASS = "dsh-pr-badge";
		const SESSION_ID_PREFIX = "session-";
		const FIBER_KEYS = ["__reactFiber$", "__reactInternalInstance$"];
		const COLORS = new Set(["green", "orange", "purple", "grey"]);

		/** Tooltip texts for the host's reason codes. */
		const REASON_LABELS = {
			open: "PR открыт",
			merged: "PR влит",
			closed: "PR закрыт без мержа",
			conflicts: "PR: конфликты с базовой ветвью",
			"changes-requested": "PR: запрошены изменения",
			"checks-failing": "PR: проверки падают",
			draft: "PR: черновик",
		};

		function normalizeTitle(text) {
			return String(text ?? "")
				.replace(/\s+/g, " ")
				.trim();
		}

		function childrenOf(node) {
			if (!node || !node.children || typeof node.children.length !== "number") return [];
			return Array.from(node.children);
		}

		function attrOf(node, name) {
			if (!node || typeof node.getAttribute !== "function") return undefined;
			try {
				return node.getAttribute(name) ?? undefined;
			} catch {
				return undefined;
			}
		}

		function classNameOf(node) {
			const direct = node && typeof node.className === "string" ? node.className : undefined;
			if (direct !== undefined) return direct;
			return attrOf(node, "class") ?? "";
		}

		/**
		 * The row's title span: the direct child whose class token ends in
		 * `_title` (a hashed CSS-module name such as `YDXeBa_title`). Project
		 * rows keep their title inside a `_projectText` wrapper, search results in
		 * a `_searchResultTitle` heading, so both fail this test and are skipped.
		 * @param {object} row - candidate `[role=treeitem]` element.
		 * @returns {object|undefined} the title span, when the row is a session row.
		 */
		function titleSpanOf(row) {
			for (const child of childrenOf(row)) {
				const className = classNameOf(child);
				if (!className) continue;
				if (className.includes("_projectText")) return undefined;
				if (/(?:^|\s)\S*_title(?:\s|$)/.test(className)) return child;
			}
			return undefined;
		}

		/** Stable session id from the row's React props, when a fiber is reachable. */
		function sessionIdFromProps(props) {
			if (!props || typeof props !== "object") return undefined;
			const candidates = [
				props.node?.id,
				props.sessionId,
				props.row?.id,
				props.session?.id,
				props.session?.sessionId,
			];
			for (const candidate of candidates) {
				if (typeof candidate === "string" && candidate.startsWith(SESSION_ID_PREFIX)) {
					return candidate;
				}
			}
			return undefined;
		}

		/**
		 * Walk the row element's React fiber chain up to the component whose props
		 * carry the session node. Undocumented on purpose: when it stops working
		 * the caller silently falls back to title matching.
		 * @param {object} row - session row element.
		 * @returns {string|undefined} session id, or undefined when unreachable.
		 */
		function sessionIdOfRow(row) {
			if (!row || typeof row !== "object") return undefined;
			let keys;
			try {
				keys = Object.keys(row);
			} catch {
				return undefined;
			}
			for (const key of keys) {
				if (!FIBER_KEYS.some((prefix) => key.startsWith(prefix))) continue;
				let fiber = row[key];
				for (let depth = 0; fiber && depth < 15; depth += 1) {
					const sessionId = sessionIdFromProps(fiber.memoizedProps);
					if (sessionId) return sessionId;
					fiber = fiber.return;
				}
			}
			return undefined;
		}

		/**
		 * Build the normalized-title index the fallback matcher uses. A title two
		 * chats share is dropped from the index: without a fiber id the title is
		 * no identity, and painting by it would put one chat's pull request on
		 * another chat's row.
		 * @param {Array<object>} entries - feed entries.
		 * @returns {Map<string, object>} title -> entry, unambiguous titles only.
		 */
		function titleIndex(entries) {
			const index = new Map();
			const duplicated = new Set();
			for (const entry of Array.isArray(entries) ? entries : []) {
				if (!entry || typeof entry !== "object") continue;
				if (typeof entry.title !== "string" || !entry.title.trim()) continue;
				const key = normalizeTitle(entry.title);
				if (!key || duplicated.has(key)) continue;
				if (index.has(key)) {
					index.delete(key);
					duplicated.add(key);
					continue;
				}
				index.set(key, entry);
			}
			return index;
		}

		/** The badge this plugin already inserted into a row, if any. */
		function badgeOf(row) {
			for (const child of childrenOf(row)) {
				if (attrOf(child, BADGE_ATTRIBUTE) !== undefined) return child;
			}
			return undefined;
		}

		/** GitLab calls them merge requests; the host marks each entry's forge. */
		function forgeWord(entry) {
			return entry?.forge === "gitlab" ? "MR" : "PR";
		}

		function forgeSigil(entry) {
			return entry?.forge === "gitlab" ? "!" : "#";
		}

		function tooltipFor(entry) {
			const word = forgeWord(entry);
			const sigil = forgeSigil(entry);
			const head =
				entry && entry.repo && typeof entry.number === "number"
					? `${entry.repo}${sigil}${entry.number}`
					: entry && typeof entry.number === "number"
						? `${word} ${sigil}${entry.number}`
						: "Pull request";
			const label = (REASON_LABELS[entry?.reason] ?? "Pull request").replace(/^PR\b/, word);
			return `${head} · ${label}`;
		}

		/** One badge anchor: icon, click-through, and a new tab. */
		function createBadge(doc) {
			const link = doc.createElement("a");
			link.className = BADGE_CLASS;
			link.setAttribute(BADGE_ATTRIBUTE, "green");
			link.setAttribute("target", "_blank");
			link.setAttribute("rel", "noopener noreferrer");
			link.setAttribute("draggable", "false");
			link.innerHTML = OCTICON_PULL_REQUEST;
			if (typeof link.addEventListener === "function") {
				// The row itself opens the session on click; the badge must not.
				for (const type of ["click", "auxclick", "pointerdown", "mousedown", "dragstart"]) {
					link.addEventListener(type, (event) => {
						if (event && typeof event.stopPropagation === "function") {
							event.stopPropagation();
						}
					});
				}
			}
			return link;
		}

		/** Refresh one badge in place; a no-op when nothing actually changed. */
		function updateBadge(link, entry) {
			const color = COLORS.has(entry.color) ? entry.color : "green";
			if (attrOf(link, BADGE_ATTRIBUTE) !== color) link.setAttribute(BADGE_ATTRIBUTE, color);
			const reason = String(entry.reason ?? "");
			if (attrOf(link, "data-pr-reason") !== reason) link.setAttribute("data-pr-reason", reason);
			const href =
				typeof entry.url === "string" && /^https?:\/\//i.test(entry.url) ? entry.url : undefined;
			if (href) {
				if (attrOf(link, "href") !== href) link.setAttribute("href", href);
			} else if (attrOf(link, "href") !== undefined) {
				link.removeAttribute("href");
			}
			const label = tooltipFor(entry);
			if (attrOf(link, "title") !== label) link.setAttribute("title", label);
			if (attrOf(link, "aria-label") !== label) link.setAttribute("aria-label", label);
		}

		function removeBadgeFrom(row, link) {
			if (typeof row.removeChild === "function") {
				try {
					row.removeChild(link);
				} catch {
					/* already detached */
				}
			}
		}

		function insertBadge(row, titleSpan, link) {
			if (typeof row.insertBefore === "function") {
				try {
					row.insertBefore(link, titleSpan);
					return;
				} catch {
					/* fall through to append */
				}
			}
			if (typeof row.appendChild === "function") row.appendChild(link);
		}

		/**
		 * The feed entry a row should display: by session id when the fiber chain
		 * is readable, otherwise by normalized title. A row whose id resolves but
		 * carries no PR is left alone — never matched by title, which could badge
		 * it with another chat's pull request.
		 * @param {object} row - session row element.
		 * @param {object} titleSpan - the row's title span.
		 * @param {Map} byId - sessionId -> feed entry.
		 * @param {Map} byTitle - normalized title -> feed entry.
		 * @returns {object|undefined} feed entry to paint.
		 */
		function entryForRow(row, titleSpan, byId, byTitle) {
			const sessionId = sessionIdOfRow(row);
			if (sessionId) return byId.get(sessionId);
			const title = normalizeTitle(titleSpan?.textContent);
			return title ? byTitle.get(title) : undefined;
		}

		/** Add, refresh, or drop the badge of one session row. */
		function reconcileRow(row, byId, byTitle, doc) {
			const titleSpan = titleSpanOf(row);
			if (!titleSpan) return;
			const entry = entryForRow(row, titleSpan, byId, byTitle);
			const existing = badgeOf(row);
			if (!entry) {
				if (existing) removeBadgeFrom(row, existing);
				return;
			}
			if (existing) {
				updateBadge(existing, entry);
				return;
			}
			const link = createBadge(doc);
			updateBadge(link, entry);
			insertBadge(row, titleSpan, link);
		}

		/**
		 * Paint every session row under `root`. Rows are found structurally
		 * (`[role=treeitem]`), so no hashed class name of the sidebar tree itself
		 * is load-bearing. Pure over minimal node objects, except for the badge
		 * nodes it creates through `doc`.
		 * @param {object} root - subtree root (normally `document.body`).
		 * @param {Map} byId - sessionId -> feed entry.
		 * @param {Map} byTitle - normalized title -> feed entry.
		 * @param {object} doc - document (element factory).
		 * @returns {Set} every row visited this pass.
		 */
		function scanRows(root, byId, byTitle, doc) {
			const touched = new Set();
			const visit = (node) => {
				for (const child of childrenOf(node)) {
					if (attrOf(child, "role") === "treeitem") {
						touched.add(child);
						try {
							reconcileRow(child, byId, byTitle, doc);
						} catch {
							/* a hostile row shape must never break the page */
						}
						continue;
					}
					visit(child);
				}
			};
			visit(root);
			return touched;
		}

		/**
		 * Headless overlay entry: polls the host feed and repaints rows on DOM
		 * mutations. Renders nothing; owns every timer/observer it creates.
		 */
		function PrBadges() {
			const feedRef = react.useRef({ byId: new Map(), byTitle: new Map() });
			const paintedRef = react.useRef(new Set());

			react.useEffect(() => {
				let live = true;
				let pending = null;
				let intervalId = null;
				let observer = null;

				const repaint = () => {
					try {
						if (typeof document === "undefined" || !document.body) return;
						const feed = feedRef.current;
						for (const node of scanRows(document.body, feed.byId, feed.byTitle, document)) {
							paintedRef.current.add(node);
						}
					} catch {
						/* a hostile node shape must never break the page */
					}
				};
				const requestRepaint = () => {
					if (pending !== null) return;
					pending = window.setTimeout(() => {
						pending = null;
						if (live) repaint();
					}, RESCAN_DEBOUNCE_MS);
				};
				const poll = () => {
					fetchPrStates()
						.then((payload) => {
							if (!live) return;
							const byId = new Map();
							const entries = Array.isArray(payload?.entries) ? payload.entries : [];
							for (const entry of entries) {
								if (!entry || typeof entry !== "object") continue;
								if (typeof entry.sessionId === "string") byId.set(entry.sessionId, entry);
							}
							feedRef.current = { byId, byTitle: titleIndex(entries) };
							repaint();
						})
						.catch(() => {});
				};
				const onVisible = () => {
					if (document.visibilityState === "visible") poll();
				};

				if (typeof MutationObserver === "function" && document.body) {
					observer = new MutationObserver(requestRepaint);
					observer.observe(document.body, {
						childList: true,
						subtree: true,
						characterData: true,
					});
				}
				if (typeof document.addEventListener === "function") {
					document.addEventListener("visibilitychange", onVisible);
				}
				intervalId = window.setInterval(poll, STATES_POLL_MS);
				poll();

				return () => {
					live = false;
					if (pending !== null) window.clearTimeout(pending);
					window.clearInterval(intervalId);
					if (observer) observer.disconnect();
					if (typeof document.removeEventListener === "function") {
						document.removeEventListener("visibilitychange", onVisible);
					}
					for (const node of paintedRef.current) {
						try {
							const link = node ? badgeOf(node) : undefined;
							if (link) removeBadgeFrom(node, link);
						} catch {
							/* detached node */
						}
					}
					paintedRef.current.clear();
				};
			}, []);

			return null;
		}
		//#endregion

		//#region api client
		const API = "/pr-badge/api";

		async function fetchPrStates() {
			const response = await fetch(`${API}/states`, { method: "GET" });
			if (!response.ok) throw new Error(`pr-badge: HTTP ${response.status}`);
			return response.json();
		}
		//#endregion

		//#region plugin body
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "pr-badges",
						order: 51,
					},
					PrBadges,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.scanRows = scanRows;
		exports.titleIndex = titleIndex;
		exports.normalizeTitle = normalizeTitle;
		exports.sessionIdOfRow = sessionIdOfRow;
		exports.titleSpanOf = titleSpanOf;
		exports.tooltipFor = tooltipFor;
		return module.exports;
	},
});
