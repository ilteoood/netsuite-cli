import { mkdirSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import puppeteer from "puppeteer";
import { BROWSER_PROFILE_DIRECTORY } from "./cache.mjs";

const LOGIN_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 2000;

const sessionRank = (cookie, host) => {
	const onAccountHost = cookie.domain === host || cookie.domain === `.${host}`;
	if (onAccountHost && cookie.path === "/") return 0;
	if (onAccountHost) return 1;
	if (cookie.domain === ".netsuite.com" && cookie.path === "/") return 2;
	return Number.POSITIVE_INFINITY;
};

export const pickSessionCookieCandidates = (cookies, account) => {
	const host = `${account}.app.netsuite.com`;
	return cookies
		.filter((cookie) => cookie.name === "JSESSIONID" && Number.isFinite(sessionRank(cookie, host)))
		.sort((left, right) => sessionRank(left, host) - sessionRank(right, host))
		.map((cookie) => cookie.value)
		.filter((value, index, values) => values.indexOf(value) === index);
};

export const isAccountHost = (pageUrl, account) => {
	try {
		return new URL(pageUrl).host === `${account}.app.netsuite.com`;
	} catch {
		return false;
	}
};

export const accountFromHost = (pageUrl) => {
	try {
		return /^(\d+)\.app\.netsuite\.com$/.exec(new URL(pageUrl).host)?.[1] ?? null;
	} catch {
		return null;
	}
};

const readSessionCookies = async (browser) => {
	try {
		return await browser.cookies();
	} catch (error) {
		throw new Error(
			`The browser closed before the NetSuite session appeared (${error.message}). Run the command again and leave the window open until it closes by itself.`,
		);
	}
};

export const loginForSessionCookie = async (options = {}) => {
	if (!options.account && !options.loginUrl) {
		throw new Error(
			"Signing in needs loginUrl in the configuration when no account is set, because the account is only known once the browser lands on it.",
		);
	}
	const browserPath = options.browserPath ?? process.env.NETSUITE_BROWSER;
	const profileDirectory = options.profileDirectory ?? BROWSER_PROFILE_DIRECTORY;
	mkdirSync(profileDirectory, { recursive: true });
	const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
	const validate = options.validate ?? (() => true);
	const loginUrl =
		options.loginUrl ?? `https://${options.account}.app.netsuite.com/app/accounting/transactions/weeklytimelist.nl`;

	let browser;
	try {
		browser = await puppeteer.launch({
			executablePath: browserPath,
			userDataDir: profileDirectory,
			headless: false,
			args: ["--no-first-run", "--no-default-browser-check"],
		});
	} catch (error) {
		throw new Error(
			`The browser could not be started (${error.message}). Close every window that uses the login profile and run the command again.`,
		);
	}

	try {
		const page = await browser.newPage();
		await page.goto(loginUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const account = options.account ?? accountFromHost(page.url());
			if (account && isAccountHost(page.url(), account)) {
				for (const candidate of pickSessionCookieCandidates(await readSessionCookies(browser), account)) {
					if (await validate(`JSESSIONID=${candidate}`, account)) {
						return { cookieHeader: `JSESSIONID=${candidate}`, account };
					}
				}
			}
			await setTimeout(POLL_INTERVAL_MS);
		}
		throw new Error(
			"No signed-in NetSuite session was captured. Log into NetSuite in the browser window that opened, then run the command again.",
		);
	} finally {
		await browser.close();
	}
};
