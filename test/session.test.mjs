import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

process.env.HOME = mkdtempSync(join(tmpdir(), "netsuite-session-"));

const permissionsAreEnforced = process.platform !== "win32" && process.getuid?.() !== 0;

const { browserHeaders, loginThroughBrowser, netsuiteUrl, readCookieHeader, resolveCookieHeader, storedLoginUrl } =
	await import("../src/session.mjs");
const { clearCache, SESSION_CACHE_PATH } = await import("../src/cache.mjs");

test("netsuiteUrl points at the account host", () => {
	assert.strictEqual(netsuiteUrl("1234567", "/services/rest"), "https://1234567.app.netsuite.com/services/rest");
});

test("browserHeaders sends the cookie with a browser user agent", () => {
	const headers = browserHeaders("JSESSIONID=abc");

	assert.deepStrictEqual(
		{ cookie: headers.cookie, userAgentLooksLikeChrome: /Chrome\/\d+/.test(headers["user-agent"]) },
		{ cookie: "JSESSIONID=abc", userAgentLooksLikeChrome: true },
	);
});

test("readCookieHeader reads a cookie file and drops the copied prefix", () => {
	const directory = mkdtempSync(join(tmpdir(), "netsuite-cookie-"));
	const path = join(directory, "cookie.txt");
	writeFileSync(path, "cookie: JSESSIONID=abc\n");

	assert.strictEqual(readCookieHeader({ cookieFile: path }), "JSESSIONID=abc");
});

test("readCookieHeader prefers the explicit cookie", () => {
	assert.strictEqual(readCookieHeader({ cookie: " JSESSIONID=abc ", cookieFile: "/does/not/exist" }), "JSESSIONID=abc");
});

test("readCookieHeader returns null when no cookie is available", () => {
	const previous = process.env.NETSUITE_COOKIE;
	delete process.env.NETSUITE_COOKIE;

	try {
		assert.strictEqual(readCookieHeader({}), null);
	} finally {
		if (previous !== undefined) process.env.NETSUITE_COOKIE = previous;
	}
});

test("loginThroughBrowser signs in, caches the session and returns it", async () => {
	const seenOptions = [];
	const login = async (options) => {
		seenOptions.push(options);
		return { account: "1234567", cookieHeader: "JSESSIONID=new" };
	};

	const session = await loginThroughBrowser({ account: "1234567", login });

	assert.deepStrictEqual(
		{
			options: {
				account: seenOptions[0].account,
				headless: seenOptions[0].headless,
				hasValidate: typeof seenOptions[0].validate === "function",
			},
			session,
			cache: JSON.parse(readFileSync(SESSION_CACHE_PATH, "utf8")),
		},
		{
			options: { account: "1234567", headless: true, hasValidate: true },
			session: { account: "1234567", cookieHeader: "JSESSIONID=new" },
			cache: { account: "1234567", cookieHeader: "JSESSIONID=new", loginUrl: null },
		},
	);
});

test("loginThroughBrowser opens a window only when the caller asks for one", async () => {
	const signInOptions = [];
	const login = async (options) => {
		signInOptions.push(options);
		return { account: "1234567", cookieHeader: "JSESSIONID=new" };
	};

	await loginThroughBrowser({ account: "1234567", loginUrl: "https://example.test/sso", login });
	await loginThroughBrowser({
		account: "1234567",
		loginUrl: "https://example.test/sso",
		login,
		headless: false,
	});

	assert.deepStrictEqual(
		signInOptions.map((options) => options.headless),
		[true, false],
	);
});

test("loginThroughBrowser stores the login page and reuses it on the next sign-in", async () => {
	const seenLoginUrls = [];
	const login = async (options) => {
		seenLoginUrls.push(options.loginUrl);
		return { account: "1234567", cookieHeader: "JSESSIONID=new" };
	};

	await loginThroughBrowser({ account: "1234567", loginUrl: "https://example.test/sso", login });
	await loginThroughBrowser({ account: "1234567", login });

	assert.deepStrictEqual(
		{ seenLoginUrls, storedLoginUrl: storedLoginUrl() },
		{
			seenLoginUrls: ["https://example.test/sso", "https://example.test/sso"],
			storedLoginUrl: "https://example.test/sso",
		},
	);
});

test("resolveCookieHeader signs in with the cached account when no login page is stored", async () => {
	const originalFetch = globalThis.fetch;
	const originalCookie = process.env.NETSUITE_COOKIE;
	globalThis.fetch = async () => {
		throw new Error("offline");
	};
	delete process.env.NETSUITE_COOKIE;
	let signInOptions = null;
	const login = async (options) => {
		signInOptions = options;
		return { account: "1234567", cookieHeader: "JSESSIONID=fresh" };
	};

	try {
		mkdirSync(dirname(SESSION_CACHE_PATH), { recursive: true });
		writeFileSync(SESSION_CACHE_PATH, JSON.stringify({ account: "1234567", cookieHeader: "JSESSIONID=stale" }));
		const session = await resolveCookieHeader({ login });

		assert.deepStrictEqual(
			{
				account: signInOptions.account,
				loginUrl: signInOptions.loginUrl,
				cookieHeader: session.cookieHeader,
			},
			{ account: "1234567", loginUrl: null, cookieHeader: "JSESSIONID=fresh" },
		);
	} finally {
		globalThis.fetch = originalFetch;
		if (originalCookie !== undefined) process.env.NETSUITE_COOKIE = originalCookie;
	}
});

test("clearCache removes the cache directory and reports whether it existed", () => {
	const directory = join(mkdtempSync(join(tmpdir(), "netsuite-clear-")), "netsuite-cli");
	mkdirSync(join(directory, "browser-profile"), { recursive: true });

	assert.deepStrictEqual(
		{
			first: clearCache({ directory }),
			stillThere: existsSync(directory),
			second: clearCache({ directory }),
		},
		{
			first: { removed: true, directory },
			stillThere: false,
			second: { removed: false, directory },
		},
	);
});

test("clearCache refuses a directory that is not a netsuite-cli cache", () => {
	const directory = join(mkdtempSync(join(tmpdir(), "netsuite-clear-")), "other-app");
	mkdirSync(directory, { recursive: true });

	assert.throws(() => clearCache({ directory }), /only a netsuite-cli cache directory can be cleared/);
	assert.strictEqual(existsSync(directory), true);
});

test("clearCache explains a removal that failed", {
	skip: permissionsAreEnforced ? false : "the platform does not enforce directory permissions",
}, () => {
	const parent = mkdtempSync(join(tmpdir(), "netsuite-clear-"));
	const directory = join(parent, "netsuite-cli");
	mkdirSync(directory, { recursive: true });
	chmodSync(parent, 0o500);

	try {
		assert.throws(
			() => clearCache({ directory }),
			/Could not remove .*: EACCES\. Close every Chrome window and try again\./,
		);
	} finally {
		chmodSync(parent, 0o700);
	}
});
