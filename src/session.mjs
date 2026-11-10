import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CACHE_DIRECTORY, SESSION_CACHE_PATH } from "./cache.mjs";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const SESSION_PROBE_PATH = "/services/rest/query/v1/suiteql";
const SESSION_PROBE_QUERY = "SELECT id FROM timesheet WHERE id = 1";

export const netsuiteUrl = (account, path) => `https://${account}.app.netsuite.com${path}`;

export const browserHeaders = (cookieHeader) => ({ cookie: cookieHeader, "user-agent": USER_AGENT });

export const readCookieHeader = ({ cookie, cookieFile } = {}) => {
	if (cookie) return cookie.trim();
	if (cookieFile)
		return readFileSync(cookieFile, "utf8")
			.trim()
			.replace(/^cookie:\s*/i, "");
	if (process.env.NETSUITE_COOKIE) return process.env.NETSUITE_COOKIE.trim();
	return null;
};

const readCachedSession = () => {
	try {
		const cached = JSON.parse(readFileSync(SESSION_CACHE_PATH, "utf8"));
		return cached.account && cached.cookieHeader ? cached : null;
	} catch {
		return null;
	}
};

const writeCachedSession = (account, cookieHeader) => {
	mkdirSync(CACHE_DIRECTORY, { recursive: true });
	writeFileSync(SESSION_CACHE_PATH, JSON.stringify({ account, cookieHeader }), { mode: 0o600 });
	chmodSync(SESSION_CACHE_PATH, 0o600);
};

export const probeSession = async (account, cookieHeader) => {
	const response = await fetch(netsuiteUrl(account, SESSION_PROBE_PATH), {
		method: "POST",
		headers: { ...browserHeaders(cookieHeader), "content-type": "application/json", prefer: "transient" },
		body: JSON.stringify({ q: SESSION_PROBE_QUERY }),
	});
	if (response.status === 200) return true;
	if (response.status === 401 || response.status === 403) return false;
	throw new Error(`NetSuite session probe failed with HTTP ${response.status}.`);
};

const assertSessionIsValid = async (account, cookieHeader) => {
	if (await probeSession(account, cookieHeader)) return;
	throw new Error(
		"NetSuite rejected the session cookie (it expired). Copy a fresh Cookie header and retry, or run without one to log in through the browser. Only the JSESSIONID cookie is needed.",
	);
};

export const loginThroughBrowser = async ({ account = null, login = null, ...options } = {}) => {
	const signIn = login ?? (await import("./browser-login.mjs")).loginForSessionCookie;
	const session = await signIn({
		...options,
		account,
		validate: (candidate, candidateAccount) => probeSession(candidateAccount, candidate),
	});
	writeCachedSession(session.account, session.cookieHeader);
	return { account: session.account, cookieHeader: session.cookieHeader };
};

export const resolveCookieHeader = async (configuredAccount, options = {}) => {
	const { login, ...sessionOptions } = options;
	const cached = readCachedSession();
	const account = configuredAccount ?? cached?.account ?? null;
	const provided = readCookieHeader(sessionOptions);
	if (provided) {
		if (!account) {
			throw new Error(
				"A cookie was given without an account, so there is no host to send it to. Sign in through the browser once instead.",
			);
		}
		await assertSessionIsValid(account, provided);
		return { account, cookieHeader: provided };
	}

	if (cached) {
		try {
			await assertSessionIsValid(cached.account, cached.cookieHeader);
			return { account: cached.account, cookieHeader: cached.cookieHeader };
		} catch {
			// The cached session expired, fall through to a fresh browser login.
		}
	}
	return loginThroughBrowser({ ...sessionOptions, account: configuredAccount ?? null, login });
};
