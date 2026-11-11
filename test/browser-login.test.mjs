import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	accountFromHost,
	isAccountHost,
	loginForSessionCookie,
	pickSessionCookieCandidates,
} from "../src/browser-login.mjs";

test("pickSessionCookieCandidates prefers the account host on the root path", () => {
	const cookies = [
		{ name: "JSESSIONID", domain: ".netsuite.com", path: "/", value: "shared" },
		{ name: "JSESSIONID", domain: "1234567.app.netsuite.com", path: "/app", value: "account-app" },
		{ name: "JSESSIONID", domain: "1234567.app.netsuite.com", path: "/", value: "account" },
	];

	assert.deepEqual(pickSessionCookieCandidates(cookies, "1234567"), ["account", "account-app", "shared"]);
});

test("pickSessionCookieCandidates falls back to any netsuite session", () => {
	const cookies = [{ name: "JSESSIONID", domain: ".netsuite.com", path: "/", value: "shared" }];

	assert.deepEqual(pickSessionCookieCandidates(cookies, "1234567"), ["shared"]);
});

test("pickSessionCookieCandidates ignores other accounts", () => {
	const cookies = [{ name: "JSESSIONID", domain: "123456.app.netsuite.com", path: "/", value: "other" }];

	assert.deepEqual(pickSessionCookieCandidates(cookies, "1234567"), []);
});

test("isAccountHost only accepts the account host", () => {
	assert.equal(isAccountHost("https://1234567.app.netsuite.com/app/center/card.nl?sc=62", "1234567"), true);
	assert.equal(isAccountHost("https://accounts.google.com/o/saml2/initsso?idpid=abc", "1234567"), false);
	assert.equal(isAccountHost("https://123456.app.netsuite.com/app/center/card.nl", "1234567"), false);
	assert.equal(isAccountHost("not a url", "1234567"), false);
});

test("accountFromHost reads the account from the landing url", () => {
	assert.equal(accountFromHost("https://1234567.app.netsuite.com/app/center/card.nl?sc=62"), "1234567");
	assert.equal(accountFromHost("https://1234567.app.netsuite.com/app/center/card.nl?sc=62#frag"), "1234567");
	assert.equal(accountFromHost("https://accounts.google.com/o/saml2/initsso?idpid=abc"), null);
	assert.equal(accountFromHost("https://netsuite.com"), null);
	assert.equal(accountFromHost("not a url"), null);
});

test("loginForSessionCookie needs a login url when no account is given", async () => {
	await assert.rejects(loginForSessionCookie({}), /needs the NetSuite sign-in page/);
});

test("loginForSessionCookie replays the login cookies before the page and remembers the new ones", async () => {
	const home = mkdtempSync(join(tmpdir(), "netsuite-browser-login-"));
	const loginCookiesPath = join(home, "login-cookies.json");
	writeFileSync(
		loginCookiesPath,
		JSON.stringify([{ name: "SID", value: "stored", domain: ".google.com", path: "/", expires: -1 }]),
	);
	const events = [];
	const page = {
		url: () => "https://1234567.app.netsuite.com/app/center/card.nl",
		goto: async () => events.push("goto"),
	};
	const browser = {
		newPage: async () => page,
		setCookie: async (...cookies) => events.push(`replay ${cookies.map((cookie) => cookie.name).join(",")}`),
		cookies: async () => [
			{ name: "JSESSIONID", value: "fresh", domain: "1234567.app.netsuite.com", path: "/" },
			{ name: "SID", value: "rotated", domain: ".google.com", path: "/", expires: -1 },
		],
		close: async () => events.push("close"),
	};

	const session = await loginForSessionCookie({
		account: "1234567",
		profileDirectory: join(home, "browser-profile"),
		loginCookiesPath,
		launch: async () => browser,
	});

	assert.deepEqual(session, { cookieHeader: "JSESSIONID=fresh", account: "1234567" });
	assert.deepEqual(events, ["replay SID", "goto", "close"]);
	assert.deepEqual(
		JSON.parse(readFileSync(loginCookiesPath, "utf8")).map((cookie) => cookie.value),
		["fresh", "rotated"],
	);
});
