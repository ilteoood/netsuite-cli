import { execFile } from "node:child_process";
import { chmodSync, existsSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { BROWSER_PROFILE_DIRECTORY_NAME, CACHE_DIRECTORY, clearCache } from "./cache.mjs";
import { UsageError } from "./errors.mjs";

const run = promisify(execFile);

const SESSION_FILE_NAME = "session.json";

const ARCHIVE_EXCLUDES = [
	"Cache",
	"Code Cache",
	"GPUCache",
	"ShaderCache",
	"GrShaderCache",
	"DawnCache",
	"DawnGraphiteCache",
	"DawnWebGPUCache",
	"CacheStorage",
	"ScriptCache",
	"Service Worker",
	"Crashpad",
	"Crash Reports",
	"SingletonCookie",
	"SingletonLock",
	"SingletonSocket",
];

const tar = async (args) => {
	try {
		const { stdout } = await run("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		return stdout;
	} catch (error) {
		if (error.code === "ENOENT") {
			throw new Error("tar is not installed on this machine, so the browser profile cannot be archived.");
		}
		const reason = (error.stderr ?? "").split("\n").find((line) => line.trim().length > 0) ?? error.message;
		throw new Error(`tar failed: ${reason}`);
	}
};

const listArchiveMembers = async (archive) => {
	try {
		return (await tar(["-tzf", archive]))
			.split("\n")
			.map((member) => member.trim())
			.filter((member) => member.length > 0);
	} catch (error) {
		throw new Error(`The archive ${archive} could not be read: ${error.message}`);
	}
};

const lockOwner = (profileDirectory) => {
	let target;
	try {
		target = readlinkSync(join(profileDirectory, "SingletonLock"));
	} catch {
		return null;
	}
	const match = /-(\d+)$/.exec(target);
	if (match === null) return null;
	return { host: target.slice(0, target.length - match[0].length), pid: Number(match[1]) };
};

const isProcessAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
};

const isProfileLocked = (profileDirectory) => {
	const owner = lockOwner(profileDirectory);
	if (owner === null) return false;
	if (owner.host !== hostname()) return false;
	return isProcessAlive(owner.pid);
};

const assertProfileIsFree = (profileDirectory) => {
	if (!isProfileLocked(profileDirectory)) return;
	throw new UsageError(
		`Chrome is using the login profile at ${profileDirectory}. Close every Chrome window that uses it and run the command again.`,
	);
};

const archivePathOf = (archivePath) => {
	if (typeof archivePath !== "string" || archivePath.trim().length === 0) {
		throw new UsageError("The archive path is required.");
	}
	return resolve(archivePath);
};

export const exportProfile = async ({ archivePath, cacheDirectory = CACHE_DIRECTORY } = {}) => {
	const profileDirectory = join(cacheDirectory, BROWSER_PROFILE_DIRECTORY_NAME);
	if (!existsSync(profileDirectory)) {
		throw new Error('There is no browser profile to export yet. Sign in first with "netsuite-cli login <url>".');
	}
	assertProfileIsFree(profileDirectory);

	const archive = archivePathOf(archivePath);
	if (!existsSync(dirname(archive))) {
		throw new Error(`The directory ${dirname(archive)} does not exist.`);
	}

	const members = [BROWSER_PROFILE_DIRECTORY_NAME];
	if (existsSync(join(cacheDirectory, SESSION_FILE_NAME))) members.push(SESSION_FILE_NAME);
	writeFileSync(archive, "", { mode: 0o600 });
	await tar([
		"-czf",
		archive,
		...ARCHIVE_EXCLUDES.map((name) => `--exclude=${name}`),
		"-C",
		cacheDirectory,
		...members,
	]);
	chmodSync(archive, 0o600);

	const { size } = await stat(archive);
	return { archive, bytes: size };
};

export const importProfile = async ({ archivePath, cacheDirectory = CACHE_DIRECTORY, force = false } = {}) => {
	const profileDirectory = join(cacheDirectory, BROWSER_PROFILE_DIRECTORY_NAME);
	const sessionPath = join(cacheDirectory, SESSION_FILE_NAME);
	assertProfileIsFree(profileDirectory);

	const archive = archivePathOf(archivePath);
	if (!existsSync(archive)) {
		throw new Error(`There is no archive at ${archive}.`);
	}

	const members = await listArchiveMembers(archive);
	const isProfileMember = (member) =>
		member === BROWSER_PROFILE_DIRECTORY_NAME ||
		(member.startsWith(`${BROWSER_PROFILE_DIRECTORY_NAME}/`) && !member.split("/").includes(".."));
	const isSessionMember = (member) => member === SESSION_FILE_NAME;
	if (members.some((member) => !isProfileMember(member) && !isSessionMember(member))) {
		throw new Error(`The archive ${archive} is not a netsuite-cli profile archive.`);
	}
	if (!members.some(isProfileMember)) {
		throw new Error(`The archive ${archive} holds no browser profile.`);
	}

	if (!force && (existsSync(profileDirectory) || existsSync(sessionPath))) {
		throw new UsageError(
			`Nothing was imported. ${cacheDirectory} already holds a browser profile or a cached session; re-run with --force to replace it.`,
		);
	}

	if (force) {
		if (archive.startsWith(`${cacheDirectory}${sep}`)) {
			throw new UsageError(
				`The archive ${archive} cannot live inside ${cacheDirectory}, because --force empties that directory before the import.`,
			);
		}
		clearCache({ directory: cacheDirectory });
	}
	await mkdir(cacheDirectory, { recursive: true });
	try {
		await tar(["-xzf", archive, "--no-same-owner", "-C", cacheDirectory]);
	} catch (error) {
		throw new Error(`The archive ${archive} could not be read: ${error.message}`);
	}
	if (existsSync(sessionPath)) chmodSync(sessionPath, 0o600);

	return { archive, profile: profileDirectory, session: existsSync(sessionPath) };
};
