/**
 * Standalone functional test for the @dsh-plugins/pr-badge host half.
 * Runs without cordis: drives `createPrBadge` through mock req/res objects,
 * over a stubbed subprocess service that executes REAL git commands against a
 * scratch repository (with worktrees and a detached HEAD) plus a REAL stub `gh`
 * script with canned per-branch answers. No network, no GitHub.
 *
 *   node test/run.mjs
 */
import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BADGE_COLORS,
	classifyChecks,
	createFirstMessageReader,
	createPrBadge,
	createSessionLister,
	derivePrBadge,
	forgeOf,
	normalizeCheck,
	normalizeGitlabMr,
	normalizePrView,
	parseRemoteUrl,
	parseRepoSlug,
	prReferenceFrom,
} from "../lib/index.js";

let passed = 0;
async function test(name, body) {
	try {
		await body();
		passed += 1;
		console.log(`✓ ${name}`);
	} catch (error) {
		console.error(`✗ ${name}\n  ${error?.stack ?? error}`);
		process.exitCode = 1;
		throw error;
	}
}

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "prb-test",
	GIT_AUTHOR_EMAIL: "prb@test.local",
	GIT_COMMITTER_NAME: "prb-test",
	GIT_COMMITTER_EMAIL: "prb@test.local",
};

/** Run one real git command, throwing on failure. */
function git(args, cwd) {
	const result = spawnSync("git", args, {
		cwd,
		env: GIT_ENV,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout;
}

// --------------------------------------------------------------- stub `gh`

/** Canned `gh pr view` answers, keyed by branch. */
const GH_ANSWERS = {
	"feat-merged": {
		exit: 0,
		json: {
			number: 75,
			url: "https://github.com/tribesman/dating-golang/pull/75",
			state: "MERGED",
			isDraft: false,
			reviewDecision: "",
			mergeable: "UNKNOWN",
			mergeStateStatus: "UNKNOWN",
			statusCheckRollup: [],
		},
	},
	"feat-open": {
		exit: 0,
		json: {
			number: 76,
			url: "https://github.com/tribesman/dating-golang/pull/76",
			state: "OPEN",
			isDraft: false,
			reviewDecision: "REVIEW_REQUIRED",
			mergeable: "MERGEABLE",
			mergeStateStatus: "BLOCKED",
			statusCheckRollup: [
				{ __typename: "CheckRun", name: "ci", conclusion: null, status: "IN_PROGRESS" },
			],
		},
	},
	"feat-draft": {
		exit: 0,
		json: {
			number: 77,
			url: "https://github.com/tribesman/dating-golang/pull/77",
			state: "OPEN",
			isDraft: true,
			reviewDecision: "",
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			statusCheckRollup: [],
		},
	},
	"feat-nopr": {
		exit: 1,
		stderr: 'no pull requests found for branch "feat-nopr"',
	},
	"feat-broken": {
		exit: 1,
		stderr: "error connecting to api.github.com: dial tcp: i/o timeout",
	},
	// Numeric selectors: the PR a review chat names in its opening message.
	"331": {
		exit: 0,
		json: {
			number: 331,
			url: "https://github.com/tribesman/hlrd/pull/331",
			state: "MERGED",
			isDraft: false,
			reviewDecision: "",
			mergeable: "UNKNOWN",
			mergeStateStatus: "UNKNOWN",
			statusCheckRollup: [],
		},
	},
	"335": {
		exit: 0,
		json: {
			number: 335,
			url: "https://github.com/tribesman/hlrd/pull/335",
			state: "OPEN",
			isDraft: false,
			reviewDecision: "APPROVED",
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			statusCheckRollup: [],
		},
	},
	"999": {
		exit: 1,
		stderr: "Could not resolve to a PullRequest with the number of 999.",
	},
	// Tracker-id lookups: the PR a chat's title names, by number.
	"435": {
		exit: 0,
		json: {
			number: 435,
			url: "https://github.com/tribesman/hlrd/pull/435",
			state: "MERGED",
			isDraft: false,
			reviewDecision: "",
			mergeable: "UNKNOWN",
			mergeStateStatus: "UNKNOWN",
			statusCheckRollup: [],
			title: "#434 API регистра товаров: движения и остаток на дату",
			headRefName: "tk-434",
		},
	},
	"447": {
		exit: 0,
		json: {
			number: 447,
			url: "https://github.com/tribesman/hlrd/pull/447",
			state: "OPEN",
			isDraft: false,
			reviewDecision: "REVIEW_REQUIRED",
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			statusCheckRollup: [],
			title: "#430 Rate limit и защита от флуда публичных эндпоинтов",
			headRefName: "tk-430",
		},
	},
	"900": {
		exit: 0,
		json: {
			number: 900,
			url: "https://github.com/tribesman/ambient/pull/900",
			state: "OPEN",
			isDraft: false,
			reviewDecision: "",
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			statusCheckRollup: [],
			title: "Ambient feature work",
			headRefName: "feat-ambient",
		},
	},
	"feat-ambient": {
		exit: 0,
		json: {
			number: 900,
			url: "https://github.com/tribesman/ambient/pull/900",
			state: "OPEN",
			isDraft: false,
			reviewDecision: "",
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			statusCheckRollup: [],
			title: "Ambient feature work",
			headRefName: "feat-ambient",
		},
	},
	"tk-430": {
		exit: 0,
		json: {
			number: 447,
			url: "https://github.com/tribesman/hlrd/pull/447",
			state: "OPEN",
			isDraft: false,
			reviewDecision: "REVIEW_REQUIRED",
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			statusCheckRollup: [],
			title: "#430 Rate limit и защита от флуда публичных эндпоинтов",
			headRefName: "tk-430",
		},
	},
	// A repository's default branch: the badge answer must never be consumed.
	"v2/master": {
		exit: 0,
		json: {
			number: 1054,
			url: "https://github.com/tribesman/hlrd/pull/1054",
			state: "MERGED",
			isDraft: false,
			reviewDecision: "",
			mergeable: "UNKNOWN",
			mergeStateStatus: "UNKNOWN",
			statusCheckRollup: [],
			title: "Старый общий мерж",
			headRefName: "v2/master",
		},
	},
};

/** The repository's pull-request index, as `gh pr list --json` reports it. */
const GH_PR_INDEX = [
	{
		number: 435,
		title: "#434 API регистра товаров: движения и остаток на дату",
		headRefName: "tk-434",
		state: "MERGED",
		url: "https://github.com/tribesman/hlrd/pull/435",
		isDraft: false,
		updatedAt: "2026-10-01T10:00:00Z",
	},
	{
		number: 447,
		title: "#430 Rate limit и защита от флуда публичных эндпоинтов",
		headRefName: "tk-430",
		state: "OPEN",
		url: "https://github.com/tribesman/hlrd/pull/447",
		isDraft: false,
		updatedAt: "2026-11-02T10:00:00Z",
	},
	{
		number: 900,
		title: "Ambient feature work",
		headRefName: "feat-ambient",
		state: "OPEN",
		url: "https://github.com/tribesman/ambient/pull/900",
		isDraft: false,
		updatedAt: "2026-11-03T10:00:00Z",
	},
];

function writeGhStub(dir) {
	const path = join(dir, "gh-stub.sh");
	const cases = Object.entries(GH_ANSWERS)
		.map(([branch, answer]) => {
			if (answer.exit === 0) {
				return `\t${branch}) printf '%s' '${JSON.stringify(answer.json)}'; exit 0 ;;`;
			}
			return `\t${branch}) printf '%s\\n' '${answer.stderr}' >&2; exit ${answer.exit} ;;`;
		})
		.join("\n");
	writeFileSync(
		path,
		`#!/usr/bin/env bash\n# argv: pr view <selector> --json <fields> | pr list --state all ...\nif [ "$2" = "list" ]; then printf '%s' '${JSON.stringify(GH_PR_INDEX)}'; exit 0; fi\nbranch="$3"\ncase "$branch" in\n${cases}\n\t*) printf '%s\\n' "unexpected branch: $branch" >&2; exit 9 ;;\nesac\n`,
		"utf8",
	);
	chmodSync(path, 0o755);
	return path;
}

// ------------------------------------------------------------- stub `glab`

/** One GitLab merge-request payload, shaped like `glab api` output. */
function gitlabMr(overrides) {
	return {
		iid: 12,
		web_url: "https://gitlab.example.com/group/app/-/merge_requests/12",
		state: "opened",
		draft: false,
		has_conflicts: false,
		detailed_merge_status: "mergeable",
		head_pipeline: { status: "success" },
		source_branch: "mr-open",
		title: "Add the open merge request",
		updated_at: "2026-01-01T10:00:00.000Z",
		...overrides,
	};
}

/** Canned `glab api` answers, keyed by a substring of the endpoint. */
const GLAB_ANSWERS = [
	{ match: "source_branch=mr-open", body: [gitlabMr({})] },
	{
		match: "source_branch=mr-draft",
		body: [gitlabMr({ iid: 13, source_branch: "mr-draft", draft: true, title: "Draft MR" })],
	},
	{
		match: "source_branch=mr-merged",
		body: [gitlabMr({ iid: 14, source_branch: "mr-merged", state: "merged", title: "Merged MR" })],
	},
	{ match: "source_branch=mr-error", failure: "glab: 500 Internal Server Error (HTTP 500)" },
	{
		// A task-number search: the older merge request is merged, the newer one
		// is still open, and the open one must win.
		match: "search=41468",
		body: [
			gitlabMr({
				iid: 1600,
				source_branch: "v2-41468-old",
				state: "merged",
				title: "#41468 обновление банков",
				updated_at: "2025-12-01T10:00:00.000Z",
			}),
			gitlabMr({
				iid: 1660,
				source_branch: "v2-41468",
				title: "#41468 Защитить обновление банков Ингосстраха от зависаний",
				updated_at: "2026-11-03T07:38:33.436Z",
			}),
		],
	},
	{
		match: "projects/group%2Fapp/merge_requests/1660",
		body: gitlabMr({
			iid: 1660,
			source_branch: "v2-41468",
			title: "#41468 Защитить обновление банков",
		}),
	},
];

function writeGlabStub(dir) {
	const path = join(dir, "glab-stub.sh");
	const cases = GLAB_ANSWERS.map((answer) => {
		if (answer.failure) {
			return `\t*${answer.match}*) printf '%s\\n' '${answer.failure}' >&2; exit 1 ;;`;
		}
		return `\t*${answer.match}*) printf '%s' '${JSON.stringify(answer.body)}'; exit 0 ;;`;
	}).join("\n");
	writeFileSync(
		path,
		`#!/usr/bin/env bash\n# argv: api <endpoint>\nendpoint="$2"\ncase "$endpoint" in\n${cases}\n\t*) printf '%s' '[]'; exit 0 ;;\nesac\n`,
		"utf8",
	);
	chmodSync(path, 0o755);
	return path;
}

/**
 * Subprocess-service stub implementing the harness `ctx.subprocess.spawn`
 * contract over node:child_process: explicit argv (never shell-interpreted),
 * offset-based collected readers, `done` and tree-scoped `terminate()`.
 */
function makeSubprocess(ghStubPath, log, glabStubPath) {
	function spawn(spec) {
		const [bin, ...args] = spec.argv;
		log.push({ bin, args, cwd: spec.cwd });
		const child = nodeSpawn(bin, args, {
			cwd: spec.cwd,
			env: { ...process.env, PATH: process.env.PATH },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks = { stdout: [], stderr: [] };
		let sizes = { stdout: 0, stderr: 0 };
		for (const stream of ["stdout", "stderr"]) {
			child[stream].on("data", (chunk) => {
				chunks[stream].push(chunk.toString());
				sizes[stream] += chunk.length;
			});
		}
		const done = new Promise((resolve) => {
			child.on("error", () => resolve({ exitCode: 127 }));
			child.on("close", (code) => resolve({ exitCode: typeof code === "number" ? code : 1 }));
		});
		const reader = (stream) => ({
			readFrom: (offset) => ({
				text: chunks[stream].join("").slice(offset),
				nextOffset: sizes[stream],
				lossy: false,
			}),
		});
		return {
			done,
			terminate: () => {
				child.kill("SIGTERM");
			},
			collected: { stdout: reader("stdout"), stderr: reader("stderr") },
		};
	}
	return {
		spawn,
		resolveExecutable: async (command) => {
			if (command === "gh") return ghStubPath;
			if (command === "glab" && glabStubPath) return glabStubPath;
			return command;
		},
	};
}

// ------------------------------------------------------------ mock req/res

function mockRes() {
	return {
		statusCode: 0,
		headers: null,
		body: "",
		writeHead(statusCode, headers) {
			this.statusCode = statusCode;
			this.headers = headers;
		},
		end(chunk) {
			this.body = chunk ?? "";
		},
	};
}

async function call(controller, options) {
	const { method = "GET", url, host = "127.0.0.1" } = options ?? {};
	const res = mockRes();
	await controller.handle({ method, url, headers: { host } }, res);
	let payload = null;
	try {
		payload = res.body ? JSON.parse(res.body) : null;
	} catch {
		payload = res.body;
	}
	return { status: res.statusCode, headers: res.headers, payload };
}

function ghCalls(log) {
	return log.filter((entry) => entry.bin.endsWith("gh-stub.sh"));
}

function glabCalls(log) {
	return log.filter((entry) => entry.bin.endsWith("glab-stub.sh"));
}

// ------------------------------------------------------------- unit surface

await test("derivePrBadge maps every state onto the four faces", () => {
	const base = { statusCheckRollup: [], isDraft: false, reviewDecision: "", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
	const badge = (patch) => derivePrBadge(normalizePrView({ ...base, ...patch }));

	assert.deepEqual(badge({ state: "MERGED" }), { color: "purple", reason: "merged" });
	assert.deepEqual(badge({ state: "CLOSED" }), { color: "grey", reason: "closed" });
	assert.deepEqual(badge({ state: "OPEN" }), { color: "green", reason: "open" });
	// Pending checks and a requested review are a healthy open PR, not a problem.
	assert.deepEqual(
		badge({
			state: "OPEN",
			reviewDecision: "REVIEW_REQUIRED",
			statusCheckRollup: [{ __typename: "CheckRun", name: "ci", conclusion: null, status: "IN_PROGRESS" }],
		}),
		{ color: "green", reason: "open" },
	);
	assert.deepEqual(badge({ state: "OPEN", isDraft: true }), { color: "orange", reason: "draft" });
	assert.deepEqual(badge({ state: "OPEN", mergeable: "CONFLICTING" }), {
		color: "orange",
		reason: "conflicts",
	});
	assert.deepEqual(badge({ state: "OPEN", mergeStateStatus: "DIRTY" }), {
		color: "orange",
		reason: "conflicts",
	});
	assert.deepEqual(badge({ state: "OPEN", reviewDecision: "CHANGES_REQUESTED" }), {
		color: "orange",
		reason: "changes-requested",
	});
	assert.deepEqual(
		badge({
			state: "OPEN",
			statusCheckRollup: [{ __typename: "CheckRun", name: "ci", conclusion: "FAILURE" }],
		}),
		{ color: "orange", reason: "checks-failing" },
	);
	// Blockers outrank each other in a fixed order.
	assert.equal(
		badge({ state: "OPEN", isDraft: true, mergeable: "CONFLICTING" }).reason,
		"conflicts",
	);
	// An unreadable state paints nothing rather than guessing.
	assert.equal(badge({ state: "WHO_KNOWS" }), null);
	assert.equal(derivePrBadge(null), null);
	assert.deepEqual(Object.keys(BADGE_COLORS), ["green", "orange", "purple", "grey"]);
});

await test("classifyChecks understands both rollup shapes", () => {
	assert.equal(classifyChecks([]).outcome, "empty");
	assert.equal(classifyChecks(undefined).outcome, "empty");
	assert.equal(
		classifyChecks([{ __typename: "StatusContext", context: "ci", state: "FAILURE" }]).outcome,
		"failed",
	);
	assert.equal(
		classifyChecks([{ __typename: "CheckRun", name: "ci", conclusion: "SUCCESS" }]).outcome,
		"passed",
	);
	assert.equal(
		classifyChecks([
			{ __typename: "CheckRun", name: "a", conclusion: "SUCCESS" },
			{ __typename: "CheckRun", name: "b", conclusion: null },
		]).outcome,
		"pending",
	);
	// A failing check beats a pending one.
	assert.equal(
		classifyChecks([
			{ __typename: "CheckRun", name: "a", conclusion: "CANCELLED" },
			{ __typename: "CheckRun", name: "b", conclusion: null },
		]).outcome,
		"failed",
	);
	assert.deepEqual(normalizeCheck({ context: "ci", state: "SUCCESS" }), {
		name: "ci",
		conclusion: "SUCCESS",
	});
	assert.deepEqual(normalizeCheck(null), { name: "check", conclusion: "UNKNOWN" });
});

await test("parseRepoSlug reads owner/repo out of a PR URL", () => {
	assert.equal(
		parseRepoSlug("https://github.com/tribesman/dating-golang/pull/75"),
		"tribesman/dating-golang",
	);
	assert.equal(parseRepoSlug("https://example.com/x/y/pull/1"), "x/y");
	assert.equal(parseRepoSlug("https://github.com/x/y/issues/1"), undefined);
	assert.equal(parseRepoSlug(undefined), undefined);
});

await test("parseRemoteUrl understands scp, ssh and http remotes", () => {
	assert.deepEqual(parseRemoteUrl("git@gitlab.fast-system.ru:ipoteka/ipoteka-backend.git"), {
		host: "gitlab.fast-system.ru",
		path: "ipoteka/ipoteka-backend",
	});
	assert.deepEqual(parseRemoteUrl("https://gitlab.com/group/sub/proj.git"), {
		host: "gitlab.com",
		path: "group/sub/proj",
	});
	assert.deepEqual(parseRemoteUrl("ssh://git@gitlab.example.com:2222/team/app"), {
		host: "gitlab.example.com",
		path: "team/app",
	});
	assert.deepEqual(parseRemoteUrl("git@github.com:tribesman/hlrd2021.git"), {
		host: "github.com",
		path: "tribesman/hlrd2021",
	});
	assert.equal(parseRemoteUrl("not a remote"), null);
	assert.equal(parseRemoteUrl(""), null);
	assert.equal(parseRemoteUrl(undefined), null);
});

await test("forgeOf picks the forge from the remote host", () => {
	assert.equal(forgeOf(parseRemoteUrl("git@github.com:a/b.git")), "github");
	assert.equal(forgeOf(parseRemoteUrl("git@gitlab.com:a/b.git")), "gitlab");
	assert.equal(forgeOf(parseRemoteUrl("git@gitlab.fast-system.ru:a/b.git")), "gitlab");
	// A host that names no forge keeps the historical `gh` path.
	assert.equal(forgeOf(parseRemoteUrl("git@code.example.com:a/b.git")), "github");
	assert.equal(forgeOf(null), "github");
	// The row config can force the forge for a self-hosted instance.
	assert.equal(forgeOf(parseRemoteUrl("git@code.example.com:a/b.git"), "gitlab"), "gitlab");
});

await test("normalizeGitlabMr maps merge requests onto the badge faces", () => {
	const base = {
		iid: 1660,
		web_url: "https://gitlab.example.com/group/app/-/merge_requests/1660",
		state: "opened",
		draft: false,
		has_conflicts: false,
		detailed_merge_status: "mergeable",
		head_pipeline: { status: "success" },
	};
	const badge = (patch) => derivePrBadge(normalizeGitlabMr({ ...base, ...patch }));

	assert.deepEqual(badge({}), { color: "green", reason: "open" });
	assert.deepEqual(badge({ draft: true }), { color: "orange", reason: "draft" });
	assert.deepEqual(badge({ has_conflicts: true }), { color: "orange", reason: "conflicts" });
	assert.deepEqual(
		badge({ detailed_merge_status: "conflict" }),
		{ color: "orange", reason: "conflicts" },
		"GitLab reports conflicts through detailed_merge_status too",
	);
	assert.deepEqual(
		badge({ head_pipeline: { status: "failed" } }),
		{ color: "orange", reason: "checks-failing" },
	);
	assert.deepEqual(
		badge({ head_pipeline: { status: "running" } }),
		{ color: "green", reason: "open" },
		"a running pipeline is not a failure",
	);
	assert.deepEqual(badge({ state: "merged" }), { color: "purple", reason: "merged" });
	assert.deepEqual(badge({ state: "closed" }), { color: "grey", reason: "closed" });
	assert.equal(normalizeGitlabMr({}), null);
	assert.equal(normalizeGitlabMr({ iid: 1, state: "who-knows" }), null);
});

await test("createSessionLister resolves ids, cwd and titles", async () => {
	const warnings = [];
	const sessionQuery = {
		async listSessions() {
			return [
				{ header: { id: "session-a", cwd: "/tmp/a" }, live: true },
				{ header: { id: "session-b", cwd: "/tmp/b" }, live: false, persisted: true },
				{ header: { id: "session-c", cwd: "/tmp/c", origin: "subagent" }, live: true },
				{ header: { id: "session-d", cwd: "/tmp/d", delegationDepth: 1 }, live: true },
				{ header: { id: "session-e" }, live: true },
			];
		},
		async readTitleSnapshots(ids) {
			assert.deepEqual(ids, ["session-a", "session-b", "session-e"]);
			return [
				{ sessionId: "session-a", status: "fulfilled", value: { session: { id: "session-a" }, title: { title: "Refactor the parser" } } },
				{ sessionId: "session-b", status: "fulfilled", value: { session: { id: "session-b" } } },
				{ sessionId: "session-e", status: "rejected", reason: new Error("gone") },
			];
		},
	};
	const lister = createSessionLister(sessionQuery, { warn: (m) => warnings.push(m) });
	const sessions = await lister();
	assert.deepEqual(sessions, [
		{ sessionId: "session-a", cwd: "/tmp/a", title: "Refactor the parser", firstMessage: undefined },
		{ sessionId: "session-b", cwd: "/tmp/b", title: undefined, firstMessage: undefined },
		{ sessionId: "session-e", cwd: undefined, title: undefined, firstMessage: undefined },
	]);
	assert.deepEqual(warnings, []);

	// A missing service is a warning, not a crash: the feed stays empty, and the
	// warning is emitted once per lister rather than on every poll.
	const bare = [];
	const missing = createSessionLister(undefined, { warn: (m) => bare.push(m) });
	assert.deepEqual(await missing(), []);
	assert.deepEqual(await missing(), []);
	assert.equal(bare.length, 1);
	assert.match(bare[0], /sessionQuery/);

	// The service is resolved per call, so a getter that becomes live later
	// (mount-order safety) starts producing sessions without a rebuild.
	const late = [];
	let available;
	const deferred = createSessionLister(() => available, { warn: (m) => late.push(m) });
	assert.deepEqual(await deferred(), []);
	assert.equal(late.length, 1, "an absent service warns once");
	available = sessionQuery;
	assert.equal((await deferred()).length, 3, "a late service is picked up");
	assert.equal(late.length, 1, "a working service stops warning");
});

await test("prReferenceFrom reads only explicit pull-request wording", () => {
	// The review flow: a command that names the PR it works on.
	assert.deepEqual(prReferenceFrom("/code-review pr 335"), { number: 335 });
	assert.deepEqual(prReferenceFrom("/code-review PR 331"), { number: 331 });
	assert.deepEqual(prReferenceFrom("Review PR 358 code"), { number: 358 });
	assert.deepEqual(prReferenceFrom("посмотри pull request 12"), { number: 12 });
	assert.deepEqual(prReferenceFrom("глянь PR#77 и MR 8"), { number: 77 });
	// A full URL keeps its href, so the probe needs no repository guess.
	assert.deepEqual(
		prReferenceFrom("смотри https://github.com/tribesman/dating-golang/pull/75 внимательно"),
		{ number: 75, href: "https://github.com/tribesman/dating-golang/pull/75" },
	);
	// The earliest reference wins.
	assert.equal(prReferenceFrom("PR 11, а потом PR 22").number, 11);
	// Issues, review commands without a number and ordinary prose never match:
	// an issue chat must not be badged with whatever PR carries that number.
	assert.equal(prReferenceFrom("приступай к выполнению issue 336"), null);
	assert.equal(prReferenceFrom("/code-review"), null);
	assert.equal(prReferenceFrom("на странице /messages не выводи футер"), null);
	assert.equal(prReferenceFrom("измени скил code-review и добавь номер pr"), null);
	assert.equal(prReferenceFrom(""), null);
	assert.equal(prReferenceFrom(undefined), null);
});

await test("createFirstMessageReader reads the cached opening message", () => {
	const header = { id: "session-a", cwd: "/tmp/a", createdAt: 1 };
	const calls = [];
	const service = {
		cachedSnapshot(meta, inheritedEventCount, keys) {
			calls.push({ meta, inheritedEventCount, keys });
			return {
				asOfSeq: 8,
				values: { titleInput: { first: { seq: 8, text: " /code-review pr 335 " }, count: 1 } },
			};
		},
	};
	const read = createFirstMessageReader(service);
	assert.equal(read(header), " /code-review pr 335 ");
	// The witness is normalized: a listing header omits `isSeeded`, the cache
	// compares it strictly, and an unseeded lifecycle carries a zero prefix.
	assert.deepEqual(calls, [
		{
			meta: { id: "session-a", cwd: "/tmp/a", createdAt: 1, isSeeded: false },
			inheritedEventCount: 0,
			keys: ["titleInput"],
		},
	]);
	// Getters keep the reader safe against mount ordering, exactly like the other
	// services this plugin consumes.
	assert.equal(createFirstMessageReader(() => service)(header), " /code-review pr 335 ");
	// Every failure mode answers undefined rather than a guessed message.
	assert.equal(createFirstMessageReader(undefined)(header), undefined);
	assert.equal(createFirstMessageReader({})(header), undefined);
	assert.equal(createFirstMessageReader({ cachedSnapshot: () => undefined })(header), undefined);
	assert.equal(createFirstMessageReader({ cachedSnapshot: () => ({ values: {} }) })(header), undefined);
	assert.equal(
		createFirstMessageReader({ cachedSnapshot: () => ({ values: { titleInput: {} } }) })(header),
		undefined,
	);
	assert.equal(createFirstMessageReader(service)({ ...header, isSeeded: true }), undefined);
	// A missing service warns exactly once: it is a configuration fact, not a
	// per-session event.
	const warnings = [];
	const warned = createFirstMessageReader(undefined, { warn: (m) => warnings.push(m) });
	assert.equal(warned(header), undefined);
	assert.equal(warned(header), undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /sessionProjectionCache/);
	assert.equal(
		createFirstMessageReader(() => {
			throw new Error("service gone");
		})(header),
		undefined,
	);
});

await test("the lister attaches the opening message to each session", async () => {
	const headers = [
		{ id: "session-a", cwd: "/tmp/a", createdAt: 1 },
		{ id: "session-b", cwd: "/tmp/b", createdAt: 2 },
	];
	const lister = createSessionLister(
		{ async listSessions() { return headers.map((header) => ({ header, live: false })); } },
		{
			readFirstMessage: (header) =>
				header.id === "session-a" ? "/code-review pr 335" : undefined,
		},
	);
	assert.deepEqual(await lister(), [
		{ sessionId: "session-a", cwd: "/tmp/a", title: undefined, firstMessage: "/code-review pr 335" },
		{ sessionId: "session-b", cwd: "/tmp/b", title: undefined, firstMessage: undefined },
	]);
});

// ---------------------------------------------------------- end-to-end feed

const scratch = await realpath(await mkdtemp(join(tmpdir(), "prb-fixture-")));
const project = join(scratch, "project");
const ghStubPath = writeGhStub(scratch);
const log = [];

async function makeFixture() {
	git(["init", "--quiet", "--initial-branch=main", project], scratch);
	git(["config", "user.email", "prb@test.local"], project);
	git(["config", "user.name", "prb-test"], project);
	writeFileSync(join(project, "README.md"), "# fixture\n", "utf8");
	git(["add", "."], project);
	git(["commit", "-q", "-m", "seed"], project);
	const worktrees = {};
	for (const branch of ["feat-merged", "feat-open", "feat-draft", "feat-nopr", "feat-broken"]) {
		const path = join(scratch, branch);
		git(["worktree", "add", "--quiet", path, "-b", branch], project);
		worktrees[branch] = path;
	}
	return worktrees;
}

const worktrees = await makeFixture();

/** One session list exercising every branch of the resolution logic. */
function sessionList() {
	return [
		{ sessionId: "session-merged", cwd: worktrees["feat-merged"], title: "Merged chat" },
		{ sessionId: "session-open", cwd: worktrees["feat-open"], title: "Open chat" },
		{ sessionId: "session-draft", cwd: worktrees["feat-draft"], title: "Draft chat" },
		{ sessionId: "session-nopr", cwd: worktrees["feat-nopr"], title: "No PR chat" },
		{ sessionId: "session-broken", cwd: worktrees["feat-broken"], title: "Broken gh chat" },
		{ sessionId: "session-main", cwd: project, title: "Main branch chat" },
		{ sessionId: "session-outside", cwd: scratch, title: "Not a repository" },
		{ sessionId: "session-nowhere", title: "Session without cwd" },
	];
}

function makeController(options = {}) {
	const subprocess = makeSubprocess(ghStubPath, log);
	return createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => sessionList(),
		...options,
	});
}

await test("feed: one entry per PR branch, nothing for the rest", async () => {
	const controller = makeController();
	const { status, payload } = await call(controller, { url: "/pr-badge/api/states" });
	assert.equal(status, 200);
	assert.equal(payload.entries.length, 3);
	const bySession = new Map(payload.entries.map((entry) => [entry.sessionId, entry]));

	const merged = bySession.get("session-merged");
	assert.deepEqual(
		{ color: merged.color, reason: merged.reason, number: merged.number, repo: merged.repo, branch: merged.branch },
		{
			color: "purple",
			reason: "merged",
			number: 75,
			repo: "tribesman/dating-golang",
			branch: "feat-merged",
		},
	);
	assert.equal(merged.url, "https://github.com/tribesman/dating-golang/pull/75");
	assert.equal(merged.title, "Merged chat");
	assert.equal(merged.root, worktrees["feat-merged"]);
	assert.equal(bySession.get("session-open").color, "green");
	assert.equal(bySession.get("session-draft").color, "orange");
	assert.equal(bySession.get("session-draft").reason, "draft");
	// No PR, an integration branch, a non-repository, and a missing cwd.
	assert.equal(bySession.has("session-nopr"), false);
	assert.equal(bySession.has("session-broken"), false);
	assert.equal(bySession.has("session-main"), false);
	assert.equal(bySession.has("session-outside"), false);
	assert.equal(bySession.has("session-nowhere"), false);
	assert.equal(typeof payload.generatedAt, "number");
	assert.equal(payload.diagnostics, undefined, "diagnostics stay out of the default payload");

	// `gh` ran once per candidate branch, with the repository top as its cwd.
	const probes = ghCalls(log);
	assert.deepEqual(probes.map((entry) => entry.args[2]).sort(), [
		"feat-broken",
		"feat-draft",
		"feat-merged",
		"feat-nopr",
		"feat-open",
	].sort());
	for (const probe of probes) {
		assert.deepEqual(probe.args.slice(0, 3), ["pr", "view", probe.args[2]]);
		assert.equal(probe.args[3], "--json");
		assert.match(probe.args[4], /^number,url,state,isDraft,reviewDecision,/);
		assert.equal(probe.cwd, worktrees[probe.args[2]]);
	}
	// Integration branches and detached HEADs never reach `gh`.
	assert.equal(probes.some((entry) => entry.cwd === project && entry.args[2] === "main"), false);

	// A second pass inside every TTL is served from cache — no new processes.
	const before = log.length;
	const again = await call(controller, { url: "/pr-badge/api/states" });
	assert.equal(again.payload.entries.length, 3);
	assert.equal(log.length, before, "cached feed spawns no git/gh process");
	controller.shutdown();
});

await test("feed: an expired TTL re-probes", async () => {
	const controller = makeController({
		openTtlMs: 5,
		terminalTtlMs: 5,
		absentTtlMs: 5,
		errorTtlMs: 5,
		locationTtlMs: 5,
		sessionsTtlMs: 5,
	});
	await call(controller, { url: "/pr-badge/api/states" });
	const probes = ghCalls(log).length;
	await new Promise((resolve) => setTimeout(resolve, 15));
	await call(controller, { url: "/pr-badge/api/states" });
	assert.ok(ghCalls(log).length > probes, "expired caches re-run the probe");
	controller.shutdown();
});

await test("chats sharing one worktree cost one probe", async () => {
	const shared = [
		{ sessionId: "session-shared-a", cwd: worktrees["feat-merged"], title: "A" },
		{ sessionId: "session-shared-b", cwd: worktrees["feat-merged"], title: "B" },
		{ sessionId: "session-shared-c", cwd: worktrees["feat-merged"], title: "C" },
	];
	const subprocess = makeSubprocess(ghStubPath, log);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => shared,
	});
	const before = log.length;
	const { payload } = await call(controller, { url: "/pr-badge/api/states" });
	assert.equal(payload.entries.length, 3, "every chat on the branch is badged");
	assert.equal(
		ghCalls(log.slice(before)).length,
		1,
		"one in-flight probe is shared by all three chats",
	);
	assert.equal(
		log.slice(before).filter((entry) => entry.args[1] === "--show-toplevel").length,
		1,
		"the cwd is resolved to a repository top once",
	);
	controller.shutdown();
});

await test("a worktree binding wins over the branch of the session cwd", async () => {
	// The real-world shape: worktree-launcher moves a chat into an isolated
	// checkout while the session header keeps the repository root as its cwd.
	const bindingsDir = join(project, ".dsh", "worktrees");
	await mkdir(bindingsDir, { recursive: true });
	await writeFile(
		join(bindingsDir, "bindings.json"),
		JSON.stringify({
			version: 1,
			bindings: [
				{
					sessionId: "session-bound",
					branch: "feat-merged",
					path: worktrees["feat-merged"],
					root: project,
					baseBranch: "main",
					createdAt: 100,
				},
				{
					sessionId: "session-bound",
					branch: "feat-open",
					path: worktrees["feat-open"],
					root: project,
					baseBranch: "main",
					createdAt: 200,
				},
				{
					sessionId: "session-bound-blank",
					branch: "main",
					path: project,
					root: project,
					baseBranch: "main",
					createdAt: 300,
				},
				{ sessionId: "", branch: "feat-draft", root: project },
			],
		}),
		"utf8",
	);

	const sessions = [
		{ sessionId: "session-bound", cwd: project, title: "Bound chat" },
		{ sessionId: "session-bound-blank", cwd: project, title: "Bound to main" },
		{ sessionId: "session-unbound", cwd: project, title: "Unbound on main" },
		{ sessionId: "session-from-worktree", cwd: worktrees["feat-draft"], title: "cwd in a worktree" },
	];
	const subprocess = makeSubprocess(ghStubPath, log);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => sessions,
		debug: true,
	});
	const before = log.length;
	const { payload } = await call(controller, { url: "/pr-badge/api/states?debug=1" });
	const bySession = new Map(payload.entries.map((entry) => [entry.sessionId, entry]));
	const diagnostics = new Map(payload.diagnostics.map((row) => [row.sessionId, row]));

	// The newest binding for the session wins, even though the cwd says `main`.
	assert.equal(bySession.get("session-bound").branch, "feat-open");
	assert.equal(bySession.get("session-bound").color, "green");
	assert.equal(bySession.get("session-bound").source, "binding");
	assert.equal(bySession.get("session-bound").worktree, worktrees["feat-open"]);
	assert.equal(diagnostics.get("session-bound").source, "binding");
	// A binding onto an integration branch is still skipped.
	assert.equal(bySession.has("session-bound-blank"), false);
	assert.equal(diagnostics.get("session-bound-blank").branch, "main");
	assert.equal(diagnostics.get("session-bound-blank").reason, "base-branch");
	// No binding: the cwd branch decides, so a chat sitting on main stays clean…
	assert.equal(bySession.has("session-unbound"), false);
	assert.equal(diagnostics.get("session-unbound").source, "cwd");
	assert.equal(diagnostics.get("session-unbound").reason, "base-branch");
	// …while a cwd that IS the worktree needs no binding at all.
	assert.equal(bySession.get("session-from-worktree").branch, "feat-draft");
	assert.equal(bySession.get("session-from-worktree").source, "cwd");
	assert.equal(bySession.get("session-from-worktree").color, "orange");
	// The registry is read from disk, not through git: two probe calls only.
	assert.equal(ghCalls(log.slice(before)).length, 2, "one probe per bound branch");
	controller.shutdown();
});

await test("a review chat is badged with the PR its opening message names", async () => {
	const sessions = [
		{
			sessionId: "session-review-merged",
			cwd: project,
			title: "Code review for PR 331",
			firstMessage: "/code-review PR 331",
		},
		{
			sessionId: "session-review-open",
			cwd: project,
			title: "350 Скидка на доставку",
			firstMessage: "/code-review pr 335",
		},
		{
			sessionId: "session-review-unnumbered",
			cwd: project,
			title: "Code review request",
			firstMessage: "/code-review",
		},
		{
			sessionId: "session-issue",
			cwd: project,
			title: "Работа над issue 999",
			firstMessage: "приступай к выполнению issue 999",
		},
		{
			// Sits in a shared checkout whose branch also carries a PR: the PR the
			// chat names is its subject, so the reference outranks that branch.
			sessionId: "session-review-in-shared-checkout",
			cwd: worktrees["feat-open"],
			title: "Own work",
			firstMessage: "/code-review pr 331",
		},
		{
			// Moved into its own worktree *and* talking about another PR: the
			// worktree is that chat's own work and wins.
			sessionId: "session-bound-review",
			cwd: project,
			title: "Bound review",
			firstMessage: "/code-review pr 331",
		},
	];
	const subprocess = makeSubprocess(ghStubPath, log);
	// One of these chats was moved into its own worktree: register that binding.
	await writeFile(
		join(project, ".dsh", "worktrees", "bindings.json"),
		JSON.stringify({
			version: 1,
			bindings: [
				{
					sessionId: "session-bound-review",
					branch: "feat-merged",
					path: worktrees["feat-merged"],
					root: project,
					baseBranch: "main",
					createdAt: 400,
				},
			],
		}),
		"utf8",
	);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => sessions,
		debug: true,
	});
	const before = log.length;
	const { payload } = await call(controller, { url: "/pr-badge/api/states?debug=1" });
	const bySession = new Map(payload.entries.map((entry) => [entry.sessionId, entry]));
	const diagnostics = new Map(payload.diagnostics.map((row) => [row.sessionId, row]));

	// The title says 350 (an issue number) while the command says pr 335: the
	// message is authoritative — a title-based match would have badged this chat
	// with whatever pull request carries 350, if any.
	const merged = bySession.get("session-review-merged");
	assert.equal(merged.number, 331);
	assert.equal(merged.color, "purple");
	assert.equal(merged.source, "reference");
	assert.equal(merged.reference, "#331");
	assert.equal(merged.branch, null, "a referenced PR has no branch of its own");
	assert.equal(merged.worktree, null);
	assert.equal(merged.repo, "tribesman/hlrd");

	const open = bySession.get("session-review-open");
	assert.equal(open.number, 335);
	assert.equal(open.color, "green");
	assert.equal(open.source, "reference");
	assert.equal(open.reference, "#335");
	assert.equal(diagnostics.get("session-review-open").source, "reference");

	// The referenced number reaches gh verbatim.
	assert.ok(
		ghCalls(log.slice(before)).some((entry) => entry.args[2] === "335"),
		"the referenced number is passed to gh pr view",
	);

	// No number, no badge — and an issue chat never borrows a pull request. Both
	// sit on the base branch, which is exactly why the reference was consulted.
	assert.equal(bySession.has("session-review-unnumbered"), false);
	assert.equal(bySession.has("session-issue"), false);
	assert.equal(diagnostics.get("session-review-unnumbered").reason, "base-branch");
	assert.equal(diagnostics.get("session-issue").reason, "base-branch");

	// A chat sitting in a shared checkout reports the branch of that checkout —
	// a weak signal, so an explicit reference outranks it.
	const shared = bySession.get("session-review-in-shared-checkout");
	assert.equal(shared.number, 331, "the named PR wins over the shared branch");
	assert.equal(shared.source, "reference");
	assert.equal(shared.branch, null);

	// A worktree binding is the strongest signal: that is the chat's own work.
	const bound = bySession.get("session-bound-review");
	assert.equal(bound.number, 75, "the bound worktree PR wins");
	assert.equal(bound.source, "binding");
	assert.equal(bound.branch, "feat-merged");
	assert.equal(bound.reference, null);
	assert.equal(bound.worktree, worktrees["feat-merged"]);
	controller.shutdown();
});

await test("references can be turned off", async () => {
	const subprocess = makeSubprocess(ghStubPath, log);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => [
			{
				sessionId: "session-review-merged",
				cwd: project,
				title: "Code review for PR 331",
				firstMessage: "/code-review PR 331",
			},
		],
		references: false,
	});
	const before = log.length;
	const { payload } = await call(controller, { url: "/pr-badge/api/states" });
	assert.deepEqual(payload.entries, []);
	assert.equal(ghCalls(log.slice(before)).length, 0, "no probe for a disabled reference");
	controller.shutdown();
});

await test("a chat sitting on a base branch still resolves its referenced PR", async () => {
	// The real shape of a review chat: cwd on main, no worktree binding.
	const subprocess = makeSubprocess(ghStubPath, log);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => [
			{
				sessionId: "session-on-main",
				cwd: project,
				title: "Code review PR 331",
				firstMessage: "/code-review PR 331",
			},
		],
		debug: true,
	});
	const { payload } = await call(controller, { url: "/pr-badge/api/states?debug=1" });
	assert.equal(payload.entries.length, 1);
	assert.equal(payload.entries[0].source, "reference");
	assert.equal(payload.entries[0].number, 331);
	assert.equal(payload.diagnostics[0].branch, "main");
	assert.equal(payload.diagnostics[0].reason, "ok", "the reference is reported as the source");
	controller.shutdown();
});

await test("debug=1 explains every session that carries no badge", async () => {
	const controller = makeController({ debug: true });
	const { payload } = await call(controller, { url: "/pr-badge/api/states?debug=1" });
	const bySession = new Map(payload.diagnostics.map((row) => [row.sessionId, row]));
	assert.equal(bySession.get("session-merged").reason, "ok");
	assert.equal(bySession.get("session-merged").branch, "feat-merged");
	assert.equal(bySession.get("session-nopr").reason, "no-pr");
	assert.equal(bySession.get("session-broken").reason, "gh-error");
	assert.equal(bySession.get("session-main").reason, "base-branch");
	assert.equal(bySession.get("session-main").branch, "main");
	assert.equal(bySession.get("session-outside").reason, "not-a-repository");
	assert.equal(bySession.get("session-nowhere").reason, "no-cwd");
	assert.equal(payload.diagnostics.length, sessionList().length);
	// Without `debug: true` the query parameter is ignored entirely.
	const quiet = makeController();
	const quietPayload = await call(quiet, { url: "/pr-badge/api/states?debug=1" });
	assert.equal(quietPayload.payload.diagnostics, undefined);
	quiet.shutdown();
	controller.shutdown();
});

await test("a detached HEAD is reported, never badged", async () => {
	const path = join(scratch, "detached");
	git(["worktree", "add", "--quiet", path, "-b", "feat-detach"], project);
	git(["checkout", "--quiet", "--detach"], path);
	const subprocess = makeSubprocess(ghStubPath, log);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => [{ sessionId: "session-detached", cwd: path, title: "Detached" }],
		debug: true,
	});
	const { payload } = await call(controller, { url: "/pr-badge/api/states?debug=1" });
	assert.deepEqual(payload.entries, []);
	assert.equal(payload.diagnostics[0].reason, "detached-head");
	controller.shutdown();
});

await test("missing gh and missing git degrade to no badge", async () => {
	const subprocess = makeSubprocess(ghStubPath, log);
	const offline = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: async (command) => {
			if (command === "gh") throw new Error("gh not found on PATH");
			return command;
		},
		listSessions: async () => [
			{ sessionId: "session-merged", cwd: worktrees["feat-merged"], title: "Merged chat" },
		],
		debug: true,
	});
	const { payload } = await call(offline, { url: "/pr-badge/api/states?debug=1" });
	assert.deepEqual(payload.entries, []);
	assert.equal(payload.diagnostics[0].reason, "gh-missing");
	offline.shutdown();
});

// ------------------------------------------------------------- end-to-end GitLab

const glabStubPath = writeGlabStub(scratch);
const glProject = join(scratch, "gitlab-app");
const glWorktrees = {};

async function makeGitlabFixture() {
	git(["init", "--quiet", "--initial-branch=main", glProject], scratch);
	git(["config", "user.email", "prb@test.local"], glProject);
	git(["config", "user.name", "prb-test"], glProject);
	git(["remote", "add", "origin", "git@gitlab.example.com:group/app.git"], glProject);
	writeFileSync(join(glProject, "README.md"), "# gitlab fixture\n", "utf8");
	git(["add", "."], glProject);
	git(["commit", "-q", "-m", "seed"], glProject);
	for (const branch of ["mr-open", "mr-draft", "mr-merged", "mr-taskless", "mr-none", "mr-error"]) {
		const path = join(scratch, `gl-${branch}`);
		git(["worktree", "add", "--quiet", path, "-b", branch], glProject);
		glWorktrees[branch] = path;
	}
}

await makeGitlabFixture();

function gitlabSessions() {
	return [
		{ sessionId: "session-gl-open", cwd: glWorktrees["mr-open"], title: "Open MR chat" },
		{ sessionId: "session-gl-draft", cwd: glWorktrees["mr-draft"], title: "Draft MR chat" },
		{ sessionId: "session-gl-merged", cwd: glWorktrees["mr-merged"], title: "Merged MR chat" },
		{ sessionId: "session-gl-none", cwd: glWorktrees["mr-none"], title: "No MR chat" },
		{ sessionId: "session-gl-error", cwd: glWorktrees["mr-error"], title: "Broken glab chat" },
		{
			// The real shape of a task chat: its own branch is a throw-away
			// worktree branch with no merge request, but the task it names has
			// one on GitLab.
			sessionId: "session-gl-task",
			cwd: glWorktrees["mr-taskless"],
			title: "41468 Ингосстрах: обновление банков",
			firstMessage: "41468 Ингосстрах: обновление банков\n\nПо задаче пришел комментарий.",
		},
	];
}

await test("a GitLab session is badged with its merge request", async () => {
	const subprocess = makeSubprocess(ghStubPath, log, glabStubPath);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => gitlabSessions(),
		debug: true,
	});
	const before = log.length;
	const { payload } = await call(controller, { url: "/pr-badge/api/states?debug=1" });
	const bySession = new Map(payload.entries.map((entry) => [entry.sessionId, entry]));
	const diagnostics = new Map(payload.diagnostics.map((row) => [row.sessionId, row]));

	const open = bySession.get("session-gl-open");
	assert.equal(open.color, "green");
	assert.equal(open.number, 12);
	assert.equal(open.repo, "group/app");
	assert.equal(open.forge, "gitlab");
	assert.equal(open.source, "cwd");
	assert.equal(open.branch, "mr-open");
	assert.equal(open.url, "https://gitlab.example.com/group/app/-/merge_requests/12");

	assert.equal(bySession.get("session-gl-draft").reason, "draft");
	assert.equal(bySession.get("session-gl-merged").color, "purple");
	assert.equal(bySession.has("session-gl-none"), false);
	assert.equal(diagnostics.get("session-gl-none").reason, "no-pr");

	// `gh` is never consulted for a GitLab remote, and every call goes through
	// `glab api` from the session's repository top.
	const calls = glabCalls(log.slice(before));
	assert.equal(ghCalls(log.slice(before)).length, 0, "gh is never asked about a GitLab remote");
	assert.ok(calls.length > 0, "the GitLab probe ran");
	for (const probe of calls) {
		assert.equal(probe.args[0], "api");
		assert.equal(probe.cwd.startsWith(glWorktrees["mr-open"]), probe.args[1].includes("mr-open"));
	}
	assert.ok(
		calls.some((entry) => entry.args[1].includes("source_branch=mr-open")),
		"the merge request is resolved by source branch",
	);
	assert.ok(
		calls.some((entry) => entry.args[1].includes("projects/group%2Fapp/")),
		"the project path comes from the git remote",
	);
	controller.shutdown();
});

await test("a GitLab chat whose branch has no MR is badged with its task's merge request", async () => {
	const subprocess = makeSubprocess(ghStubPath, log, glabStubPath);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => [
			{
				sessionId: "session-gl-task",
				cwd: glWorktrees["mr-taskless"],
				title: "41468 Ингосстрах: обновление банков",
				firstMessage: "41468 Ингосстрах: обновление банков\n\nПо задаче пришел комментарий.",
			},
			{ sessionId: "session-gl-unnumbered", cwd: glWorktrees["mr-none"], title: "No task number" },
		],
		debug: true,
	});
	const before = log.length;
	const { payload } = await call(controller, { url: "/pr-badge/api/states?debug=1" });
	const bySession = new Map(payload.entries.map((entry) => [entry.sessionId, entry]));
	const task = bySession.get("session-gl-task");

	assert.equal(task.number, 1660, "the open merge request outranks the merged one");
	assert.equal(task.task, 41468);
	assert.equal(task.source, "task");
	assert.equal(task.branch, null, "a task-derived merge request has no branch of its own");
	assert.equal(task.reference, null);
	assert.equal(task.color, "green");
	assert.equal(task.forge, "gitlab");

	const calls = glabCalls(log.slice(before));
	assert.ok(
		calls.some((entry) => entry.args[1].includes("search=41468")),
		"the task number is searched on GitLab",
	);
	assert.equal(
		calls.some((entry) => entry.args[1].includes("search=") && !entry.args[1].includes("41468")),
		false,
		"a chat without a task number never searches",
	);
	assert.equal(bySession.has("session-gl-unnumbered"), false);
	controller.shutdown();
});

await test("a failing glab is reported, never badged", async () => {
	const subprocess = makeSubprocess(ghStubPath, log, glabStubPath);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => [
			{ sessionId: "session-gl-error", cwd: glWorktrees["mr-error"], title: "Broken glab chat" },
		],
		debug: true,
	});
	const { payload } = await call(controller, { url: "/pr-badge/api/states?debug=1" });
	assert.deepEqual(payload.entries, []);
	assert.equal(payload.diagnostics[0].reason, "glab-error");
	controller.shutdown();
});

/** A standalone repository (and primary checkout) under the fixture scratch dir. */
async function makeRepo(name, branch = "main") {
	const repo = join(scratch, name);
	git(["init", "-q", `--initial-branch=${branch}`, repo], scratch);
	git(["config", "user.email", "prb@test.local"], repo);
	git(["config", "user.name", "prb-test"], repo);
	writeFileSync(join(repo, "README.md"), `# ${name}\n`, "utf8");
	git(["add", "."], repo);
	git(["commit", "-q", "-m", "seed"], repo);
	return repo;
}

await test("the repository's own default branch is never badged", async () => {
	const repo = await makeRepo("default-branch", "v2/master");
	// A repository whose default branch is v2/master, the GitLab-shaped layout:
	// `origin/HEAD` names it even though the configured skip list does not.
	git(["update-ref", "refs/remotes/origin/v2/master", "HEAD"], repo);
	git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/v2/master"], repo);
	const subprocess = makeSubprocess(ghStubPath, log);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => [
			{ sessionId: "session-default-branch", cwd: repo, title: "Проверка отправки писем" },
		],
		debug: true,
	});
	const before = log.length;
	const { payload } = await call(controller, { url: "/pr-badge/api/states?debug=1" });
	assert.equal(payload.entries.length, 0, "the default branch yields no badge");
	assert.equal(payload.diagnostics[0].reason, "base-branch");
	assert.equal(payload.diagnostics[0].branch, "v2/master");
	assert.equal(ghCalls(log.slice(before)).length, 0, "the default branch never reaches gh");
	controller.shutdown();
});

await test("a shared checkout does not lend its branch to an unrelated chat", async () => {
	const repo = await makeRepo("ambient-branch", "main");
	git(["checkout", "-q", "-b", "feat-ambient"], repo);
	const subprocess = makeSubprocess(ghStubPath, log);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => [
			{ sessionId: "session-ambient-stranger", cwd: repo, title: "Вход в meetup по имени через env" },
			{ sessionId: "session-ambient-new", cwd: repo },
			{ sessionId: "session-ambient-owner", cwd: repo, title: "Ambient feature work" },
		],
		debug: true,
	});
	const { payload } = await call(controller, { url: "/pr-badge/api/states?debug=1" });
	const bySession = new Map(payload.entries.map((entry) => [entry.sessionId, entry]));
	const diagnostics = new Map(payload.diagnostics.map((row) => [row.sessionId, row]));

	// A chat titled after the request keeps its badge, from the branch alone.
	assert.equal(bySession.get("session-ambient-owner").number, 900);
	assert.equal(bySession.get("session-ambient-owner").source, "cwd");
	// An unrelated chat on the same branch stays clean…
	assert.equal(bySession.has("session-ambient-stranger"), false);
	assert.equal(diagnostics.get("session-ambient-stranger").reason, "ambient-branch");
	// …and so does a brand-new chat with no text of its own.
	assert.equal(bySession.has("session-ambient-new"), false);
	assert.equal(diagnostics.get("session-ambient-new").reason, "ambient-branch");
	controller.shutdown();
});

await test("a chat is badged with the PR its tracker id names, not its checkout's branch", async () => {
	const repo = await makeRepo("tracker-id", "main");
	git(["checkout", "-q", "-b", "tk-430"], repo);
	const subprocess = makeSubprocess(ghStubPath, log);
	const controller = createPrBadge({
		spawn: subprocess.spawn,
		resolveExecutable: subprocess.resolveExecutable,
		listSessions: async () => [
			{
				sessionId: "session-task-434",
				cwd: repo,
				title: "434 API регистра товаров: движения и остаток на дату",
			},
			{
				sessionId: "session-task-430",
				cwd: repo,
				title: "430 Rate limit и защита от флуда публичных эндпоинтов",
			},
			{ sessionId: "session-task-999", cwd: repo, title: "999 Нет такой задачи" },
		],
		debug: true,
	});
	const before = log.length;
	const { payload } = await call(controller, { url: "/pr-badge/api/states?debug=1" });
	const bySession = new Map(payload.entries.map((entry) => [entry.sessionId, entry]));
	const diagnostics = new Map(payload.diagnostics.map((row) => [row.sessionId, row]));

	// The checkout sits on tk-430 (PR 447); a chat about 434 must still get 435.
	assert.equal(bySession.get("session-task-434").number, 435);
	assert.equal(bySession.get("session-task-434").source, "task");
	assert.equal(bySession.get("session-task-434").state, "MERGED");
	assert.equal(bySession.get("session-task-434").task, 434);
	assert.equal(bySession.get("session-task-430").number, 447);
	assert.equal(bySession.get("session-task-430").source, "task");
	// A chat whose tracker id matches nothing never borrows the branch's PR.
	assert.equal(bySession.has("session-task-999"), false);
	assert.equal(diagnostics.get("session-task-999").reason, "ambient-branch");

	// One PR index for the whole repository, not one search per chat.
	const lists = ghCalls(log.slice(before)).filter((entry) => entry.args[1] === "list");
	assert.equal(lists.length, 1, "the repository index is fetched once");
	assert.deepEqual(lists[0].args.slice(2, 6), ["--state", "all", "--limit", "200"]);
	controller.shutdown();
});

await test("routing: loopback only, GET only, no unknown paths", async () => {
	const controller = makeController();
	const foreign = await call(controller, {
		url: "/pr-badge/api/states",
		host: "pr-badge.example.com",
	});
	assert.equal(foreign.status, 403);
	assert.match(foreign.payload.error, /local connections only/);

	const wrongMethod = await call(controller, { method: "POST", url: "/pr-badge/api/states" });
	assert.equal(wrongMethod.status, 404);

	const unknown = await call(controller, { url: "/pr-badge/api/nope" });
	assert.equal(unknown.status, 404);
	assert.match(unknown.payload.error, /no such pr-badge endpoint/);

	const localhost = await call(controller, { url: "/pr-badge/api/states", host: "localhost:3079" });
	assert.equal(localhost.status, 200);
	assert.equal(localhost.headers["cache-control"], "no-store");
	controller.shutdown();
});

await test("shutdown drops every cache", async () => {
	const controller = makeController();
	await call(controller, { url: "/pr-badge/api/states" });
	const before = ghCalls(log).length;
	controller.shutdown();
	await call(controller, { url: "/pr-badge/api/states" });
	assert.ok(ghCalls(log).length > before, "a cold controller probes again");
	controller.shutdown();
});

// A failing `gh` must never be mistaken for "no PR": both leave the row clean,
// but only one of them is worth telling the operator about.
await test("gh failures warn only when debug is on", async () => {
	const warnings = [];
	const controller = makeController({ debug: true, warn: (message) => warnings.push(message) });
	await call(controller, { url: "/pr-badge/api/states" });
	assert.ok(
		warnings.some((message) => /gh pr view feat-broken exited 1/.test(message)),
		`expected a warning about feat-broken, got: ${JSON.stringify(warnings)}`,
	);
	assert.equal(
		warnings.some((message) => /feat-nopr/.test(message)),
		false,
		'"no pull requests found" is normal, not a warning',
	);
	controller.shutdown();
});

await rm(scratch, { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} tests passed`);
