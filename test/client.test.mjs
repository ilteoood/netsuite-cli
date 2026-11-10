import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

const account = "1234567";
const home = mkdtempSync(join(tmpdir(), "netsuite-client-"));
process.env.HOME = home;
const cacheDirectory = join(home, ".cache", "netsuite-cli");
const cachePath = join(cacheDirectory, "session.json");
mkdirSync(cacheDirectory, { recursive: true });

const { createClient } = await import("../src/client.mjs");
const { NetsuiteError } = await import("../src/errors.mjs");

const stubFetch = (responses) => {
	const calls = [];
	globalThis.fetch = async (url, options = {}) => {
		calls.push({ url: String(url), options });
		const next = responses.shift();
		assert.ok(next, `unexpected fetch to ${url}`);
		const headers = next.location ? { location: next.location } : undefined;
		return new Response(next.body || null, { status: next.status, headers });
	};
	return calls;
};

const countLogins = () => {
	const login = async () => {
		login.calls += 1;
		return { account, cookieHeader: "JSESSIONID=fresh" };
	};
	login.calls = 0;
	return login;
};

beforeEach(() => {
	writeFileSync(cachePath, JSON.stringify({ account, cookieHeader: "JSESSIONID=cached" }));
});

test("a 401 logs in again once and replays the request", async () => {
	const calls = stubFetch([
		{ status: 200, body: "" },
		{ status: 401, body: "" },
		{ status: 200, body: JSON.stringify({ items: [{ id: "1" }] }) },
	]);
	const login = countLogins();
	const client = await createClient({ login });

	assert.equal(client.account, account);
	assert.deepEqual(await client.suiteql("SELECT id FROM timesheet"), [{ id: "1" }]);
	assert.equal(login.calls, 1);
	assert.equal(calls.length, 3);
	assert.equal(calls[2].url, `https://${account}.app.netsuite.com/services/rest/query/v1/suiteql?limit=1000`);
	assert.equal(calls[2].options.method, "POST");
	assert.equal(calls[2].options.headers.cookie, "JSESSIONID=fresh");
	assert.equal(calls[2].options.headers.prefer, "transient");
	assert.deepEqual(JSON.parse(calls[2].options.body), { q: "SELECT id FROM timesheet" });
	assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).cookieHeader, "JSESSIONID=fresh");
});

test("a second 401 throws instead of logging in a third time", async () => {
	stubFetch([
		{ status: 200, body: "" },
		{ status: 401, body: "" },
		{ status: 401, body: "" },
	]);
	const login = countLogins();
	const client = await createClient({ login });

	await assert.rejects(client.suiteql("SELECT 1"), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.equal(error.status, 401);
		assert.match(error.message, /sign in to netsuite by hand/i);
		return true;
	});
	assert.equal(login.calls, 1);
});

test("a 403 carries the status and the first line of NetSuite's message", async () => {
	const detail = "Permission Violation: You need the 'Lists -> Projects' permission.";
	stubFetch([
		{ status: 200, body: "" },
		{
			status: 403,
			body: JSON.stringify({ title: "Forbidden", "o:errorDetails": [{ detail: `${detail}\nAsk an administrator.` }] }),
		},
	]);
	const login = countLogins();
	const client = await createClient({ login });

	await assert.rejects(client.request("/services/rest/record/v1/job"), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.equal(error.status, 403);
		assert.equal(error.detail, detail);
		return true;
	});
	assert.equal(login.calls, 0);
});

test("a 500 carries the status and the first line of NetSuite's message", async () => {
	stubFetch([
		{ status: 200, body: "" },
		{ status: 500, body: JSON.stringify({ message: "Unexpected internal error\nstack trace follows" }) },
	]);
	const login = countLogins();
	const client = await createClient({ login });

	await assert.rejects(client.request("/services/rest/record/v1/timesheet/7"), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.equal(error.status, 500);
		assert.equal(error.detail, "Unexpected internal error");
		return true;
	});
	assert.equal(login.calls, 0);
});

test("suiteql returns no rows when NetSuite sends no items", async () => {
	stubFetch([
		{ status: 200, body: "" },
		{ status: 200, body: JSON.stringify({ count: 0 }) },
	]);
	const client = await createClient({ login: countLogins() });

	assert.deepEqual(await client.suiteql("SELECT 1"), []);
});

test("an empty body resolves to null", async () => {
	stubFetch([
		{ status: 200, body: "" },
		{ status: 200, body: "" },
	]);
	const client = await createClient({ login: countLogins() });

	assert.equal(await client.request("/services/rest/record/v1/timesheet/7"), null);
});

test("a browser sign-in that cannot start is a NetsuiteError, not a raw error", async () => {
	stubFetch([
		{ status: 200, body: "" },
		{ status: 401, body: "" },
	]);
	const client = await createClient({
		login: async () => {
			throw new Error(
				"The browser could not be started (profile in use). Close every window that uses the login profile and run the command again.",
			);
		},
	});

	await assert.rejects(client.request("/services/rest/record/v1/timesheet/7"), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.match(error.message, /browser sign-in failed/i);
		assert.match(error.message, /profile in use/);
		return true;
	});
});

test("requestRaw exposes the status and the Location header of a create", async () => {
	const calls = stubFetch([
		{ status: 200, body: "" },
		{
			status: 204,
			body: "",
			location: `https://${account}.app.netsuite.com/services/rest/record/v1/customrecord/84520`,
		},
	]);
	const client = await createClient({ login: countLogins() });

	const created = await client.requestRaw("/services/rest/record/v1/customrecord", {
		method: "POST",
		body: { name: "x" },
	});

	assert.equal(calls.length, 2);
	assert.equal(created.status, 204);
	assert.equal(created.body, null);
	assert.match(created.headers.get("location"), /\/customrecord\/84520$/);
});

test("text returns the raw page instead of parsing it as JSON", async () => {
	stubFetch([
		{ status: 200, body: "" },
		{ status: 200, body: "<html><body>weekly</body></html>" },
	]);
	const client = await createClient({ login: countLogins() });

	assert.equal(await client.text("/time/weeklytimebill.nl?id=7&e=T"), "<html><body>weekly</body></html>");
});
