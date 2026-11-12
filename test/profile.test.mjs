import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { create, list } from "tar";
import { buildProgram } from "../bin/netsuite-cli.mjs";

const binary = fileURLToPath(new URL("../bin/netsuite-cli.mjs", import.meta.url));
const isolatedHome = (home) => ({ ...process.env, HOME: home, USERPROFILE: home });
const runIn = (home, ...argv) =>
	spawnSync(process.execPath, [binary, ...argv], { encoding: "utf8", env: isolatedHome(home) });
const temporaryHome = () => mkdtempSync(join(tmpdir(), "netsuite-profile-"));
const cacheOf = (home) => join(home, ".cache", "netsuite-cli");
const cookieOf = (home) => join(cacheOf(home), "browser-profile", "Default", "Cookies");

const loginCookieOf = (home) => join(cacheOf(home), "login-cookies.json");

const seedProfile = (home, { session = true, loginCookies = false } = {}) => {
	mkdirSync(join(cacheOf(home), "browser-profile", "Default", "Cache"), { recursive: true });
	writeFileSync(join(cacheOf(home), "browser-profile", "Default", "Cookies"), "cookie-data");
	writeFileSync(join(cacheOf(home), "browser-profile", "Default", "Cache", "blob"), "throwaway");
	if (session === true) {
		writeFileSync(
			join(cacheOf(home), "session.json"),
			JSON.stringify({ account: "Acme", cookieHeader: "JSESSIONID=abc" }),
		);
	}
	if (loginCookies === true) {
		writeFileSync(loginCookieOf(home), JSON.stringify([{ name: "SID", value: "google-session" }]), { mode: 0o600 });
	}
};

const membersOf = (archive) => {
	const members = [];
	list({ file: archive, sync: true, onReadEntry: (entry) => members.push(entry.path) });
	return members;
};

const exportProfile = (home) => {
	const archive = join(home, "profile.tar.gz");
	return { archive, result: runIn(home, "profile", "export", archive) };
};

test("the export writes an archive with the profile and the session, without the chrome caches", () => {
	const home = temporaryHome();
	seedProfile(home);

	const { archive, result } = exportProfile(home);
	const members = membersOf(archive);

	assert.deepStrictEqual(
		{
			status: result.status,
			printsTheArchive: result.stdout.startsWith("Exported the browser profile to "),
			hasTheCookies: members.includes("browser-profile/Default/Cookies"),
			hasTheSession: members.includes("session.json"),
			keepsTheChromeCaches: members.filter((member) => member.includes("Cache/")),
			mode: statSync(archive).mode & 0o777,
		},
		{
			status: 0,
			printsTheArchive: true,
			hasTheCookies: true,
			hasTheSession: true,
			keepsTheChromeCaches: [],
			mode: 0o600,
		},
	);
});

test("the export works without a cached session and leaves it out of the archive", () => {
	const home = temporaryHome();
	seedProfile(home, { session: false });

	const { archive, result } = exportProfile(home);

	assert.deepStrictEqual(
		{
			status: result.status,
			hasTheSession: membersOf(archive).includes("session.json"),
		},
		{ status: 0, hasTheSession: false },
	);
});

test("the export archives the login cookies of the machine", () => {
	const home = temporaryHome();
	seedProfile(home, { loginCookies: true });

	const { archive, result } = exportProfile(home);

	assert.deepStrictEqual(
		{
			status: result.status,
			hasTheLoginCookies: membersOf(archive).includes("login-cookies.json"),
		},
		{ status: 0, hasTheLoginCookies: true },
	);
});

test("the export leaves the login cookies out when the machine has none", () => {
	const home = temporaryHome();
	seedProfile(home);

	const { archive, result } = exportProfile(home);

	assert.deepStrictEqual(
		{
			status: result.status,
			hasTheLoginCookies: membersOf(archive).includes("login-cookies.json"),
		},
		{ status: 0, hasTheLoginCookies: false },
	);
});

test("the export refuses when there is no browser profile yet", () => {
	const home = temporaryHome();

	const result = runIn(home, "profile", "export", join(home, "profile.tar.gz"));

	assert.deepStrictEqual(
		{ status: result.status, stderr: result.stderr },
		{
			status: 2,
			stderr:
				'netsuite-cli: There is no browser profile to export yet. Sign in first with "netsuite-cli login <url>".\n',
		},
	);
});

test("the export prints the archive as JSON with --json", () => {
	const home = temporaryHome();
	seedProfile(home);
	const archive = join(home, "profile.tar.gz");

	const result = runIn(home, "--json", "profile", "export", archive);
	const printed = JSON.parse(result.stdout);

	assert.deepStrictEqual(
		{
			status: result.status,
			archive: printed.archive,
			bytesIsANumber: typeof printed.bytes === "number",
		},
		{ status: 0, archive, bytesIsANumber: true },
	);
});

test("the import restores the profile and the session on a machine without one", () => {
	const source = temporaryHome();
	seedProfile(source);
	const exported = exportProfile(source);
	const target = temporaryHome();

	const result = runIn(target, "profile", "import", exported.archive);

	assert.deepStrictEqual(
		{
			status: result.status,
			stdout: result.stdout,
			cookie: readFileSync(cookieOf(target), "utf8"),
			session: JSON.parse(readFileSync(join(cacheOf(target), "session.json"), "utf8")),
		},
		{
			status: 0,
			stdout: `Imported the browser profile into ${join(cacheOf(target), "browser-profile")} and the cached session\n`,
			cookie: "cookie-data",
			session: { account: "Acme", cookieHeader: "JSESSIONID=abc" },
		},
	);
});

test("the import restores the login cookies readable only by the owner", () => {
	const source = temporaryHome();
	seedProfile(source, { loginCookies: true });
	const exported = exportProfile(source);
	const target = temporaryHome();

	const result = runIn(target, "profile", "import", exported.archive);

	assert.deepStrictEqual(
		{
			status: result.status,
			stdout: result.stdout,
			loginCookies: JSON.parse(readFileSync(loginCookieOf(target), "utf8")),
			mode: statSync(loginCookieOf(target)).mode & 0o777,
		},
		{
			status: 0,
			stdout: `Imported the browser profile into ${join(cacheOf(target), "browser-profile")} and the cached session and the login cookies\n`,
			loginCookies: [{ name: "SID", value: "google-session" }],
			mode: 0o600,
		},
	);
});

test("the import refuses to replace login cookies that are already on the machine", () => {
	const source = temporaryHome();
	seedProfile(source, { loginCookies: true });
	const exported = exportProfile(source);
	const target = temporaryHome();
	seedProfile(target, { session: false, loginCookies: true });

	const refused = runIn(target, "profile", "import", exported.archive);

	assert.deepStrictEqual(
		{ status: refused.status, stderr: refused.stderr },
		{
			status: 1,
			stderr: `netsuite-cli: Nothing was imported. ${cacheOf(target)} already holds a browser profile, a cached session or login cookies; re-run with --force to replace it.\n`,
		},
	);
});

test("the import refuses to replace a profile without force and replaces it with force", () => {
	const source = temporaryHome();
	seedProfile(source);
	const exported = exportProfile(source);
	const target = temporaryHome();
	seedProfile(target);
	writeFileSync(cookieOf(target), "old-data");

	const refused = runIn(target, "profile", "import", exported.archive);
	const cookieAfterTheRefusal = readFileSync(cookieOf(target), "utf8");
	const forced = runIn(target, "profile", "import", exported.archive, "--force");

	assert.deepStrictEqual(
		{
			refused: { status: refused.status, stderr: refused.stderr },
			cookieAfterTheRefusal,
			forced: { status: forced.status, cookie: readFileSync(cookieOf(target), "utf8") },
		},
		{
			refused: {
				status: 1,
				stderr: `netsuite-cli: Nothing was imported. ${cacheOf(target)} already holds a browser profile, a cached session or login cookies; re-run with --force to replace it.\n`,
			},
			cookieAfterTheRefusal: "old-data",
			forced: { status: 0, cookie: "cookie-data" },
		},
	);
});

test("the import refuses an archive that sits inside the cache directory when it has to replace it", () => {
	const home = temporaryHome();
	seedProfile(home);
	const archive = join(cacheOf(home), "profile.tar.gz");
	const exported = runIn(home, "profile", "export", archive);

	const result = runIn(home, "profile", "import", archive, "--force");

	assert.deepStrictEqual(
		{ exportStatus: exported.status, status: result.status, stderr: result.stderr },
		{
			exportStatus: 0,
			status: 1,
			stderr: `netsuite-cli: The archive ${archive} cannot live inside ${cacheOf(home)}, because --force empties that directory before the import.\n`,
		},
	);
});

test("the import refuses an archive that is not a profile archive", () => {
	const home = temporaryHome();
	const archive = join(home, "foreign.tar.gz");
	writeFileSync(join(home, "notes.txt"), "hello");
	create({ gzip: true, file: archive, cwd: home, sync: true }, ["notes.txt"]);

	const result = runIn(home, "profile", "import", archive);

	assert.deepStrictEqual(
		{
			status: result.status,
			stderr: result.stderr,
			hasABrowserProfile: existsSync(join(cacheOf(home), "browser-profile")),
		},
		{
			status: 2,
			stderr: `netsuite-cli: The archive ${archive} is not a netsuite-cli profile archive.\n`,
			hasABrowserProfile: false,
		},
	);
});

test("the export refuses while chrome holds the profile and passes with a stale lock", () => {
	const home = temporaryHome();
	seedProfile(home);
	const lock = join(cacheOf(home), "browser-profile", "SingletonLock");
	rmSync(lock, { force: true });
	symlinkSync(`${hostname()}-${process.pid}`, lock);

	const locked = runIn(home, "profile", "export", join(home, "profile.tar.gz"));

	rmSync(lock, { force: true });
	symlinkSync(`${hostname()}-999999`, lock);

	const stale = runIn(home, "profile", "export", join(home, "profile.tar.gz"));

	assert.deepStrictEqual(
		{
			locked: { status: locked.status, stderr: locked.stderr },
			stale: { status: stale.status },
		},
		{
			locked: {
				status: 1,
				stderr: `netsuite-cli: Chrome is using the login profile at ${join(cacheOf(home), "browser-profile")}. Close every Chrome window that uses it and run the command again.\n`,
			},
			stale: { status: 0 },
		},
	);
});

test("the parser sends the archive path of the profile verbs", async () => {
	const dispatched = [];
	const program = buildProgram(async (command) => {
		dispatched.push(command);
	});

	await program.parseAsync(["profile", "import", "/tmp/profile.tar.gz", "--force"], { from: "user" });

	assert.deepStrictEqual(
		{
			key: dispatched[0].key,
			path: dispatched[0].flags.path,
			force: dispatched[0].flags.force,
		},
		{ key: "profile import", path: "/tmp/profile.tar.gz", force: true },
	);
});
