import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.HOME = mkdtempSync(join(tmpdir(), "netsuite-session-"));

const { browserHeaders, loginThroughBrowser, netsuiteUrl, readCookieHeader } = await import("../src/session.mjs");

test("netsuiteUrl points at the account host", () => {
	assert.equal(netsuiteUrl("1234567", "/services/rest"), "https://1234567.app.netsuite.com/services/rest");
});

test("browserHeaders sends the cookie with a browser user agent", () => {
	const headers = browserHeaders("JSESSIONID=abc");

	assert.equal(headers.cookie, "JSESSIONID=abc");
	assert.match(headers["user-agent"], /Chrome\/\d+/);
});

test("readCookieHeader reads a cookie file and drops the copied prefix", () => {
	const directory = mkdtempSync(join(tmpdir(), "netsuite-cookie-"));
	const path = join(directory, "cookie.txt");
	writeFileSync(path, "cookie: JSESSIONID=abc\n");

	assert.equal(readCookieHeader({ cookieFile: path }), "JSESSIONID=abc");
});

test("readCookieHeader prefers the explicit cookie", () => {
	assert.equal(readCookieHeader({ cookie: " JSESSIONID=abc ", cookieFile: "/does/not/exist" }), "JSESSIONID=abc");
});

test("readCookieHeader returns null when no cookie is available", () => {
	const previous = process.env.NETSUITE_COOKIE;
	delete process.env.NETSUITE_COOKIE;

	try {
		assert.equal(readCookieHeader({}), null);
	} finally {
		if (previous !== undefined) process.env.NETSUITE_COOKIE = previous;
	}
});

test("loginThroughBrowser signs in, caches the session and returns it", async () => {
	const login = async (options) => {
		assert.equal(options.account, "1234567");
		assert.equal(typeof options.validate, "function");
		return { account: "1234567", cookieHeader: "JSESSIONID=new", executable: "/chrome" };
	};

	const session = await loginThroughBrowser({ account: "1234567", login });

	assert.deepEqual(session, { account: "1234567", cookieHeader: "JSESSIONID=new" });
	const cachePath = join(process.env.HOME, ".cache", "netsuite-cli", "session.json");
	assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), { account: "1234567", cookieHeader: "JSESSIONID=new" });
});
