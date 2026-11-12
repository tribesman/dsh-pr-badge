/**
 * @dsh-plugins/pr-badge — host half.
 *
 * Answers one question for every DSH session: *which GitHub pull request does
 * the branch of this session's working directory belong to, and how is it
 * doing?* The browser half turns that feed into a colored pull-request octicon
 * inside each sidebar session row.
 *
 * Resolution path per session, with cwd taken from the session header:
 *
 *   cwd ──git rev-parse --show-toplevel──▶ repository top
 *       ──<repo>/.dsh/worktrees/bindings.json──▶ bound worktree branch (if any)
 *       ──git rev-parse --abbrev-ref HEAD──▶ branch (no binding)
 *       ──gh pr view <branch> --json …─────▶ PR view (cwd = repository top)
 *
 * `gh` always runs with cwd = the repository top so it resolves the session's
 * own repository. The worktree binding matters because a chat that
 * `@dsh-plugins/worktree-launcher` moved into an isolated checkout keeps its
 * session `cwd` at the repository root: reading the branch from that cwd would
 * report `main` for every worktree chat and badge nothing. Bindings are read
 * from a fixed path under the session's own repository — never from a request.
 *
 * Badge faces (`derivePrBadge`):
 *
 *   green  — open and unblocked
 *   orange — open and blocked: conflicts, changes requested, failing checks, draft
 *   purple — merged
 *   grey   — closed without a merge
 *
 * Nothing on this surface is request-controlled: both routes take no
 * parameters, and every path or command argument comes from a session header.
 * Commands therefore run with the full privileges of the harness process, over
 * loopback only, behind the Host allowlist below.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const inject = ["webServer", "subprocess"];

const API_PREFIX = "/pr-badge/api";

const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const DEFAULT_GH_TIMEOUT_MS = 15_000;
const DEFAULT_LOCATION_TTL_MS = 30_000;
const DEFAULT_BINDINGS_TTL_MS = 15_000;
const DEFAULT_SESSIONS_TTL_MS = 15_000;
const DEFAULT_OPEN_TTL_MS = 60_000;
const DEFAULT_TERMINAL_TTL_MS = 600_000;
const DEFAULT_ABSENT_TTL_MS = 120_000;
const DEFAULT_ERROR_TTL_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_SESSIONS = 200;
const GH_PROBE_RETRY_MS = 300_000;
/** Cache ceilings; a clear() beats unbounded growth in a long-lived process. */
const MAX_CACHE_ENTRIES = 500;

/**
 * Branches whose PRs never belong to the session sitting on them: a repo's
 * integration branches are the *base* of other people's pull requests, so
 * `gh pr view main` happily returns a stranger's PR.
 */
const SKIPPED_BRANCHES = new Set(["main", "master", "develop", "trunk", "development"]);

/** Glyph colors, aligned with GitHub's `fgColor-*` tokens. */
export const BADGE_COLORS = {
	green: "#3fb950",
	orange: "#d29922",
	purple: "#a371f7",
	grey: "#8b949e",
};

const BAD_CHECK_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"STARTUP_FAILURE",
	"ACTION_REQUIRED",
	"CANCELLED",
	"ERROR",
]);
const GOOD_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const PR_JSON_FIELDS =
	"number,url,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup";

function oneLine(text) {
	return String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Normalize one `statusCheckRollup` entry — CheckRun (`conclusion`) and
 * StatusContext (`state`) shapes — down to `{name, conclusion}`.
 * @param {object} entry - raw rollup entry.
 * @returns {{name: string, conclusion: string}} normalized check.
 */
export function normalizeCheck(entry) {
	if (!entry || typeof entry !== "object") return { name: "check", conclusion: "UNKNOWN" };
	const name = String(entry.name ?? entry.context ?? entry.workflowName ?? "check");
	if (typeof entry.conclusion === "string" && entry.conclusion) {
		return { name, conclusion: entry.conclusion.toUpperCase() };
	}
	const state = String(entry.state ?? "").toUpperCase();
	if (state === "SUCCESS") return { name, conclusion: "SUCCESS" };
	if (state === "FAILURE" || state === "ERROR") return { name, conclusion: "FAILURE" };
	if (state === "PENDING" || state === "EXPECTED") return { name, conclusion: "PENDING" };
	return { name, conclusion: state || "UNKNOWN" };
}

/**
 * Classify one full rollup snapshot: `failed` wins over `pending`, and an empty
 * rollup is `empty` (checks not registered yet).
 * @param {unknown} rollup - `statusCheckRollup` array from `gh pr view`.
 * @returns {{outcome: "empty"|"failed"|"pending"|"passed", checks: Array<object>}} verdict.
 */
export function classifyChecks(rollup) {
	const checks = (Array.isArray(rollup) ? rollup : []).map(normalizeCheck);
	if (checks.length === 0) return { outcome: "empty", checks };
	let failed = false;
	let pending = false;
	for (const check of checks) {
		if (BAD_CHECK_CONCLUSIONS.has(check.conclusion)) failed = true;
		else if (!GOOD_CHECK_CONCLUSIONS.has(check.conclusion)) pending = true;
	}
	if (failed) return { outcome: "failed", checks };
	if (pending) return { outcome: "pending", checks };
	return { outcome: "passed", checks };
}

/**
 * The reason an open PR is not ready to merge, or undefined when nothing blocks
 * it. Order matters only for the tooltip text: conflicts beat review state,
 * which beats CI, which beats draft.
 * @param {object} view - normalized PR view.
 * @returns {string|undefined} reason code, or undefined when unblocked.
 */
export function blockingReason(view) {
	if (!view || typeof view !== "object") return undefined;
	if (view.mergeable === "CONFLICTING" || view.mergeStateStatus === "DIRTY") return "conflicts";
	if (String(view.reviewDecision ?? "").toUpperCase() === "CHANGES_REQUESTED") {
		return "changes-requested";
	}
	if (classifyChecks(view.statusCheckRollup).outcome === "failed") return "checks-failing";
	if (view.isDraft === true) return "draft";
	return undefined;
}

/**
 * Map one normalized PR view onto the badge face, or null when the view cannot
 * be understood (no badge is better than a wrong badge).
 * @param {object} view - normalized PR view.
 * @returns {{color: string, reason: string}|null} badge face.
 */
export function derivePrBadge(view) {
	if (!view || typeof view !== "object") return null;
	const state = String(view.state ?? "").toUpperCase();
	if (state === "MERGED") return { color: "purple", reason: "merged" };
	if (state === "CLOSED") return { color: "grey", reason: "closed" };
	if (state !== "OPEN") return null;
	const reason = blockingReason(view);
	return reason ? { color: "orange", reason } : { color: "green", reason: "open" };
}

/**
 * Extract `owner/repo` from a pull-request URL (no extra `gh` round trip).
 * @param {unknown} url - `url` field of a `gh pr view` result.
 * @returns {string|undefined} `owner/repo`, or undefined when unparsable.
 */
export function parseRepoSlug(url) {
	if (typeof url !== "string") return undefined;
	const match = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/i);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * Extract the project path out of a pull- or merge-request URL, for either
 * forge: `https://host/group/proj/pull/7` and
 * `https://host/group/proj/-/merge_requests/7` both answer `group/proj`.
 * @param {unknown} url - `url`/`web_url` field of a forge answer.
 * @returns {string|undefined} project path, or undefined when unparsable.
 */
export function parseMergeRequestRepo(url) {
	if (typeof url !== "string") return undefined;
	const match = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\/-\/merge_requests\/\d+|\/pull\/\d+)/i);
	return match ? match[1] : undefined;
}

/**
 * Split a git remote URL into host and project path.
 *
 * Both shapes git writes are understood: the scp form
 * (`git@gitlab.example.com:group/project.git`) and real URLs (`https://…`,
 * `ssh://git@…:2222/…`). Anything else is `null` — a remote this plugin cannot
 * read is simply a repository without a forge.
 * @param {unknown} raw - `remote.<name>.url` value.
 * @returns {{host: string, path: string}|null} normalized remote.
 */
export function parseRemoteUrl(raw) {
	if (typeof raw !== "string") return null;
	const text = raw.trim();
	if (!text) return null;
	let host;
	let pathPart;
	if (text.includes("://")) {
		let url;
		try {
			url = new URL(text);
		} catch {
			return null;
		}
		host = url.hostname;
		pathPart = url.pathname;
	} else {
		const match = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(text);
		if (!match) return null;
		host = match[1];
		pathPart = match[2];
	}
	const path = String(pathPart ?? "")
		.replace(/^\/+/, "")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "");
	if (!host || !path) return null;
	return { host: host.toLowerCase(), path };
}

/** The host `gh` is the client for; a host that names GitLab uses `glab`. */
const GITHUB_HOSTNAME = "github.com";

/**
 * Which command-line client speaks for a repository.
 *
 * Hosts that name GitHub keep `gh`; hosts that name GitLab (gitlab.com or a
 * self-hosted instance with "gitlab" in its name) use `glab`; anything else
 * keeps the historical `gh` path, and `deps.forge` forces either client for a
 * self-hosted instance whose host name gives nothing away.
 * @param {{host: string, path: string}|null} remote - parsed git remote.
 * @param {"github"|"gitlab"} [forced] - row config override.
 * @returns {"github"|"gitlab"} forge kind.
 */
export function forgeOf(remote, forced) {
	if (forced === "github" || forced === "gitlab") return forced;
	if (!remote || typeof remote.host !== "string") return "github";
	if (remote.host === GITHUB_HOSTNAME || remote.host.endsWith(`.${GITHUB_HOSTNAME}`)) {
		return "github";
	}
	return /gitlab/i.test(remote.host) ? "gitlab" : "github";
}

/** A full pull-request URL inside prose. */
const PR_URL_RE = /https?:\/\/[^\s<>()[\]"']+\/pull\/(\d{1,7})/i;
/** `pr 335`, `PR#335`, `pull request 12`, `pull 12`, `MR 7`. */
const PR_WORD_RE = /\b(?:pr|mr|pull\s*requests?|pull)\s*[:#№]?\s*(\d{1,7})\b/i;
/** A review command carrying a bare number: `/code-review 335`. */
const PR_COMMAND_RE = /\/(?:code[-\s]?)?review\b[^\n]{0,24}?\b(\d{1,7})\b/i;

/**
 * Pull the pull-request reference out of a session's opening message.
 *
 * A chat does not have to *own* a pull request to be about one: the review flow
 * starts with a command such as `/code-review pr 335`, which names the PR by
 * number while the session's own branch stays unrelated (usually the base
 * branch). Only the first message is inspected, only explicit pull-request
 * wording or a pull URL counts — an `issue 339` chat deliberately yields nothing
 * — and the earliest match in the text wins.
 *
 * @param {unknown} text - the session's first user message.
 * @returns {{number: number, href?: string}|null} reference, or null when none.
 */
export function prReferenceFrom(text) {
	if (typeof text !== "string" || !text) return null;
	const candidates = [];
	const url = PR_URL_RE.exec(text);
	if (url) candidates.push({ at: url.index, number: Number(url[1]), href: url[0] });
	const word = PR_WORD_RE.exec(text);
	if (word) candidates.push({ at: word.index, number: Number(word[1]) });
	const command = PR_COMMAND_RE.exec(text);
	if (command) candidates.push({ at: command.index, number: Number(command[1]) });
	candidates.sort((a, b) => a.at - b.at);
	const picked = candidates.find(
		(candidate) => Number.isSafeInteger(candidate.number) && candidate.number > 0,
	);
	if (!picked) return null;
	return picked.href ? { number: picked.number, href: picked.href } : { number: picked.number };
}

/** A session title that opens with a tracker id: `41468 Ингосстрах: …`. */
const TASK_NUMBER_RE = /^\s*#?(\d{3,7})\b/;

/**
 * The tracker id a session is about, read the way people name such chats: the
 * leading number of the session title, else of its opening message. Only a
 * leading number counts — a number buried in prose is not a task.
 * @param {unknown} title - session title.
 * @param {unknown} firstMessage - opening user message.
 * @returns {number|undefined} tracker id, when the chat names one.
 */
export function taskNumberFrom(title, firstMessage) {
	for (const candidate of [title, firstMessage]) {
		const match = TASK_NUMBER_RE.exec(String(candidate ?? ""));
		if (!match) continue;
		const number = Number(match[1]);
		if (Number.isSafeInteger(number) && number > 0) return number;
	}
	return undefined;
}

/** `titleInput` state schema version this reader understands. */
const TITLE_INPUT_STATE_VERSION = 3;

/**
 * Read the stored `titleInput` checkpoint row — the first user message — for an
 * already-identified session record.
 *
 * `cachedSnapshot` cannot serve it: that path only exposes projections
 * registered with a `wire` view, and `titleInput` deliberately has none. The
 * service's own identity-checked `recordFor` does hand back the whole stored
 * record, so the row is read from there, gated on the schema version this
 * reader knows.
 * @param {object} service - sessionProjectionCache.
 * @param {object} header - the session's listing header (the row id).
 * @param {object} witness - normalized identity witness (`isSeeded: false`).
 * @returns {string|undefined} opening message, or undefined.
 */
function firstMessageFromRecord(service, header, witness) {
	if (typeof service.recordFor !== "function") return undefined;
	const expected = {
		createdAt: header.createdAt,
		...(header.cwd === undefined ? {} : { cwd: header.cwd }),
		isSeeded: witness.isSeeded,
		inheritedEventCount: 0,
	};
	const record = service.recordFor(header.id, expected);
	const row = record?.rows?.titleInput;
	if (!row || row.ver !== TITLE_INPUT_STATE_VERSION) return undefined;
	const text = row.val?.first?.text;
	return typeof text === "string" && text.trim() ? text : undefined;
}

/**
 * Build a `firstMessage(header) -> string|undefined` reader over the host's
 * projection cache. That cache carries the folded `titleInput` projection — the
 * first user message — for every session the harness has checkpointed, and the
 * read is a synchronous in-memory lookup, so it costs one map access per session
 * instead of decompressing a session log.
 *
 * Everything about it is optional and fail-safe: without the service, without a
 * stored row, or on any shape surprise the reader answers `undefined` and the
 * chat simply gets no reference-derived badge. Seeded lifecycles (forks carrying
 * an inherited prefix) are skipped, because a listing header alone is not an
 * unambiguous identity witness for them.
 *
 * @param {object|(() => object|undefined)|undefined} cache - `sessionProjectionCache`, or a getter.
 * @param {object} [options]
 * @param {(message: string) => void} [options.warn] - sink for a one-off usability warning.
 * @returns {(header: object) => string|undefined} reader.
 */
export function createFirstMessageReader(cache, options = {}) {
	const warn = typeof options.warn === "function" ? options.warn : () => {};
	const resolve = typeof cache === "function" ? cache : () => cache;
	let warned = false;
	const warnOnce = (message) => {
		if (warned) return;
		warned = true;
		warn(message);
	};
	/** Live counters, surfaced by `?debug=1` when the reader misbehaves. */
	const stats = {
		service: null,
		calls: 0,
		messages: 0,
		noRecord: 0,
		emptyView: 0,
		noFirst: 0,
		seeded: 0,
		lastError: null,
		probe: null,
	};
	const read = (header) => {
		stats.calls += 1;
		if (!header || typeof header !== "object") return undefined;
		if (header.isSeeded === true) {
			stats.seeded += 1;
			return undefined;
		}
		try {
			const service = resolve();
			stats.service = Boolean(service && typeof service.cachedSnapshot === "function");
			if (!stats.service) {
				warnOnce(
					"pr-badge: no sessionProjectionCache service; pull-request references stay hidden",
				);
				return undefined;
			}
			// The cache matches a stored record on `(createdAt, cwd, isSeeded,
			// inheritedEventCount)` and compares `isSeeded` strictly, while a listing
			// header simply omits the field when it is false. Normalize the witness to
			// the stored shape, and use the zero-length inherited prefix an unseeded
			// lifecycle has — the same witness the harness itself passes for a listed
			// header.
			const witness = { ...header, isSeeded: false };
			// `cachedSnapshot` only serves projections registered with a `wire` view,
			// and `titleInput` has none — so the stored row is read directly. The
			// record lookup itself is the service's own identity-checked read.
			const fromRecord = firstMessageFromRecord(service, header, witness);
			if (fromRecord !== undefined) {
				stats.messages += 1;
				return fromRecord;
			}
			const snapshot = service.cachedSnapshot(witness, 0, ["titleInput"]);
			const first = snapshot?.values?.titleInput?.first;
			if (typeof first?.text === "string" && first.text.trim()) {
				stats.messages += 1;
				return first.text;
			}
			stats.noRecord += 1;
			if (stats.probe === null) {
				// One-off discriminator: does *any* projection resolve for this
				// session? Separates a record-identity miss from a row-version miss.
				const other = service.cachedSnapshot(witness, 0, ["title"]);
				stats.probe =
					other === undefined
						? `no-record cwd=${JSON.stringify(header.cwd)} createdAt=${JSON.stringify(header.createdAt)}`
						: `record-ok:${JSON.stringify(other.values ?? null).slice(0, 60)}`;
			}
			return undefined;
		} catch (error) {
			stats.lastError = String(error?.message ?? error);
			warnOnce(`pr-badge: opening messages unavailable: ${error?.message ?? error}`);
			return undefined;
		}
	};
	read.stats = stats;
	return read;
}

/**
 * Normalize a raw `gh pr view` JSON payload; unknown shapes become null.
 * @param {unknown} view - parsed JSON.
 * @returns {object|null} normalized view.
 */
export function normalizePrView(view) {
	if (!view || typeof view !== "object") return null;
	return {
		number: typeof view.number === "number" ? view.number : null,
		url: typeof view.url === "string" ? view.url : null,
		state: String(view.state ?? "").toUpperCase(),
		isDraft: view.isDraft === true,
		reviewDecision: String(view.reviewDecision ?? "").toUpperCase(),
		mergeable: String(view.mergeable ?? "").toUpperCase(),
		mergeStateStatus: String(view.mergeStateStatus ?? "").toUpperCase(),
		statusCheckRollup: Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : [],
	};
}

/** GitLab merge-request states on the badge's vocabulary. */
const GITLAB_STATES = { opened: "OPEN", merged: "MERGED", closed: "CLOSED" };

/** GitLab pipeline statuses on the check-rollup vocabulary. */
const GITLAB_PIPELINE_CONCLUSIONS = {
	success: "SUCCESS",
	failed: "FAILURE",
	canceled: "CANCELLED",
	skipped: "SKIPPED",
	manual: "PENDING",
	running: "PENDING",
	pending: "PENDING",
	created: "PENDING",
	preparing: "PENDING",
	waiting_for_resource: "PENDING",
	scheduled: "PENDING",
};

/**
 * Normalize a GitLab merge request (`glab api` JSON) onto the same view shape
 * `gh pr view` produces, so one badge deriver serves both forges.
 * @param {unknown} mr - one GitLab merge-request object.
 * @returns {object|null} normalized view.
 */
export function normalizeGitlabMr(mr) {
	if (!mr || typeof mr !== "object") return null;
	const state = GITLAB_STATES[String(mr.state ?? "").toLowerCase()];
	if (!state) return null;
	const mergeStatus = String(mr.detailed_merge_status ?? mr.merge_status ?? "").toLowerCase();
	const conflicts =
		mr.has_conflicts === true || mergeStatus === "conflict" || mergeStatus === "cannot_be_merged";
	const pipelineStatus = String(mr.head_pipeline?.status ?? mr.pipeline?.status ?? "").toLowerCase();
	const conclusion = GITLAB_PIPELINE_CONCLUSIONS[pipelineStatus];
	return {
		number: typeof mr.iid === "number" ? mr.iid : null,
		url: typeof mr.web_url === "string" ? mr.web_url : null,
		state,
		isDraft: mr.draft === true,
		reviewDecision: "",
		mergeable: conflicts ? "CONFLICTING" : "MERGEABLE",
		mergeStateStatus: "",
		statusCheckRollup: conclusion ? [{ name: "pipeline", conclusion }] : [],
	};
}

/** Pull a display title out of a tolerant set of session/observation shapes. */
function titleText(value, depth = 0) {
	if (typeof value === "string") return value.trim() ? value.trim() : undefined;
	if (!value || typeof value !== "object" || depth > 3) return undefined;
	for (const key of ["title", "displayTitle", "name"]) {
		const picked = titleText(value[key], depth + 1);
		if (picked) return picked;
	}
	return undefined;
}

/** Reject delegation bookkeeping: subagent sessions never get a sidebar row. */
function isRootSession(header) {
	if (!header || typeof header !== "object") return false;
	if (header.origin === "subagent") return false;
	if (header.parentSession !== undefined && header.parentSession !== null) return false;
	if (Number(header.delegationDepth) > 0) return false;
	return true;
}

/**
 * Build the `listSessions() -> [{sessionId, cwd, title, firstMessage}]`
 * dependency from the optional host `sessionQuery` service. `listSessions()`
 * supplies identity, `cwd` and the header; `readTitleSnapshots()` supplies the
 * folded `session/title` text the sidebar renders; an optional
 * `readFirstMessage(header)` supplies the opening user message, from which a
 * chat's pull-request reference is read. A missing title or message is
 * tolerated — the browser half matches rows by session id first and only falls
 * back to titles.
 *
 * The service is resolved on every call, not at construction: this plugin does
 * not declare `sessionQuery` in its `inject` list (the harness may run without
 * it), so at mount time it can still be absent even though it appears moments
 * later. Pass a getter (`() => ctx.get("sessionQuery")`) to stay order-proof.
 * When the service never appears the list stays empty and no badge is painted.
 * @param {object|(() => object|undefined)|undefined} sessionQuery - service, getter or undefined.
 * @param {object} [options]
 * @param {(message: string) => void} [options.warn] - best-effort diagnostics sink.
 * @param {number} [options.maxSessions] - listing cap (default 200).
 * @param {(header: object) => string|undefined} [options.readFirstMessage] - opening-message reader.
 * @returns {() => Promise<Array<{sessionId: string, cwd?: string, title?: string, firstMessage?: string}>>} lister.
 */
export function createSessionLister(sessionQuery, options = {}) {
	const warn = typeof options.warn === "function" ? options.warn : () => {};
	const readFirstMessage =
		typeof options.readFirstMessage === "function" ? options.readFirstMessage : undefined;
	const maxSessions =
		typeof options.maxSessions === "number" && options.maxSessions > 0
			? Math.floor(options.maxSessions)
			: DEFAULT_MAX_SESSIONS;
	const resolveService = typeof sessionQuery === "function" ? sessionQuery : () => sessionQuery;
	let warned = false;

	return async () => {
		const service = resolveService();
		if (!service || typeof service.listSessions !== "function") {
			if (!warned) {
				warned = true;
				warn("pr-badge: no usable sessionQuery service; sidebar PR badges stay hidden");
			}
			return [];
		}
		const records = await service.listSessions();
		const byId = new Map();
		for (const record of Array.isArray(records) ? records : []) {
			if (byId.size >= maxSessions) break;
			const header = record && typeof record === "object" ? record.header ?? record : undefined;
			const sessionId = header && typeof header.id === "string" ? header.id : undefined;
			if (!sessionId || byId.has(sessionId)) continue;
			if (!isRootSession(header)) continue;
			byId.set(sessionId, {
				sessionId,
				header,
				cwd: typeof header.cwd === "string" && header.cwd ? header.cwd : undefined,
				title: undefined,
				firstMessage: undefined,
			});
		}
		if (readFirstMessage) {
			for (const session of byId.values()) {
				try {
					session.firstMessage = readFirstMessage(session.header);
				} catch {
					/* a projection miss never becomes a badge */
				}
			}
		}
		if (typeof service.readTitleSnapshots === "function" && byId.size > 0) {
			try {
				const observations = await service.readTitleSnapshots([...byId.keys()]);
				for (const observation of Array.isArray(observations) ? observations : []) {
					if (!observation || observation.status === "rejected") continue;
					const target =
						typeof observation.sessionId === "string"
							? byId.get(observation.sessionId)
							: undefined;
					if (!target) continue;
					const title =
						titleText(observation.value?.title) ??
						titleText(observation.value?.session) ??
						titleText(observation);
					if (title) target.title = title;
				}
			} catch (error) {
				warn(`pr-badge: session titles unavailable: ${error?.message ?? error}`);
			}
		}
		return [...byId.values()].map((session) => ({
			sessionId: session.sessionId,
			cwd: session.cwd,
			title: session.title,
			firstMessage: session.firstMessage,
		}));
	};
}

/** Promise semaphore: at most `limit` jobs in flight, FIFO for the rest. */
function createLimiter(limit) {
	let active = 0;
	const queue = [];
	const pump = () => {
		while (active < limit && queue.length > 0) {
			const job = queue.shift();
			active += 1;
			job.run().then(job.resolve, job.reject).finally(() => {
				active -= 1;
				pump();
			});
		}
	};
	return (run) =>
		new Promise((resolve, reject) => {
			queue.push({ run, resolve, reject });
			pump();
		});
}

function positiveInt(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

/**
 * Build the PR-badge controller. Every cordis/service dependency is injected so
 * the whole data path can run in tests against stubbed processes.
 *
 * @param {object} deps
 * @param {(spec: object) => object} deps.spawn - ctx.subprocess.spawn.
 * @param {(command: string) => Promise<string>} deps.resolveExecutable - ctx.subprocess.resolveExecutable.
 * @param {(ids: string[]) => Promise<Array<{sessionId: string, title: string}>>} [deps.listSessions]
 *   - session corpus lister (absent -> empty feed); each entry may carry a
 *     `firstMessage`, the opening user message a PR reference is read from.
 * @param {string} [deps.ghPath] - explicit `gh` binary instead of PATH resolution.
 * @param {number} [deps.gitTimeoutMs] - budget for one git call (default 10 s).
 * @param {number} [deps.ghTimeoutMs] - budget for one `gh pr view` (default 15 s).
 * @param {number} [deps.locationTtlMs] - cwd -> root/branch cache TTL (default 30 s).
 * @param {number} [deps.bindingsTtlMs] - worktree-bindings cache TTL (default 15 s).
 * @param {number} [deps.sessionsTtlMs] - session listing cache TTL (default 15 s).
 * @param {number} [deps.openTtlMs] - PR cache TTL while OPEN (default 60 s).
 * @param {number} [deps.terminalTtlMs] - PR cache TTL once MERGED/CLOSED (default 10 min).
 * @param {number} [deps.absentTtlMs] - "no PR on this branch" cache TTL (default 2 min).
 * @param {number} [deps.errorTtlMs] - failure cache TTL (default 30 s).
 * @param {number} [deps.maxConcurrency] - concurrent git/gh processes (default 3).
 * @param {string[]} [deps.skipBranches] - integration branches to ignore.
 * @param {boolean} [deps.references] - read a PR reference out of a session's opening message (default true).
 * @param {boolean} [deps.debug] - accept `?debug=1` diagnostics payloads.
 * @param {(message: string) => void} [deps.warn] - sink for best-effort failures.
 * @returns {object} controller face used by `apply` and the host test suite.
 */
export function createPrBadge(deps) {
	const spawn = deps.spawn;
	const resolveExecutable = deps.resolveExecutable;
	const listSessions =
		typeof deps.listSessions === "function" ? deps.listSessions : async () => [];
	const warn = typeof deps.warn === "function" ? deps.warn : () => {};
	const ghPath = typeof deps.ghPath === "string" && deps.ghPath ? deps.ghPath : undefined;
	const gitTimeoutMs = positiveInt(deps.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS);
	const ghTimeoutMs = positiveInt(deps.ghTimeoutMs, DEFAULT_GH_TIMEOUT_MS);
	const locationTtlMs = positiveInt(deps.locationTtlMs, DEFAULT_LOCATION_TTL_MS);
	const sessionsTtlMs = positiveInt(deps.sessionsTtlMs, DEFAULT_SESSIONS_TTL_MS);
	const openTtlMs = positiveInt(deps.openTtlMs, DEFAULT_OPEN_TTL_MS);
	const terminalTtlMs = positiveInt(deps.terminalTtlMs, DEFAULT_TERMINAL_TTL_MS);
	const absentTtlMs = positiveInt(deps.absentTtlMs, DEFAULT_ABSENT_TTL_MS);
	const errorTtlMs = positiveInt(deps.errorTtlMs, DEFAULT_ERROR_TTL_MS);
	const maxConcurrency = positiveInt(deps.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
	const bindingsTtlMs = positiveInt(deps.bindingsTtlMs, DEFAULT_BINDINGS_TTL_MS);
	const debugEnabled = deps.debug === true;
	const references = deps.references !== false;
	const forcedForge =
		deps.forge === "github" || deps.forge === "gitlab" ? deps.forge : undefined;
	const readerStats = typeof deps.readerStats === "function" ? deps.readerStats : undefined;
	const skipBranches =
		Array.isArray(deps.skipBranches) && deps.skipBranches.length > 0
			? new Set(deps.skipBranches.map((branch) => String(branch).toLowerCase()))
			: SKIPPED_BRANCHES;

	const limit = createLimiter(maxConcurrency);

	/** Resolved-binary cache keyed by kind ("git" | "gh"); failures retry. */
	const executables = new Map();
	async function executable(kind) {
		if (!executables.has(kind)) {
			executables.set(
				kind,
				resolveExecutable(kind === "gh" && ghPath ? ghPath : kind).catch((error) => {
					executables.delete(kind);
					throw error;
				}),
			);
		}
		return executables.get(kind);
	}

	async function runProc(kind, argv, options = {}) {
		const bin = await executable(kind);
		const handle = spawn({
			argv: [bin, ...argv],
			cwd: options.cwd,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: 256 * 1024 },
				stderr: { maxBytes: 64 * 1024 },
			},
			graceMs: 1_000,
		});
		const timeoutMs = options.timeoutMs;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			handle.terminate();
		}, timeoutMs);
		let outcome;
		try {
			outcome = await handle.done;
		} finally {
			clearTimeout(timer);
		}
		if (timedOut) throw new Error(`${kind} ${argv[0]} timed out after ${timeoutMs}ms`);
		const readAll = (stream) => {
			const reader = handle.collected?.[stream];
			return reader ? reader.readFrom(0).text : "";
		};
		return {
			code: typeof outcome?.exitCode === "number" ? outcome.exitCode : 1,
			out: readAll("stdout").trim(),
			err: readAll("stderr").trim(),
		};
	}

	// ------------------------------------------------------------ gh readiness

	/** Forge -> command-line client, and the tri-state probe of its presence. */
	const FORGE_BINARIES = { github: "gh", gitlab: "glab" };
	const forgeProbes = {
		github: { state: "unknown", at: 0 },
		gitlab: { state: "unknown", at: 0 },
	};

	async function forgeReady(forge) {
		const probe = forgeProbes[forge];
		const binary = FORGE_BINARIES[forge];
		const now = Date.now();
		if (probe.state === "available") return true;
		if (probe.state === "missing" && now - probe.at < GH_PROBE_RETRY_MS) return false;
		try {
			await executable(binary);
			probe.state = "available";
			probe.at = now;
			return true;
		} catch {
			probe.state = "missing";
			probe.at = now;
			warn(
				`pr-badge: ${binary} is unavailable; sidebar badges for ${forge} repositories stay hidden`,
			);
			return false;
		}
	}

	// ------------------------------------------------------- location & PR data

	/** Worktree bindings live in this fixed location inside a repository. */
	const BINDINGS_PARTS = [".dsh", "worktrees", "bindings.json"];

	/** cwd -> {at, value:{root, branch}|null}; shared by every session in it. */
	const locationCache = new Map();
	/** repo top -> {at, map: Map<sessionId, {branch, path, root, createdAt}>}. */
	const bindingsCache = new Map();
	/** worktree path -> main repository root (or null). */
	const mainRootCache = new Map();

	/**
	 * Main repository root for a (possibly worktree) top: the parent of the
	 * shared git directory. Used only when the bindings file is missing at the
	 * checkout itself, so a session whose cwd sits inside a worktree still finds
	 * the repository's binding registry.
	 * @param {string} top - `git rev-parse --show-toplevel` result.
	 * @returns {Promise<string|null>} main repository root, when resolvable.
	 */
	async function mainRootOf(top) {
		if (mainRootCache.has(top)) return mainRootCache.get(top);
		let root = null;
		try {
			const common = await limit(() =>
				runProc("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
					cwd: top,
					timeoutMs: gitTimeoutMs,
				}),
			);
			const dir = common.code === 0 ? common.out.split("\n")[0].trim() : "";
			// `<repo>/.git` -> `<repo>`; bare repositories and older git answer null.
			if (dir && (dir.endsWith("/.git") || dir.endsWith("\\.git"))) root = dirname(dir);
		} catch {
			/* older git: no main-root refinement */
		}
		mainRootCache.set(top, root);
		if (mainRootCache.size > MAX_CACHE_ENTRIES) mainRootCache.clear();
		return root;
	}

	/**
	 * Session -> worktree-branch registry written by
	 * `@dsh-plugins/worktree-launcher`. A missing, unreadable or foreign file is
	 * normal (the plugin may not be installed): the caller then falls back to the
	 * branch the session's own cwd sits on.
	 * @param {string} top - repository top of the session cwd.
	 * @returns {Promise<Map<string, {branch: string, path?: string, root?: string}>>} registry.
	 */
	async function bindingsForRoot(top) {
		const cached = bindingsCache.get(top);
		if (cached && Date.now() - cached.at < bindingsTtlMs) return cached.map;
		const files = [join(top, ...BINDINGS_PARTS)];
		const mainRoot = await mainRootOf(top);
		if (mainRoot && mainRoot !== top) files.push(join(mainRoot, ...BINDINGS_PARTS));
		const map = new Map();
		for (const file of files) {
			let parsed;
			try {
				parsed = JSON.parse(await readFile(file, "utf8"));
			} catch {
				continue;
			}
			const list = Array.isArray(parsed?.bindings) ? parsed.bindings : [];
			for (const binding of list) {
				if (!binding || typeof binding !== "object") continue;
				const sessionId = binding.sessionId;
				const branch = binding.branch;
				if (typeof sessionId !== "string" || typeof branch !== "string" || !branch) continue;
				const previous = map.get(sessionId);
				// A session can be rebound; the newest registration wins.
				if (previous && Number(previous.createdAt) >= Number(binding.createdAt)) continue;
				map.set(sessionId, {
					branch,
					path: typeof binding.path === "string" ? binding.path : undefined,
					root: typeof binding.root === "string" ? binding.root : undefined,
					createdAt: binding.createdAt,
				});
			}
		}
		bindingsCache.set(top, { at: Date.now(), map });
		if (bindingsCache.size > MAX_CACHE_ENTRIES) bindingsCache.clear();
		return map;
	}

	/**
	 * Resolve one session's effective branch. A worktree binding wins over the
	 * branch the session's cwd happens to sit on; without one, integration
	 * branches and detached HEADs return a `skipped` marker so the caller can
	 * report *why* a chat carries no badge.
	 *
	 * The git half is cached per cwd and shared by every session sitting in the
	 * same directory (several chats usually share one repository root); only the
	 * binding decision is per session.
	 * @param {string} cwd - session working directory.
	 * @param {string} [sessionId] - session identity (binding lookup key).
	 * @returns {Promise<{root: string, branch: string, source: string, worktree?: string|null, skipped?: string}|null>} location.
	 */
	async function locationFor(cwd, sessionId) {
		const facts = await gitFacts(cwd);
		if (!facts) return null;
		const binding =
			typeof sessionId === "string" ? (await bindingsForRoot(facts.root)).get(sessionId) : undefined;
		if (binding && !skipBranches.has(binding.branch.toLowerCase())) {
			return {
				root: facts.root,
				branch: binding.branch,
				source: "binding",
				remote: facts.remote,
				worktree: binding.path ?? null,
			};
		}
		const branch = facts.branch;
		if (!branch) return null;
		const lowered = branch.toLowerCase();
		if (lowered === "head") {
			return { root: facts.root, branch, source: "cwd", remote: facts.remote, skipped: "detached-head" };
		}
		if (skipBranches.has(lowered)) {
			return { root: facts.root, branch, source: "cwd", remote: facts.remote, skipped: "base-branch" };
		}
		return { root: facts.root, branch, source: "cwd", remote: facts.remote };
	}

	/** cwd -> {at, value:{root, branch}|null}. */
	const gitFactsCache = new Map();
	/** cwd -> in-flight git resolution. */
	const gitFactsInFlight = new Map();

	async function gitFacts(cwd) {
		const cached = gitFactsCache.get(cwd);
		if (cached && Date.now() - cached.at < locationTtlMs) return cached.value;
		const pending = gitFactsInFlight.get(cwd);
		if (pending) return pending;
		const promise = readGitFacts(cwd).finally(() => {
			if (gitFactsInFlight.get(cwd) === promise) gitFactsInFlight.delete(cwd);
		});
		gitFactsInFlight.set(cwd, promise);
		return promise;
	}

	/**
	 * The repository's primary remote, read once per cwd alongside the branch.
	 * `git config` returns every configured URL in one call, so a repository
	 * whose first remote is not `origin` still resolves its forge.
	 * @param {string} root - repository top.
	 * @returns {Promise<{host: string, path: string}|null>} parsed remote.
	 */
	async function readRemote(root) {
		const result = await limit(() =>
			runProc("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], {
				cwd: root,
				timeoutMs: gitTimeoutMs,
			}),
		);
		if (result.code !== 0 || !result.out) return null;
		const remotes = [];
		for (const line of result.out.split("\n")) {
			const match = /^remote\.([^.]+)\.url\s+(.+)$/.exec(line.trim());
			if (match) remotes.push({ name: match[1], url: match[2] });
		}
		const origin = remotes.find((remote) => remote.name === "origin") ?? remotes[0];
		return origin ? parseRemoteUrl(origin.url) : null;
	}

	async function readGitFacts(cwd) {
		let value = null;
		try {
			const top = await limit(() =>
				runProc("git", ["rev-parse", "--show-toplevel"], {
					cwd,
					timeoutMs: gitTimeoutMs,
				}),
			);
			const root = top.code === 0 && top.out ? top.out.split("\n")[0].trim() : "";
			if (root) {
				const head = await limit(() =>
					runProc("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
						cwd: root,
						timeoutMs: gitTimeoutMs,
					}),
				);
				const branch = head.code === 0 ? head.out.split("\n")[0].trim() : "";
				if (branch) value = { root, branch, remote: await readRemote(root) };
			}
		} catch (error) {
			warn(`pr-badge: git lookup failed in ${cwd}: ${error?.message ?? error}`);
		}
		gitFactsCache.set(cwd, { at: Date.now(), value });
		if (gitFactsCache.size > MAX_CACHE_ENTRIES) gitFactsCache.clear();
		return value;
	}

	/** root+branch -> {at, ttl, value:{pr, reason, ttl}}. */
	const prCache = new Map();
	/** root+branch -> in-flight probe (many chats usually share one branch). */
	const prInFlight = new Map();

	/**
	 * One uncached `gh pr view` probe.
	 * @param {string} root - repository top (command cwd).
	 * @param {string} selector - branch name, PR number or PR URL.
	 * @returns {Promise<{pr: object|null, reason: string, ttl: number}>} probe result.
	 */
	async function probePr(root, selector) {
		if (!(await forgeReady("github"))) return { pr: null, reason: "gh-missing", ttl: errorTtlMs };
		let result;
		try {
			result = await runProc("gh", ["pr", "view", selector, "--json", PR_JSON_FIELDS], {
				cwd: root,
				timeoutMs: ghTimeoutMs,
			});
		} catch (error) {
			warn(`pr-badge: gh pr view failed for ${selector}: ${error?.message ?? error}`);
			return { pr: null, reason: "gh-error", ttl: errorTtlMs };
		}
		if (result.code !== 0) {
			const message = oneLine(result.err);
			// `gh pr view` exits non-zero both for "no PR on this branch" (normal)
			// and for auth/network trouble (worth a warning).
			const absent = /no pull requests? found|could not resolve to a pull\s?request/i.test(
				message,
			);
			if (!absent) {
				warn(`pr-badge: gh pr view ${selector} exited ${result.code}: ${message}`);
			}
			return {
				pr: null,
				reason: absent ? "no-pr" : "gh-error",
				ttl: absent ? absentTtlMs : errorTtlMs,
			};
		}
		let parsed;
		try {
			parsed = JSON.parse(result.out);
		} catch {
			return { pr: null, reason: "bad-json", ttl: errorTtlMs };
		}
		const pr = normalizePrView(parsed);
		if (!pr) return { pr: null, reason: "bad-json", ttl: errorTtlMs };
		return { pr, reason: "ok", ttl: pr.state === "OPEN" ? openTtlMs : terminalTtlMs };
	}

	/**
	 * Cached forge probe for one repository + selector. Concurrent callers for
	 * the same selector share a single in-flight probe: a sidebar full of chats
	 * on one worktree must not cost one client process per row.
	 * @param {string} root - repository top.
	 * @param {string} cacheKey - namespaced cache key (a branch and a PR number can collide).
	 * @param {() => Promise<{pr: object|null, reason: string, ttl: number}>} probe - uncached lookup.
	 * @returns {Promise<{pr: object|null, reason: string, ttl: number}>} probe result.
	 */
	async function prForSelector(root, cacheKey, probe) {
		const key = `${root}\u0000${cacheKey}`;
		const cached = prCache.get(key);
		if (cached && Date.now() - cached.at < cached.ttl) return cached.value;
		const pending = prInFlight.get(key);
		if (pending) return pending;
		const promise = limit(probe)
			.then((value) => {
				prCache.set(key, { at: Date.now(), ttl: value.ttl, value });
				if (prCache.size > MAX_CACHE_ENTRIES) prCache.clear();
				return value;
			})
			.finally(() => {
				if (prInFlight.get(key) === promise) prInFlight.delete(key);
			});
		prInFlight.set(key, promise);
		return promise;
	}

	// ----------------------------------------------------------------- GitLab

	/**
	 * One `glab api` call, parsed. `glab` reports failures on stderr with a
	 * non-zero exit, and some 4xx answers still exit zero with a JSON
	 * `{"message": …}` body — both are errors here.
	 * @param {string} root - command cwd (repository top).
	 * @param {string} endpoint - API path with its query string.
	 * @returns {Promise<unknown>} parsed JSON.
	 */
	async function glabApi(root, endpoint) {
		const result = await runProc("glab", ["api", endpoint], { cwd: root, timeoutMs: ghTimeoutMs });
		let parsed;
		try {
			parsed = result.out ? JSON.parse(result.out) : undefined;
		} catch {
			parsed = undefined;
		}
		if (result.code !== 0) {
			throw new Error(oneLine(result.err) || oneLine(result.out) || `glab exited ${result.code}`);
		}
		if (parsed && !Array.isArray(parsed) && typeof parsed.message === "string") {
			throw new Error(oneLine(parsed.message));
		}
		return parsed;
	}

	/**
	 * The merge request a list of candidates should surface: open first, then
	 * merged, then closed, newest first within a rank.
	 * @param {Array<object>} list - raw GitLab merge requests.
	 * @returns {object|undefined} chosen merge request.
	 */
	function latestMergeRequest(list) {
		const rank = (mr) =>
			({ opened: 0, merged: 1, closed: 2 })[String(mr?.state ?? "").toLowerCase()] ?? 3;
		const usable = list.filter((mr) => mr && typeof mr.iid === "number" && rank(mr) < 3);
		usable.sort(
			(a, b) =>
				rank(a) - rank(b) ||
				(Date.parse(b.updated_at ?? "") || 0) - (Date.parse(a.updated_at ?? "") || 0),
		);
		return usable[0];
	}

	/**
	 * One GitLab lookup. `select` maps the raw payload onto a merge request: an
	 * object (found), `undefined` (none) or `null` (unexpected payload).
	 * @param {string} root - repository top.
	 * @param {string} endpoint - `glab api` path.
	 * @param {(payload: unknown) => object|null|undefined} select - payload picker.
	 * @returns {Promise<{pr: object|null, reason: string, ttl: number}>} probe result.
	 */
	async function probeGitlab(root, endpoint, select) {
		if (!(await forgeReady("gitlab"))) return { pr: null, reason: "glab-missing", ttl: errorTtlMs };
		let payload;
		try {
			payload = await glabApi(root, endpoint);
		} catch (error) {
			warn(`pr-badge: glab api ${endpoint.split("?")[0]} failed: ${error?.message ?? error}`);
			return { pr: null, reason: "glab-error", ttl: errorTtlMs };
		}
		const picked = select(payload);
		if (picked === null) return { pr: null, reason: "glab-error", ttl: errorTtlMs };
		if (picked === undefined) return { pr: null, reason: "no-pr", ttl: absentTtlMs };
		const pr = normalizeGitlabMr(picked);
		if (!pr) return { pr: null, reason: "bad-json", ttl: errorTtlMs };
		return { pr, reason: "ok", ttl: pr.state === "OPEN" ? openTtlMs : terminalTtlMs };
	}

	/** The merge request of one source branch. */
	function probeGitlabBranch(root, project, branch) {
		const query = `state=all&source_branch=${encodeURIComponent(branch)}&order_by=updated_at&sort=desc&per_page=10`;
		return probeGitlab(
			root,
			`projects/${encodeURIComponent(project)}/merge_requests?${query}`,
			(payload) =>
				Array.isArray(payload)
					? latestMergeRequest(payload.filter((mr) => mr?.source_branch === branch))
					: null,
		);
	}

	/** One merge request named by number in a session's opening message. */
	function probeGitlabMergeRequest(root, project, number) {
		return probeGitlab(
			root,
			`projects/${encodeURIComponent(project)}/merge_requests/${number}`,
			(payload) => (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null),
		);
	}

	/**
	 * The merge request that names a tracker id: its branch usually carries it
	 * (`v2-41468`) and its title almost always does (`#41468 …`).
	 * @param {string} root - repository top.
	 * @param {string} project - GitLab project path.
	 * @param {number} taskNumber - tracker id.
	 */
	function probeGitlabTask(root, project, taskNumber) {
		const query = `state=all&search=${taskNumber}&order_by=updated_at&sort=desc&per_page=20`;
		const named = new RegExp(`(^|[^0-9])${taskNumber}([^0-9]|$)`);
		return probeGitlab(
			root,
			`projects/${encodeURIComponent(project)}/merge_requests?${query}`,
			(payload) =>
				Array.isArray(payload)
					? latestMergeRequest(
							payload.filter(
								(mr) =>
									named.test(String(mr?.source_branch ?? "")) ||
									named.test(String(mr?.title ?? "")),
							),
						)
					: null,
		);
	}

	/** Probe the merge/pull request a branch belongs to. */
	function prForBranch(root, branch, forge, remote) {
		if (forge === "gitlab") {
			if (!remote) return Promise.resolve({ pr: null, reason: "no-remote", ttl: errorTtlMs });
			return prForSelector(root, `branch:${branch}`, () =>
				probeGitlabBranch(root, remote.path, branch),
			);
		}
		return prForSelector(root, `branch:${branch}`, () => probePr(root, branch));
	}

	/** Probe a request named by number or URL in a session's opening message. */
	function prForReference(root, reference, forge, remote) {
		if (forge === "gitlab") {
			if (!remote) return Promise.resolve({ pr: null, reason: "no-remote", ttl: errorTtlMs });
			return prForSelector(root, `pr:${reference.number}`, () =>
				probeGitlabMergeRequest(root, remote.path, reference.number),
			);
		}
		return prForSelector(root, `pr:${reference.number}`, () =>
			probePr(root, reference.href ?? String(reference.number)),
		);
	}

	/** Probe the merge request that carries a tracker id. */
	function prForTask(root, remote, taskNumber) {
		return prForSelector(root, `task:${taskNumber}`, () =>
			probeGitlabTask(root, remote.path, taskNumber),
		);
	}

	// ------------------------------------------------------------- session feed

	/** Cached session listing: the corpus read is not free, the poll is cheap. */
	let sessionsCache = { at: 0, value: [] };

	async function sessionEntries() {
		const now = Date.now();
		if (now - sessionsCache.at < sessionsTtlMs) return sessionsCache.value;
		try {
			const value = await listSessions();
			sessionsCache = { at: now, value: Array.isArray(value) ? value : [] };
			return sessionsCache.value;
		} catch (error) {
			warn(`pr-badge: session listing failed: ${error?.message ?? error}`);
			return sessionsCache.at ? sessionsCache.value : [];
		}
	}

	/** One feed entry (or nothing) plus the diagnostic row for `?debug=1`. */
	async function resolveSession(session) {
		const diagnostic = {
			sessionId: session.sessionId,
			title: session.title ?? null,
			cwd: session.cwd ?? null,
			firstMessage: session.firstMessage ? session.firstMessage.slice(0, 120) : null,
			root: null,
			branch: null,
			source: null,
			reason: "no-cwd",
		};
		const empty = { entry: null, diagnostic };
		if (!session.cwd) return empty;
		const located = await locationFor(session.cwd, session.sessionId);
		if (!located) {
			diagnostic.reason = "not-a-repository";
			return empty;
		}
		diagnostic.root = located.root;
		diagnostic.branch = located.branch;
		diagnostic.source = located.source;
		const remote = located.remote ?? null;
		const forge = forgeOf(remote, forcedForge);
		diagnostic.forge = forge;
		const canProbe = forge !== "gitlab" || remote !== null;

		// Candidate sources, strongest first. A chat that was moved into its own
		// worktree owns that branch outright; failing that, the pull request it
		// names in its opening message is its subject; the branch of the directory
		// it sits in is the weakest signal, because a shared checkout reports the
		// same branch for every chat that happens to live there. On GitLab a chat
		// whose branches carry no merge request — the usual shape of an isolated
		// worktree branch — is matched by the tracker id its title opens with.
		const attempts = [];
		if (!located.skipped && located.source === "binding") {
			attempts.push({
				kind: "binding",
				run: () => prForBranch(located.root, located.branch, forge, remote),
			});
		}
		const reference = references ? prReferenceFrom(session.firstMessage) : null;
		if (reference) {
			attempts.push({
				kind: "reference",
				reference,
				run: () => prForReference(located.root, reference, forge, remote),
			});
		}
		if (!located.skipped && located.source !== "binding") {
			attempts.push({
				kind: "cwd",
				run: () => prForBranch(located.root, located.branch, forge, remote),
			});
		}
		const taskNumber =
			canProbe && forge === "gitlab" && remote
				? taskNumberFrom(session.title, session.firstMessage)
				: undefined;
		if (taskNumber !== undefined) {
			attempts.push({
				kind: "task",
				task: taskNumber,
				run: () => prForTask(located.root, remote, taskNumber),
			});
		}

		let probe = null;
		let chosen = null;
		for (const attempt of attempts) {
			const result = await attempt.run();
			diagnostic.reason = result.reason;
			if (result.pr) {
				probe = result;
				chosen = attempt;
				break;
			}
		}
		if (!probe?.pr) {
			if (!canProbe) diagnostic.reason = "no-remote";
			else if (attempts.length === 0 && located.skipped) diagnostic.reason = located.skipped;
			return empty;
		}
		diagnostic.source = chosen.kind;
		const badge = derivePrBadge(probe.pr);
		if (!badge) {
			diagnostic.reason = "unknown-state";
			return empty;
		}
		const referenced = chosen.kind === "reference" || chosen.kind === "task";
		return {
			entry: {
				sessionId: session.sessionId,
				title: session.title ?? null,
				branch: referenced ? null : located.branch,
				root: located.root,
				source: chosen.kind,
				worktree: chosen.kind === "binding" ? located.worktree ?? null : null,
				reference: chosen.kind === "reference" ? `#${chosen.reference.number}` : null,
				task: chosen.kind === "task" ? chosen.task : null,
				forge,
				repo:
					(forge === "gitlab" ? parseMergeRequestRepo(probe.pr.url) : parseRepoSlug(probe.pr.url)) ??
					remote?.path ??
					null,
				number: probe.pr.number,
				url: probe.pr.url,
				state: probe.pr.state,
				color: badge.color,
				reason: badge.reason,
			},
			diagnostic,
		};
	}

	let feedInFlight = null;

	/**
	 * The whole feed: one entry per session that has a pull request — its own
	 * (the branch of its worktree, or of the directory it sits in) or, failing
	 * that, the one its opening message names. Sessions without a resolvable
	 * repository, on an integration branch without a reference, or without any PR
	 * are simply absent — the browser half then paints nothing for them.
	 * @param {{debug?: boolean}} [options]
	 * @returns {Promise<{entries: Array<object>, generatedAt: number, diagnostics?: Array<object>}>} feed.
	 */
	async function sessionStates(options = {}) {
		if (feedInFlight) return feedInFlight;
		const promise = (async () => {
			const sessions = await sessionEntries();
			// NOTE: the limiter wraps individual processes only. Wrapping the whole
			// per-session resolution here would nest two acquisitions inside the same
			// semaphore and deadlock as soon as the queue outruns the limit.
			const resolved = await Promise.all(
				sessions.map((session) =>
					resolveSession(session).catch((error) => {
						// One bad session must not take the whole feed down, but it must
						// not vanish silently either.
						warn(
							`pr-badge: session ${session.sessionId} could not be resolved: ${error?.message ?? error}`,
						);
						return { entry: null, diagnostic: null };
					}),
				),
			);
			const entries = [];
			const diagnostics = [];
			for (const item of resolved) {
				if (!item) continue;
				if (item.entry) entries.push(item.entry);
				if (item.diagnostic && options.debug === true) diagnostics.push(item.diagnostic);
			}
			return {
				entries,
				generatedAt: Date.now(),
				...(options.debug === true ? { diagnostics } : {}),
				...(options.debug === true && readerStats ? { reader: readerStats() ?? null } : {}),
			};
		})();
		feedInFlight = promise;
		try {
			return await promise;
		} finally {
			if (feedInFlight === promise) feedInFlight = null;
		}
	}

	// ------------------------------------------------------------------ routing

	function sendJson(res, statusCode, payload) {
		res.writeHead(statusCode, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(JSON.stringify(payload));
	}

	function isLocalHost(req) {
		const raw = req.headers?.host ?? "";
		let hostname = "";
		try {
			hostname = new URL(`http://${raw}`).hostname;
		} catch {
			return false;
		}
		return (
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "[::1]" ||
			hostname === "::1"
		);
	}

	/**
	 * Route body: `GET /pr-badge/api/states[?debug=1]`. No parameters, no body.
	 * @param {object} req - node request.
	 * @param {object} res - node response.
	 */
	async function handle(req, res) {
		if (!isLocalHost(req)) {
			sendJson(res, 403, { error: "pr-badge: local connections only" });
			return;
		}
		let url;
		try {
			url = new URL(req.url ?? "/", "http://invalid.local");
		} catch {
			sendJson(res, 400, { error: "malformed request URL" });
			return;
		}
		const pathname = url.pathname.replace(/\/+$/, "") || "/";
		const method = (req.method ?? "GET").toUpperCase();
		try {
			if (method === "GET" && pathname === `${API_PREFIX}/states`) {
				const debug = debugEnabled && url.searchParams.get("debug") === "1";
				sendJson(res, 200, await sessionStates({ debug }));
				return;
			}
			sendJson(res, 404, { error: `no such pr-badge endpoint: ${method} ${pathname}` });
		} catch (error) {
			sendJson(res, 500, { error: String(error?.message ?? error) });
		}
	}

	function shutdown() {
		gitFactsCache.clear();
		gitFactsInFlight.clear();
		bindingsCache.clear();
		mainRootCache.clear();
		prCache.clear();
		prInFlight.clear();
		executables.clear();
		sessionsCache = { at: 0, value: [] };
		feedInFlight = null;
		for (const probe of Object.values(forgeProbes)) {
			probe.state = "unknown";
			probe.at = 0;
		}
	}

	return {
		handle,
		shutdown,
		sessionStates,
		locationFor,
		prFor: (root, branch) => prForBranch(root, branch, "github", null),
		probePr,
		sessionEntries,
	};
}

/**
 * Cordis plugin body: wire the controller to the harness services and clean up
 * behind the plugin fiber.
 * @param {object} ctx - host cordis context (`webServer` + `subprocess` injected).
 * @param {object} [config] - row config `{ debug?, ghPath?, forge?, gitTimeoutMs?, ghTimeoutMs?, locationTtlMs?, bindingsTtlMs?, sessionsTtlMs?, openTtlMs?, terminalTtlMs?, absentTtlMs?, errorTtlMs?, maxConcurrency?, maxSessions?, skipBranches?, references? }`.
 */
export function apply(ctx, config) {
	const options = config ?? {};
	const warn = options.debug ? (message) => console.warn(message) : undefined;
	const readFirstMessage = createFirstMessageReader(
		() => ctx.get("sessionProjectionCache"),
		{ warn },
	);
	const badge = createPrBadge({
		spawn: (spec) => ctx.subprocess.spawn(spec),
		resolveExecutable: (command) => ctx.subprocess.resolveExecutable(command),
		listSessions: createSessionLister(() => ctx.get("sessionQuery"), {
			warn,
			maxSessions: options.maxSessions,
			readFirstMessage,
		}),
		readerStats: () => readFirstMessage.stats,
		debug: options.debug === true,
		ghPath: typeof options.ghPath === "string" ? options.ghPath : undefined,
		forge: options.forge === "github" || options.forge === "gitlab" ? options.forge : undefined,
		gitTimeoutMs: options.gitTimeoutMs,
		ghTimeoutMs: options.ghTimeoutMs,
		locationTtlMs: options.locationTtlMs,
		bindingsTtlMs: options.bindingsTtlMs,
		sessionsTtlMs: options.sessionsTtlMs,
		openTtlMs: options.openTtlMs,
		terminalTtlMs: options.terminalTtlMs,
		absentTtlMs: options.absentTtlMs,
		errorTtlMs: options.errorTtlMs,
		maxConcurrency: options.maxConcurrency,
		skipBranches: options.skipBranches,
		references: options.references === false ? false : undefined,
		warn,
	});

	const disposeRoute = ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: (req, res) => {
			void badge.handle(req, res);
		},
	});

	ctx.on("dispose", () => {
		disposeRoute();
		badge.shutdown();
	});
}
