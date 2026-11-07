/**
 * @dsh-plugins/pr-badge — host half.
 *
 * One read-only route answers "does the branch behind this Session have a pull
 * request?" for every Session the harness knows about:
 *
 *   GET /pr-badge/api/states  ->  { states: { [sessionId]: { branch, pr } } }
 *
 * The browser never names a repository, a branch, or a command: the Session's
 * own recorded `cwd` is the only input, and the route derives the repository
 * root from it with `git rev-parse`. A pull request is then looked up with the
 * GitHub CLI (`gh pr list --head <branch>`), which reuses the operator's own
 * `gh auth` login — this plugin stores no credentials of its own.
 *
 * Both lookups are cached per repository/branch so a page with fifty Sessions
 * costs at most one `git` and one `gh` invocation per distinct branch per
 * minute. Every failure is local to one Session: a missing repository, a
 * detached HEAD, an unauthenticated `gh`, or a timeout yields `pr: null`
 * without disturbing the rest of the answer.
 */

import { execFile } from "node:child_process";

/** Route prefix owned by this package; the exact path lives under it. */
const ROUTE_PREFIX = "/pr-badge";
/** The one route this package answers. */
const STATES_PATH = "/pr-badge/api/states";
/** How long a resolved repository root stays usable. */
const REPO_TTL_MS = 5 * 60_000;
/** How long one branch's pull-request answer stays usable. */
const PR_TTL_MS = 60_000;
/** Upper bound on Sessions asked about in one request. */
const SESSION_LIMIT = 80;
/** Wall-clock budget for one `git` or `gh` invocation. */
const COMMAND_TIMEOUT_MS = 10_000;
/** Longest branch name worth passing to `gh`. */
const BRANCH_MAX = 200;

/** GitHub pull-request states this plugin reports, in display preference order. */
const PR_STATES = new Set(["OPEN", "DRAFT", "MERGED", "CLOSED"]);

/** Repository root and branch resolved from one directory, or nulls. */
const repoCache = new Map();
/** One branch's pull request, keyed by `<repoRoot>\n<branch>`. */
const prCache = new Map();

/**
 * Run one command without a shell and resolve its trimmed stdout.
 * @param file - executable name.
 * @param args - argument vector; never interpolated.
 * @returns stdout, or null when the command failed or timed out.
 */
function run(file, args) {
	return new Promise((resolve) => {
		execFile(file, args, {
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 4 * 1024 * 1024,
			windowsHide: true,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", NO_COLOR: "1" }
		}, (error, stdout) => {
			if (error) resolve(null);
			else resolve(String(stdout).trim());
		});
	});
}

/**
 * Resolve the repository root and branch for one Session directory.
 * @param cwd - directory recorded in the Session header.
 * @returns `{ root, branch }`, either field possibly null.
 */
async function resolveRepo(cwd) {
	const key = cwd;
	const hit = repoCache.get(key);
	if (hit !== undefined && Date.now() - hit.at < REPO_TTL_MS) return hit.value;

	let value = { root: null, branch: null };
	const root = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
	if (root !== null && root !== "") {
		const branch = await run("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"]);
		value = {
			root,
			branch: branch === null || branch === "" || branch === "HEAD" ? null : branch.slice(0, BRANCH_MAX)
		};
	}
	repoCache.set(key, { at: Date.now(), value });
	return value;
}

/**
 * Keep only the fields the client draws, and only known states.
 * @param raw - parsed `gh pr list` output.
 * @returns the reported pull request, or null.
 */
function reportedPullRequest(raw) {
	const first = Array.isArray(raw) ? raw[0] : undefined;
	if (first === null || typeof first !== "object") return null;
	const { number, state, url, title, isDraft } = first;
	if (!Number.isSafeInteger(number) || number <= 0) return null;
	if (typeof state !== "string" || !PR_STATES.has(state.toUpperCase())) return null;
	if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
	return {
		number,
		state: state.toUpperCase(),
		url,
		title: typeof title === "string" ? title : "",
		draft: isDraft === true
	};
}

/**
 * Look up the pull request whose head is one branch of one repository.
 * @param root - repository root.
 * @param branch - branch name recorded in the Session's checkout.
 * @returns the pull request, or null when there is none or `gh` failed.
 */
async function lookupPullRequest(root, branch) {
	const key = `${root}\n${branch}`;
	const hit = prCache.get(key);
	if (hit !== undefined && Date.now() - hit.at < PR_TTL_MS) return hit.value;

	let value = null;
	const raw = await run("gh", [
		"pr", "list",
		"--head", branch,
		"--state", "all",
		"--limit", "1",
		"--json", "number,state,url,title,isDraft"
	]);
	if (raw !== null && raw !== "" && raw.startsWith("[")) {
		try {
			value = reportedPullRequest(JSON.parse(raw));
		} catch {
			value = null;
		}
	}
	prCache.set(key, { at: Date.now(), value });
	return value;
}

/**
 * Collect one Session's branch and pull request.
 * @param record - the Session record from the harness.
 * @returns the reported state entry.
 */
async function stateOf(record) {
	const sessionId = record?.header?.id;
	const cwd = record?.header?.cwd;
	if (typeof sessionId !== "string" || sessionId === "") return undefined;
	if (typeof cwd !== "string" || cwd === "") return [sessionId, { branch: null, pr: null }];

	const { root, branch } = await resolveRepo(cwd);
	if (root === null || branch === null) return [sessionId, { branch, pr: null }];
	const pr = await lookupPullRequest(root, branch);
	return [sessionId, { branch, pr }];
}

/** Answer one states request. */
async function handleStates(ctx, req, res) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
		res.end("Use GET.");
		return;
	}
	const signal = AbortSignal.timeout(25_000);
	let records;
	try {
		records = await ctx.sessionQuery.listSessions(signal);
	} catch (error) {
		res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify({ states: {}, error: `session listing failed: ${error?.message ?? "unknown"}` }));
		return;
	}

	const slice = Array.isArray(records) ? records.slice(0, SESSION_LIMIT) : [];
	const settled = await Promise.all(slice.map((record) => stateOf(record).catch(() => undefined)));
	const states = {};
	for (const entry of settled) {
		if (entry !== undefined) states[entry[0]] = entry[1];
	}

	res.writeHead(200, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(req.method === "HEAD" ? undefined : JSON.stringify({ states }));
}

/**
 * Wire the states route to the harness services.
 * @param ctx - Host context with the Session query and Web server services.
 */
export function apply(ctx) {
	const dispose = ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: (req, res) => {
			const url = new URL(req.url ?? "/", "http://dsh.invalid");
			if (url.pathname !== STATES_PATH) {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
				res.end("Unknown route.");
				return;
			}
			return handleStates(ctx, req, res).catch(() => {
				if (!res.headersSent) {
					res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
					res.end(JSON.stringify({ states: {} }));
				} else if (!res.writableEnded) {
					res.end();
				}
			});
		}
	});
	ctx.on("dispose", () => {
		dispose();
		repoCache.clear();
		prCache.clear();
	});
}

export const inject = ["webServer", "sessionQuery"];
