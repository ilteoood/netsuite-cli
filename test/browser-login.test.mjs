import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import puppeteer from "puppeteer";
import {
	accountFromHost,
	isAccountHost,
	loginForSessionCookie,
	pickSessionCookieCandidates,
} from "../src/browser-login.mjs";

test("loginForSessionCookie launches the browser headless unless a window is asked for", async () => {
	const launches = [];
	const originalLaunch = puppeteer.launch;
	puppeteer.launch = async (launchOptions) => {
		launches.push(launchOptions);
		throw new Error("no browser in the test");
	};
	const profileDirectory = mkdtempSync(join(tmpdir(), "netsuite-browser-"));
	try {
		await assert.rejects(
			() => loginForSessionCookie({ account: "1234567", profileDirectory }),
			/The browser could not be started/,
		);
		await assert.rejects(
			() => loginForSessionCookie({ account: "1234567", profileDirectory, headless: false }),
			/The browser could not be started/,
		);
	} finally {
		puppeteer.launch = originalLaunch;
		rmSync(profileDirectory, { recursive: true, force: true });
	}

	assert.deepStrictEqual(
		{
			headless: launches[0].headless,
			userDataDir: launches[0].userDataDir,
			windowedHeadless: launches[1].headless,
		},
		{ headless: true, userDataDir: profileDirectory, windowedHeadless: false },
	);
});

test("pickSessionCookieCandidates prefers the account host on the root path", () => {
	const cookies = [
		{ name: "JSESSIONID", domain: ".netsuite.com", path: "/", value: "shared" },
		{ name: "JSESSIONID", domain: "1234567.app.netsuite.com", path: "/app", value: "account-app" },
		{ name: "JSESSIONID", domain: "1234567.app.netsuite.com", path: "/", value: "account" },
	];

	assert.deepStrictEqual(pickSessionCookieCandidates(cookies, "1234567"), ["account", "account-app", "shared"]);
});

test("pickSessionCookieCandidates falls back to any netsuite session", () => {
	const cookies = [{ name: "JSESSIONID", domain: ".netsuite.com", path: "/", value: "shared" }];

	assert.deepStrictEqual(pickSessionCookieCandidates(cookies, "1234567"), ["shared"]);
});

test("pickSessionCookieCandidates ignores other accounts", () => {
	const cookies = [{ name: "JSESSIONID", domain: "123456.app.netsuite.com", path: "/", value: "other" }];

	assert.deepStrictEqual(pickSessionCookieCandidates(cookies, "1234567"), []);
});

test("isAccountHost only accepts the account host", () => {
	assert.deepStrictEqual(
		{
			accountHost: isAccountHost("https://1234567.app.netsuite.com/app/center/card.nl?sc=62", "1234567"),
			identityProvider: isAccountHost("https://accounts.google.com/o/saml2/initsso?idpid=abc", "1234567"),
			otherAccount: isAccountHost("https://123456.app.netsuite.com/app/center/card.nl", "1234567"),
			notAUrl: isAccountHost("not a url", "1234567"),
		},
		{ accountHost: true, identityProvider: false, otherAccount: false, notAUrl: false },
	);
});

test("accountFromHost reads the account from the landing url", () => {
	assert.deepStrictEqual(
		{
			landingUrl: accountFromHost("https://1234567.app.netsuite.com/app/center/card.nl?sc=62"),
			landingUrlWithFragment: accountFromHost("https://1234567.app.netsuite.com/app/center/card.nl?sc=62#frag"),
			identityProvider: accountFromHost("https://accounts.google.com/o/saml2/initsso?idpid=abc"),
			netsuiteRoot: accountFromHost("https://netsuite.com"),
			notAUrl: accountFromHost("not a url"),
		},
		{
			landingUrl: "1234567",
			landingUrlWithFragment: "1234567",
			identityProvider: null,
			netsuiteRoot: null,
			notAUrl: null,
		},
	);
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
	const originalLaunch = puppeteer.launch;
	puppeteer.launch = async () => browser;

	try {
		const session = await loginForSessionCookie({
			account: "1234567",
			profileDirectory: join(home, "browser-profile"),
			loginCookiesPath,
		});

		assert.deepStrictEqual(
			{
				session,
				events,
				stored: JSON.parse(readFileSync(loginCookiesPath, "utf8")).map((cookie) => cookie.value),
			},
			{
				session: { cookieHeader: "JSESSIONID=fresh", account: "1234567" },
				events: ["replay SID", "goto", "close"],
				stored: ["fresh", "rotated"],
			},
		);
	} finally {
		puppeteer.launch = originalLaunch;
		rmSync(home, { recursive: true, force: true });
	}
});
