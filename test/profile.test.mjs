import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { buildProgram } from "../bin/netsuite-cli.mjs";

const binary = fileURLToPath(new URL("../bin/netsuite-cli.mjs", import.meta.url));
const isolatedHome = (home) => ({ ...process.env, HOME: home, USERPROFILE: home });
const runIn = (home, ...argv) =>
	spawnSync(process.execPath, [binary, ...argv], { encoding: "utf8", env: isolatedHome(home) });
const temporaryHome = () => mkdtempSync(join(tmpdir(), "netsuite-profile-"));
const cacheOf = (home) => join(home, ".cache", "netsuite-cli");
const cookieOf = (home) => join(cacheOf(home), "browser-profile", "Default", "Cookies");

const seedProfile = (home, { session = true } = {}) => {
	mkdirSync(join(cacheOf(home), "browser-profile", "Default", "Cache"), { recursive: true });
	writeFileSync(join(cacheOf(home), "browser-profile", "Default", "Cookies"), "cookie-data");
	writeFileSync(join(cacheOf(home), "browser-profile", "Default", "Cache", "blob"), "throwaway");
	if (session === true) {
		writeFileSync(
			join(cacheOf(home), "session.json"),
			JSON.stringify({ account: "Acme", cookieHeader: "JSESSIONID=abc" }),
		);
	}
};

const membersOf = (archive) =>
	execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
		.split("\n")
		.map((member) => member.trim())
		.filter((member) => member.length > 0);

const exportedArchive = (home) => {
	const archive = join(home, "profile.tar.gz");
	const result = runIn(home, "profile", "export", archive);
	assert.equal(result.status, 0, result.stderr);
	return archive;
};

test("the export writes an archive with the profile and the session, without the chrome caches", () => {
	const home = temporaryHome();
	seedProfile(home);

	const result = runIn(home, "profile", "export", join(home, "profile.tar.gz"));

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^Exported the browser profile to /);
	const members = membersOf(join(home, "profile.tar.gz"));
	assert.ok(members.includes("browser-profile/Default/Cookies"));
	assert.ok(members.includes("session.json"));
	assert.ok(members.every((member) => !member.includes("Cache/")));
	assert.equal(statSync(join(home, "profile.tar.gz")).mode & 0o777, 0o600);
});

test("the export works without a cached session and leaves it out of the archive", () => {
	const home = temporaryHome();
	seedProfile(home, { session: false });

	const archive = exportedArchive(home);

	assert.equal(membersOf(archive).includes("session.json"), false);
});

test("the export refuses when there is no browser profile yet", () => {
	const home = temporaryHome();

	const result = runIn(home, "profile", "export", join(home, "profile.tar.gz"));

	assert.equal(result.status, 2);
	assert.match(result.stderr, /^netsuite-cli: There is no browser profile to export yet/);
});

test("the export prints the archive as JSON with --json", () => {
	const home = temporaryHome();
	seedProfile(home);
	const archive = join(home, "profile.tar.gz");

	const result = runIn(home, "--json", "profile", "export", archive);

	assert.equal(result.status, 0, result.stderr);
	const printed = JSON.parse(result.stdout);
	assert.equal(printed.archive, archive);
	assert.equal(typeof printed.bytes, "number");
});

test("the import restores the profile and the session on a machine without one", () => {
	const source = temporaryHome();
	seedProfile(source);
	const archive = exportedArchive(source);
	const target = temporaryHome();

	const result = runIn(target, "profile", "import", archive);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^Imported the browser profile into /);
	assert.equal(readFileSync(cookieOf(target), "utf8"), "cookie-data");
	assert.deepEqual(JSON.parse(readFileSync(join(cacheOf(target), "session.json"), "utf8")), {
		account: "Acme",
		cookieHeader: "JSESSIONID=abc",
	});
});

test("the import refuses to replace a profile without force and replaces it with force", () => {
	const source = temporaryHome();
	seedProfile(source);
	const archive = exportedArchive(source);
	const target = temporaryHome();
	seedProfile(target);
	writeFileSync(cookieOf(target), "old-data");

	const refused = runIn(target, "profile", "import", archive);

	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /^netsuite-cli: Nothing was imported\./);
	assert.equal(readFileSync(cookieOf(target), "utf8"), "old-data");

	const forced = runIn(target, "profile", "import", archive, "--force");

	assert.equal(forced.status, 0, forced.stderr);
	assert.equal(readFileSync(cookieOf(target), "utf8"), "cookie-data");
});

test("the import refuses an archive that sits inside the cache directory when it has to replace it", () => {
	const home = temporaryHome();
	seedProfile(home);
	const archive = join(cacheOf(home), "profile.tar.gz");
	const exported = runIn(home, "profile", "export", archive);
	assert.equal(exported.status, 0, exported.stderr);

	const result = runIn(home, "profile", "import", archive, "--force");

	assert.equal(result.status, 1);
	assert.match(result.stderr, /^netsuite-cli: The archive .* cannot live inside /);
});

test("the import refuses an archive that is not a profile archive", () => {
	const home = temporaryHome();
	const archive = join(home, "foreign.tar.gz");
	writeFileSync(join(home, "notes.txt"), "hello");
	execFileSync("tar", ["-czf", archive, "-C", home, "notes.txt"]);

	const result = runIn(home, "profile", "import", archive);

	assert.equal(result.status, 2);
	assert.match(result.stderr, /^netsuite-cli: The archive .* is not a netsuite-cli profile archive\./);
	assert.equal(existsSync(join(cacheOf(home), "browser-profile")), false);
});

test("the export refuses while chrome holds the profile and passes with a stale lock", () => {
	const home = temporaryHome();
	seedProfile(home);
	const lock = join(cacheOf(home), "browser-profile", "SingletonLock");
	rmSync(lock, { force: true });
	symlinkSync(`${hostname()}-${process.pid}`, lock);

	const locked = runIn(home, "profile", "export", join(home, "profile.tar.gz"));

	assert.equal(locked.status, 1);
	assert.match(locked.stderr, /^netsuite-cli: Chrome is using the login profile/);

	rmSync(lock, { force: true });
	symlinkSync(`${hostname()}-999999`, lock);

	const stale = runIn(home, "profile", "export", join(home, "profile.tar.gz"));

	assert.equal(stale.status, 0, stale.stderr);
});

test("the parser sends the archive path of the profile verbs", async () => {
	const dispatched = [];
	const program = buildProgram(async (command) => {
		dispatched.push(command);
	});

	await program.parseAsync(["profile", "import", "/tmp/profile.tar.gz", "--force"], { from: "user" });

	assert.equal(dispatched[0].key, "profile import");
	assert.equal(dispatched[0].flags.path, "/tmp/profile.tar.gz");
	assert.equal(dispatched[0].flags.force, true);
});
