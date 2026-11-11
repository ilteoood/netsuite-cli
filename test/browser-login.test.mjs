import assert from "node:assert/strict";
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
