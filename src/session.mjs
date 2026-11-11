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

const readSessionFile = () => {
	try {
		const cached = JSON.parse(readFileSync(SESSION_CACHE_PATH, "utf8"));
		return typeof cached === "object" && cached !== null ? cached : null;
	} catch {
		return null;
	}
};

const readCachedSession = () => {
	const cached = readSessionFile();
	return cached?.account && cached?.cookieHeader ? cached : null;
};

export const isNetsuiteLoginUrl = (value) => {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
};

export const storedLoginUrl = () => {
	const loginUrl = readSessionFile()?.loginUrl;
	return isNetsuiteLoginUrl(loginUrl) ? loginUrl : null;
};

const writeCachedSession = (account, cookieHeader, loginUrl) => {
	mkdirSync(CACHE_DIRECTORY, { recursive: true });
	writeFileSync(SESSION_CACHE_PATH, JSON.stringify({ account, cookieHeader, loginUrl }), { mode: 0o600 });
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

export const loginThroughBrowser = async ({ account = null, loginUrl = null, login = null, ...options } = {}) => {
	const signIn = login ?? (await import("./browser-login.mjs")).loginForSessionCookie;
	const signInUrl = loginUrl ?? storedLoginUrl();
	const session = await signIn({
		...options,
		account,
		loginUrl: signInUrl,
		validate: (candidate, candidateAccount) => probeSession(candidateAccount, candidate),
	});
	writeCachedSession(session.account, session.cookieHeader, signInUrl);
	return { account: session.account, cookieHeader: session.cookieHeader };
};

export const resolveCookieHeader = async (options = {}) => {
	const { login, ...sessionOptions } = options;
	const cached = readCachedSession();
	const account = cached?.account ?? null;
	const provided = readCookieHeader(sessionOptions);
	if (provided) {
		if (!account) {
			throw new Error(
				'A cookie was given without an account, so there is no host to send it to. Run "netsuite-cli login <url>" and sign in through the browser once instead.',
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
	return loginThroughBrowser({ ...sessionOptions, account: cached?.account ?? null, login });
};
