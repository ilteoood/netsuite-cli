import { NetsuiteError } from "./errors.mjs";
import { browserHeaders, loginThroughBrowser, netsuiteUrl, resolveCookieHeader } from "./session.mjs";

const SUITEQL_PATH = "/services/rest/query/v1/suiteql";

const parseJson = (responseText) => {
	try {
		return JSON.parse(responseText);
	} catch {
		return undefined;
	}
};

const firstLine = (responseText) => {
	const payload = parseJson(responseText);
	const message =
		(typeof payload === "string" ? payload : null) ??
		payload?.message ??
		payload?.["o:errorDetails"]?.[0]?.detail ??
		payload?.title ??
		responseText;
	const [line = ""] = String(message).split("\n");
	return line.trim().slice(0, 400) || null;
};

const failed = (method, path, status, responseText) =>
	new NetsuiteError(`NetSuite ${method} ${path} failed with HTTP ${status}.`, {
		status,
		detail: firstLine(responseText),
	});

const responded = (response, body) => ({ ok: true, status: response.status, headers: response.headers, body });

const send = async (session, path, { method = "GET", body, headers = {}, asText = false } = {}) => {
	const hasBody = body !== undefined;
	let response;
	try {
		response = await fetch(netsuiteUrl(session.account, path), {
			method,
			headers: {
				...browserHeaders(session.cookieHeader),
				...(hasBody ? { "content-type": "application/json" } : {}),
				...headers,
			},
			...(hasBody ? { body: JSON.stringify(body) } : {}),
		});
	} catch (error) {
		throw new NetsuiteError(
			`NetSuite is unreachable (${method} ${netsuiteUrl(session.account, path)}): ${error.message}`,
		);
	}
	const responseText = await response.text();
	if (!response.ok) return { ok: false, status: response.status, responseText };
	if (asText) return responded(response, responseText);
	if (!responseText) return responded(response, null);
	const payload = parseJson(responseText);
	if (payload === undefined) {
		throw new NetsuiteError(`NetSuite ${method} ${path} answered with something that is not JSON.`, {
			status: response.status,
			detail: firstLine(responseText),
		});
	}
	return responded(response, payload);
};

const perform = async (session, relogin, path, options = {}) => {
	const method = options.method ?? "GET";
	const first = await send(session, path, options);
	if (first.ok) return first;
	if (first.status !== 401) throw failed(method, path, first.status, first.responseText);

	await relogin();

	const retried = await send(session, path, options);
	if (retried.ok) return retried;
	if (retried.status !== 401) throw failed(method, path, retried.status, retried.responseText);
	throw new NetsuiteError(
		`NetSuite rejected the fresh session (HTTP 401) on ${method} ${path}. Sign in to NetSuite by hand in the browser, then run the command again.`,
		{ status: 401, detail: firstLine(retried.responseText) },
	);
};

export const createClient = async ({ cookieFile, cookie, login } = {}) => {
	let session;
	try {
		session = await resolveCookieHeader({ cookieFile, cookie, login });
	} catch (error) {
		throw new NetsuiteError(`NetSuite session unavailable: ${error.message}`);
	}

	const relogin = async () => {
		let fresh;
		try {
			fresh = await loginThroughBrowser({ account: session.account, login });
		} catch (error) {
			throw new NetsuiteError(`The browser sign-in failed, so the session is still expired: ${error.message}`);
		}
		session.account = fresh.account;
		session.cookieHeader = fresh.cookieHeader;
		return session.account;
	};

	const requestRaw = (path, { method = "GET", body } = {}) => perform(session, relogin, path, { method, body });

	const request = async (path, options) => (await requestRaw(path, options)).body;

	const text = async (path) => (await perform(session, relogin, path, { asText: true })).body;

	const suiteql = async (query) => {
		const { body } = await perform(session, relogin, `${SUITEQL_PATH}?limit=1000`, {
			method: "POST",
			body: { q: query },
			headers: { prefer: "transient" },
		});
		return body?.items ?? [];
	};

	return { account: session.account, request, requestRaw, suiteql, text };
};
