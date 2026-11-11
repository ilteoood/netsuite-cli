import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rememberLoginCookies, restoreLoginCookies } from "../src/login-cookies.mjs";

const temporaryPath = () => join(mkdtempSync(join(tmpdir(), "netsuite-login-cookies-")), "login-cookies.json");

const fakeBrowser = () => {
	const replayed = [];
	return { replayed, setCookie: async (...cookies) => replayed.push(...cookies) };
};

test("rememberLoginCookies keeps the replayable fields and drops the chrome bookkeeping", () => {
	const path = temporaryPath();

	rememberLoginCookies(
		[
			{
				name: "SID",
				value: "google-session",
				domain: ".google.com",
				path: "/",
				expires: 1893456000,
				httpOnly: true,
				secure: true,
				sameSite: "None",
				size: 20,
				session: false,
				priority: "Medium",
			},
		],
		{ path },
	);

	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), [
		{
			name: "SID",
			value: "google-session",
			domain: ".google.com",
			path: "/",
			expires: 1893456000,
			httpOnly: true,
			secure: true,
			sameSite: "None",
		},
	]);
	assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("restoreLoginCookies replays the stored cookies on another machine", async () => {
	const path = temporaryPath();
	writeFileSync(
		path,
		JSON.stringify([
			{ name: "SID", value: "google-session", domain: ".google.com", path: "/", expires: -1 },
			{ name: "JSESSIONID", value: "abc", domain: "1234567.app.netsuite.com", path: "/", expires: 1893456000 },
		]),
	);
	const browser = fakeBrowser();

	const replayed = await restoreLoginCookies(browser, { path });

	assert.equal(replayed, 2);
	assert.deepEqual(
		browser.replayed.map((cookie) => cookie.name),
		["SID", "JSESSIONID"],
	);
});

test("restoreLoginCookies leaves the expired cookies out", async () => {
	const path = temporaryPath();
	writeFileSync(
		path,
		JSON.stringify([
			{ name: "SID", value: "expired", domain: ".google.com", path: "/", expires: 1 },
			{ name: "HSID", value: "alive", domain: ".google.com", path: "/", expires: 1893456000 },
		]),
	);
	const browser = fakeBrowser();

	await restoreLoginCookies(browser, { path });

	assert.deepEqual(
		browser.replayed.map((cookie) => cookie.value),
		["alive"],
	);
});

test("restoreLoginCookies writes nothing when the file is missing, corrupt or fully expired", async () => {
	const missing = fakeBrowser();
	assert.equal(await restoreLoginCookies(missing, { path: temporaryPath() }), 0);

	const corruptPath = temporaryPath();
	writeFileSync(corruptPath, "not json");
	const corrupt = fakeBrowser();
	assert.equal(await restoreLoginCookies(corrupt, { path: corruptPath }), 0);

	const expiredPath = temporaryPath();
	writeFileSync(expiredPath, JSON.stringify([{ name: "SID", value: "old", expires: 1 }]));
	const expired = fakeBrowser();
	assert.equal(await restoreLoginCookies(expired, { path: expiredPath }), 0);

	assert.deepEqual([missing.replayed, corrupt.replayed, expired.replayed], [[], [], []]);
});
