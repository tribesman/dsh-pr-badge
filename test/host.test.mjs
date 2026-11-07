import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, inject } from "../lib/index.js";

/** Minimal request the route reads: method and URL only. */
function request(method, url) {
	return { method, url, headers: {} };
}

/**
 * Response recorder standing in for a node `ServerResponse`.
 * @returns the recorded status, headers and body plus the response itself.
 */
function recorder() {
	const state = { status: 0, headers: {}, body: "" };
	const res = {
		headersSent: false,
		writableEnded: false,
		writeHead(status, headers) {
			state.status = status;
			state.headers = headers ?? {};
			res.headersSent = true;
		},
		end(chunk) {
			state.body = chunk === undefined ? "" : String(chunk);
			res.writableEnded = true;
		}
	};
	return { state, res };
}

/**
 * Run the plugin's route with a stub host context.
 * @param records - Session records the query service reports.
 * @param req - the request to answer.
 * @returns the recorded response.
 */
async function callRoute(records, req) {
	let handler;
	let disposed = false;
	const ctx = {
		webServer: {
			register(route) {
				assert.equal(route.kind, "prefix");
				assert.equal(route.path, "/pr-badge");
				handler = route.handler;
				return () => {
					disposed = true;
				};
			}
		},
		sessionQuery: {
			async listSessions() {
				return records;
			}
		},
		on(event) {
			assert.equal(event, "dispose");
		}
	};
	apply(ctx);
	assert.equal(typeof handler, "function");
	const { state, res } = recorder();
	await handler(req, res);
	assert.equal(disposed, false);
	return state;
}

test("declares the services it reads", () => {
	assert.deepEqual([...inject], ["webServer", "sessionQuery"]);
});

test("answers a Session without a checkout with empty coordinates", async () => {
	const state = await callRoute([{ header: { id: "s1", cwd: "" } }], request("GET", "/pr-badge/api/states"));
	assert.equal(state.status, 200);
	assert.match(state.headers["content-type"], /application\/json/);
	assert.deepEqual(JSON.parse(state.body), { states: { s1: { branch: null, pr: null } } });
});

test("answers a changed directory outside any repository without a branch", async () => {
	const state = await callRoute(
		[{ header: { id: "s2", cwd: "/nonexistent-directory-for-pr-badge-tests" } }],
		request("GET", "/pr-badge/api/states")
	);
	assert.equal(state.status, 200);
	assert.deepEqual(JSON.parse(state.body), { states: { s2: { branch: null, pr: null } } });
});

test("skips records without a usable Session id", async () => {
	const state = await callRoute(
		[{ header: { cwd: "/tmp" } }, { header: { id: "", cwd: "/tmp" } }],
		request("GET", "/pr-badge/api/states")
	);
	assert.equal(state.status, 200);
	assert.deepEqual(JSON.parse(state.body), { states: {} });
});

test("refuses a method other than GET or HEAD", async () => {
	const state = await callRoute([], request("POST", "/pr-badge/api/states"));
	assert.equal(state.status, 405);
	assert.match(state.body, /Use GET/);
});

test("answers 404 for an unknown path under its prefix", async () => {
	const state = await callRoute([], request("GET", "/pr-badge/api/other"));
	assert.equal(state.status, 404);
});
