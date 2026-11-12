/**
 * Client-bundle contract check: executes lib/client.js in a stubbed browser
 * surface (module loader, document, window, fetch), materializes the factory
 * with a stub React external, and asserts the whole painting path — the slot
 * registration, the row scanner (fiber-identified and title-matched rows, badge
 * insert/refresh/clear), the click-through contract, and the poll/cleanup
 * lifecycle driven through a stubbed effect.
 *
 *   node test/client-check.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const bundlePath = fileURLToPath(new URL("../lib/client.js", import.meta.url));
const source = readFileSync(bundlePath, "utf8");

// ---- stub DOM -------------------------------------------------------------

/** Minimal element: children array, attributes, and the mutators the plugin uses. */
function makeNode(tagName, { className = "", attrs = {}, text = "" } = {}) {
	const attributes = { ...attrs };
	const node = {
		tagName,
		className,
		children: [],
		textContent: text,
		dataset: {},
		listeners: {},
		getAttribute(name) {
			return attributes[name];
		},
		setAttribute(name, value) {
			attributes[name] = String(value);
		},
		removeAttribute(name) {
			delete attributes[name];
		},
		attr(name) {
			return attributes[name];
		},
		addEventListener(type, handler) {
			(node.listeners[type] ??= []).push(handler);
		},
		insertBefore(child, reference) {
			const index = node.children.indexOf(reference);
			if (index < 0) throw new Error("reference node is not a child");
			node.children.splice(index, 0, child);
			return child;
		},
		appendChild(child) {
			node.children.push(child);
			return child;
		},
		removeChild(child) {
			const index = node.children.indexOf(child);
			if (index < 0) throw new Error("not a child of this node");
			node.children.splice(index, 1);
			return child;
		},
	};
	return node;
}

const observers = [];
const timers = [];
const intervals = [];
const fetchCalls = [];
let fetchPayload = { entries: [] };

const body = makeNode("body");

const sandbox = {
	MutationObserver: class {
		constructor(callback) {
			this.callback = callback;
		}
		observe(target, options) {
			observers.push({ observer: this, target, options });
		}
		disconnect() {
			this.disconnected = true;
		}
	},
	document: {
		body,
		visibilityState: "visible",
		querySelector: () => null,
		createElement: (tagName) => makeNode(tagName),
		addEventListener() {},
		removeEventListener() {},
		head: {
			appendChild(node) {
				sandbox.appendedStyle = node;
			},
		},
	},
	fetch: (url, options) => {
		fetchCalls.push({ url, options });
		return Promise.resolve({ ok: true, status: 200, json: async () => fetchPayload });
	},
	setTimeout: (fn) => {
		timers.push(fn);
		return timers.length;
	},
	clearTimeout: () => {},
	setInterval: (fn, ms) => {
		intervals.push({ fn, ms });
		return intervals.length;
	},
	clearInterval: () => {},
	console,
};
sandbox.window = sandbox; // window === globalThis inside the script
const registrations = [];
sandbox.window.__ModuleLoader__ = {
	load(registration) {
		registrations.push(registration);
	},
};

vm.createContext(sandbox);
new vm.Script(source, { filename: "lib/client.js" }).runInContext(sandbox);

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---- registration + manifest contract -------------------------------------

assert.equal(registrations.length, 1, "script must register exactly one factory");
const registration = registrations[0];
assert.equal(
	registration.id,
	"@dsh-plugins/pr-badge",
	"registration id must equal the package name (boot-graph id)",
);
assert.equal(typeof registration.factory, "function", "registration must carry a factory");

const manifest = JSON.parse(
	readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
assert.equal(
	manifest.exports?.["./package.json"],
	"./package.json",
	"exports must expose ./package.json or the boot-graph scan drops this plugin",
);
assert.equal(manifest.exports?.["./client"], "./lib/client.js", "exports must map ./client");
assert.deepEqual(manifest.dsh?.client, { platform: "web", inject: [] });

// ---- materialize ----------------------------------------------------------

const effectCleanups = [];
const reactStub = {
	useRef: (value) => ({ current: value }),
	useEffect: (fn) => {
		const cleanup = fn();
		if (typeof cleanup === "function") effectCleanups.push(cleanup);
	},
};
const requireStub = (specifier) => {
	if (specifier === "react") return reactStub;
	throw new Error(`unexpected external request: ${specifier}`);
};

let face;
assert.doesNotThrow(() => {
	face = registration.factory(requireStub);
}, "factory must materialize without touching the network");
assert.equal(typeof face.apply, "function", "exports must expose apply");
assert.deepEqual([...face.inject], ["slots"], "plugin declares exactly the slots service");
for (const name of ["scanRows", "titleIndex", "normalizeTitle", "sessionIdOfRow", "titleSpanOf", "tooltipFor"]) {
	assert.equal(typeof face[name], "function", `${name} must be exported for tests`);
}

const injectedSlots = [];
const entries = [];
face.apply({
	slots: {
		inject(slotName, factory) {
			injectedSlots.push(slotName);
			const disposer = factory();
			assert.equal(typeof disposer, "function", "slots.inject must return its disposer");
		},
		register(options, component) {
			entries.push({ options, component });
			return () => {};
		},
	},
});
assert.deepEqual(injectedSlots, ["shell.overlay"], "one headless overlay seat");
assert.equal(entries.length, 1);
assert.equal(entries[0].options.name, "shell.overlay");
assert.equal(entries[0].options.id, "pr-badges");
assert.equal(entries[0].options.order, 51);
assert.equal(entries[0].component({}), null, "the painter renders nothing");

// ---- row fixtures ---------------------------------------------------------

/** A session row as the stock shell renders it: [slot?, title, time, actions]. */
function sessionRow(title, { fiberId, withStatus = true } = {}) {
	const children = [];
	if (withStatus) children.push(makeNode("span", { className: "YDXeBa_slot" }));
	children.push(makeNode("span", { className: "YDXeBa_title", text: title }));
	children.push(makeNode("span", { className: "YDXeBa_time", text: "5min" }));
	children.push(
		makeNode("span", { className: "YDXeBa_rowActions", children: [makeNode("button")] }),
	);
	const row = makeNode("div", {
		className: "YDXeBa_sessionRow",
		attrs: { role: "treeitem" },
	});
	row.children = children;
	if (fiberId) {
		// Shape of the real fiber chain: the row's own props, then the component
		// holding the session node, then slot-registry props carrying an unrelated
		// `id` that must never be mistaken for a session id.
		row["__reactFiber$abc123"] = {
			memoizedProps: { className: "YDXeBa_sessionRow", role: "treeitem" },
			return: {
				memoizedProps: { node: { id: fiberId }, currentId: fiberId },
				return: {
					memoizedProps: { id: "session-git-badges", name: "shell.overlay" },
					return: null,
				},
			},
		};
	}
	return row;
}

const mergedEntry = {
	sessionId: "session-fiber-1",
	title: "Refactor the parser",
	repo: "tribesman/dating-golang",
	number: 75,
	url: "https://github.com/tribesman/dating-golang/pull/75",
	color: "purple",
	reason: "merged",
};
const draftEntry = {
	sessionId: "session-titled",
	title: "Fix the auth race",
	repo: "tribesman/dating-golang",
	number: 77,
	url: "https://github.com/tribesman/dating-golang/pull/77",
	color: "orange",
	reason: "draft",
};
const unsafeEntry = {
	sessionId: "session-unsafe",
	title: "Local only",
	repo: null,
	number: null,
	url: "javascript:alert(1)",
	color: "green",
	reason: "open",
};

const byId = new Map([
	[mergedEntry.sessionId, mergedEntry],
	[unsafeEntry.sessionId, unsafeEntry],
]);
const byTitle = new Map([[draftEntry.title, draftEntry]]);

const fiberRow = sessionRow("Totally different title", { fiberId: "session-fiber-1" });
const titledRow = sessionRow("  Fix\nthe   auth race ");
const unsafeRow = sessionRow("Local only", { fiberId: "session-unsafe" });
// A project row keeps its title inside a `_projectText` wrapper.
const projectRow = makeNode("div", {
	attrs: { role: "treeitem" },
	children: [
		makeNode("span", { className: "YDXeBa_arrow" }),
		makeNode("div", {
			className: "YDXeBa_projectText",
			children: [makeNode("span", { className: "YDXeBa_title", text: "Refactor the parser" })],
		}),
	],
});
// A search result row reuses the treeitem role with a different shape.
const searchRow = makeNode("div", {
	attrs: { role: "treeitem" },
	children: [
		makeNode("span", {
			className: "YDXeBa_searchResultHeading",
			children: [
				makeNode("span", { className: "YDXeBa_slot" }),
				makeNode("span", {
					className: "YDXeBa_searchResultTitle",
					text: "Refactor the parser",
				}),
			],
		}),
		makeNode("span", { className: "YDXeBa_searchResultMeta" }),
	],
});
// A row whose session id resolves but carries no PR stays clean even though its
// title collides with another chat's badge.
const strangerRow = sessionRow("Refactor the parser", { fiberId: "session-without-pr" });
// A row with neither a fiber id nor a title match.
const unmappedRow = sessionRow("Some other session");

body.children.push(
	fiberRow,
	titledRow,
	unsafeRow,
	projectRow,
	searchRow,
	strangerRow,
	unmappedRow,
);

// ---- row structure --------------------------------------------------------

assert.equal(face.normalizeTitle("  A \n B  "), "A B", "titles normalize before matching");
assert.ok(face.titleSpanOf(fiberRow), "session rows expose a title span");
assert.equal(face.titleSpanOf(projectRow), undefined, "project rows are not session rows");
assert.equal(face.titleSpanOf(searchRow), undefined, "search results are not session rows");
assert.equal(
	face.sessionIdOfRow(fiberRow),
	"session-fiber-1",
	"the fiber chain yields the stable session id",
);
assert.equal(face.sessionIdOfRow(titledRow), undefined, "no fiber chain -> no id");
assert.equal(
	face.sessionIdOfRow({ __reactFiber$z: { memoizedProps: { id: "session-git-badges" }, return: null } }),
	undefined,
	"an unrelated slot id is never read as a session id",
);

// ---- title index ----------------------------------------------------------

const duplicateTitleEntry = { ...draftEntry, sessionId: "session-titled-2" };
const index = face.titleIndex([draftEntry, duplicateTitleEntry, mergedEntry]);
assert.equal(
	index.has(face.normalizeTitle(draftEntry.title)),
	false,
	"a title two chats share is not an identity",
);
assert.equal(
	index.get(face.normalizeTitle(mergedEntry.title))?.sessionId,
	"session-fiber-1",
	"an unambiguous title still matches",
);
assert.equal(face.titleIndex([{ ...mergedEntry, title: "   " }]).size, 0, "blank titles never match");

// ---- scanning -------------------------------------------------------------

const touched = face.scanRows(body, byId, byTitle, sandbox.document);
assert.equal(touched.size, 7, "every treeitem is visited, nested shapes included");

/** The badge element of a row, or undefined. */
function badgeOf(row) {
	return row.children.find((child) => child.attr("data-pr-badge") !== undefined);
}

const fiberBadge = badgeOf(fiberRow);
assert.ok(fiberBadge, "the fiber-identified row is painted");
assert.equal(fiberRow.children.indexOf(fiberBadge), 1, "the badge sits left of the title");
assert.equal(fiberBadge.className, "dsh-pr-badge");
assert.equal(fiberBadge.attr("data-pr-badge"), "purple", "merged is purple");
assert.equal(fiberBadge.attr("data-pr-reason"), "merged");
assert.equal(fiberBadge.attr("href"), mergedEntry.url, "the badge links to the PR");
assert.equal(fiberBadge.attr("target"), "_blank", "the PR opens in a new tab");
assert.equal(fiberBadge.attr("rel"), "noopener noreferrer");
assert.equal(fiberBadge.attr("draggable"), "false");
assert.match(fiberBadge.innerHTML, /viewBox="0 0 16 16"/, "the octicon is inlined");
assert.match(fiberBadge.innerHTML, /<path d="M1\.5 3\.25/, "the pull-request path is verbatim");
assert.equal(
	fiberBadge.attr("title"),
	"tribesman/dating-golang#75 · PR влит",
	"the tooltip names the PR and its state",
);
assert.equal(fiberBadge.attr("aria-label"), fiberBadge.attr("title"));

const titledBadge = badgeOf(titledRow);
assert.ok(titledBadge, "a row without a fiber chain matches by normalized title");
assert.equal(titledBadge.attr("data-pr-badge"), "orange", "a draft is orange");
assert.equal(titledBadge.attr("data-pr-reason"), "draft");

const unsafeBadge = badgeOf(unsafeRow);
assert.ok(unsafeBadge, "an entry without a usable URL is still painted");
assert.equal(unsafeBadge.attr("href"), undefined, "a non-http URL is never linked");
assert.equal(unsafeBadge.attr("data-pr-badge"), "green");
assert.equal(unsafeBadge.attr("title"), "Pull request · PR открыт", "no repo -> a bare tooltip");

assert.equal(badgeOf(projectRow), undefined, "project rows are left alone");
assert.equal(badgeOf(searchRow), undefined, "search results are left alone");
assert.equal(
	badgeOf(strangerRow),
	undefined,
	"a session id without a PR is never badged with another chat's PR",
);
assert.equal(badgeOf(unmappedRow), undefined, "an unmatched row keeps no badge");

// Repainting is idempotent: the badge is refreshed, never duplicated.
face.scanRows(body, byId, byTitle, sandbox.document);
assert.equal(fiberRow.children.length, 5, "a repaint does not add a second badge");
assert.equal(badgeOf(fiberRow), fiberBadge, "the same element is reused");

// A changed feed recolors in place…
const recolored = new Map(byId);
recolored.set(mergedEntry.sessionId, { ...mergedEntry, color: "orange", reason: "conflicts" });
face.scanRows(body, recolored, byTitle, sandbox.document);
assert.equal(badgeOf(fiberRow).attr("data-pr-badge"), "orange");
assert.equal(badgeOf(fiberRow).attr("data-pr-reason"), "conflicts");
assert.equal(fiberRow.children.length, 5);

// …and a shrinking feed clears badges again.
face.scanRows(body, new Map(), new Map(), sandbox.document);
assert.equal(badgeOf(fiberRow), undefined, "a stale badge is removed");
assert.equal(badgeOf(titledRow), undefined, "removal covers title-matched rows too");
assert.equal(fiberRow.children.length, 4, "the row returns to its stock shape");
assert.equal(titledRow.children[0].className, "YDXeBa_slot", "stock children are untouched");

// ---- click contract -------------------------------------------------------

const clickStops = [];
const link = badgeOf(
	(() => {
		face.scanRows(body, byId, byTitle, sandbox.document);
		return fiberRow;
	})(),
);
for (const type of ["click", "auxclick", "pointerdown", "mousedown", "dragstart"]) {
	const handlers = link.listeners[type];
	assert.ok(Array.isArray(handlers) && handlers.length > 0, `${type} must be intercepted`);
	let stopped = 0;
	let defaultPrevented = 0;
	handlers[0]({
		stopPropagation: () => {
			stopped += 1;
		},
		preventDefault: () => {
			defaultPrevented += 1;
		},
	});
	assert.equal(stopped, 1, `${type} must not reach the row's session-open handler`);
	assert.equal(defaultPrevented, 0, `${type} must keep the browser's default behaviour`);
	clickStops.push(type);
}
assert.equal(clickStops.length, 5);

// ---- tooltips -------------------------------------------------------------

assert.equal(face.tooltipFor(mergedEntry), "tribesman/dating-golang#75 · PR влит");
assert.equal(face.tooltipFor({ number: 12, reason: "checks-failing" }), "PR #12 · PR: проверки падают");
assert.equal(face.tooltipFor({}), "Pull request · Pull request");
assert.equal(face.tooltipFor({ repo: "a/b", number: 3, reason: "who-knows" }), "a/b#3 · Pull request");
// GitLab merge requests keep their own sigil and wording.
assert.equal(
	face.tooltipFor({ repo: "group/app", number: 1660, reason: "open", forge: "gitlab" }),
	"group/app!1660 · MR открыт",
);
assert.equal(
	face.tooltipFor({ number: 1660, reason: "conflicts", forge: "gitlab" }),
	"MR !1660 · MR: конфликты с базовой ветвью",
);

// ---- lifecycle: poll, paint, clean up --------------------------------------

// The smoke render above already mounted one effect: retire it and its
// bookkeeping so the lifecycle below is measured from a clean slate.
for (const cleanup of effectCleanups.splice(0)) cleanup();
fetchCalls.length = 0;
observers.length = 0;
intervals.length = 0;

body.children.length = 0;
body.children.push(fiberRow, titledRow, unmappedRow);
for (const row of body.children) {
	const badge = badgeOf(row);
	if (badge) row.removeChild(badge);
}

fetchPayload = { entries: [mergedEntry, draftEntry] };
assert.equal(effectCleanups.length, 0);
entries[0].component({});
assert.equal(effectCleanups.length, 1, "the overlay seat mounts one effect");
assert.equal(fetchCalls.length, 1, "the effect polls immediately");
assert.equal(fetchCalls[0].url, "/pr-badge/api/states");
assert.equal(fetchCalls[0].options.method, "GET");
await flush();
await flush();
assert.ok(badgeOf(fiberRow), "the polled feed paints the fiber-identified row");
assert.ok(badgeOf(titledRow), "the polled feed paints the title-matched row");
assert.equal(badgeOf(unmappedRow), undefined);
assert.equal(observers.length, 1, "one mutation observer watches the sidebar");
assert.equal(observers[0].target, body);
assert.deepEqual(
	{ childList: observers[0].options.childList, subtree: observers[0].options.subtree },
	{ childList: true, subtree: true },
);
assert.equal(intervals.length, 1, "one poll interval");
assert.equal(intervals[0].ms, 60_000, "the sidebar polls once a minute");

// A DOM mutation schedules a debounced repaint rather than repainting inline.
const pendingBefore = timers.length;
observers[0].observer.callback();
assert.equal(timers.length, pendingBefore + 1);
observers[0].observer.callback();
assert.equal(timers.length, pendingBefore + 1, "repaints coalesce");
timers[timers.length - 1]();

// Unmounting restores the stock shell.
effectCleanups[0]();
assert.equal(badgeOf(fiberRow), undefined, "cleanup removes the badges it painted");
assert.equal(badgeOf(titledRow), undefined);
assert.equal(fiberRow.children.length, 4);
assert.equal(observers[0].observer.disconnected, true, "cleanup disconnects the observer");

// ---- stylesheet -----------------------------------------------------------

assert.ok(sandbox.appendedStyle, "the bundle injects its stylesheet at materialization");
const stylesheet = sandbox.appendedStyle.textContent;
assert.match(stylesheet, /a\.dsh-pr-badge\{/);
assert.match(stylesheet, /data-pr-badge="green"\]\{color:#3fb950\}/);
assert.match(stylesheet, /data-pr-badge="orange"[^}]*#d29922/);
assert.match(stylesheet, /data-pr-badge="purple"[^}]*#a371f7/);
assert.match(stylesheet, /data-pr-badge="grey"[^}]*#8b949e/);
assert.equal(sandbox.appendedStyle.dataset.pluginCss, "@dsh-plugins/pr-badge/badge.css");

console.log("client-bundle contract OK:");
console.log("  - registers under id @dsh-plugins/pr-badge");
console.log("  - injects 'shell.overlay' as headless entry 'pr-badges'");
console.log("  - paints session rows by session id (fiber) with a title fallback");
console.log("  - leaves project rows, search results and PR-less rows untouched");
console.log("  - badge = octicon anchor, new tab, click stopped before the row handler");
console.log("  - polls /pr-badge/api/states every 60 s and cleans up on unmount");
console.log("  - stylesheet carries the four state colors");
