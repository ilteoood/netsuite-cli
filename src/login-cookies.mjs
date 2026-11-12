import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LOGIN_COOKIE_PATH } from "./cache.mjs";

const REPLAYED_FIELDS = [
	"name",
	"value",
	"domain",
	"path",
	"expires",
	"httpOnly",
	"secure",
	"sameSite",
	"partitionKey",
];

const replayedCookie = (cookie) =>
	Object.fromEntries(
		REPLAYED_FIELDS.filter((field) => cookie[field] !== undefined).map((field) => [field, cookie[field]]),
	);

const isExpiredCookie = (cookie) => cookie.expires !== -1 && cookie.expires * 1000 <= Date.now();

const cookieFileContentsOf = (path) => {
	try {
		const stored = JSON.parse(readFileSync(path, "utf8"));
		return Array.isArray(stored) ? stored.filter((cookie) => typeof cookie?.name === "string") : [];
	} catch {
		return [];
	}
};

export const rememberLoginCookies = (cookies, { path = LOGIN_COOKIE_PATH } = {}) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cookies.map(replayedCookie)), { mode: 0o600 });
	chmodSync(path, 0o600);
};

export const restoreLoginCookies = async (browser, { path = LOGIN_COOKIE_PATH } = {}) => {
	const cookies = cookieFileContentsOf(path).filter((cookie) => !isExpiredCookie(cookie));
	if (cookies.length === 0) return 0;
	await browser.setCookie(...cookies);
	return cookies.length;
};
