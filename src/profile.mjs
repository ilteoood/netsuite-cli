import { access, chmod, mkdir, readlink, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { create, extract, list } from "tar";
import {
	BROWSER_PROFILE_DIRECTORY_NAME,
	CACHE_DIRECTORY,
	clearCache,
	LOGIN_COOKIE_FILE_NAME,
	SESSION_FILE_NAME,
} from "./cache.mjs";
import { UsageError } from "./errors.mjs";

const ARCHIVE_EXCLUDES = new Set([
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
]);

const isExcludedMember = (member) => member.split("/").some((name) => ARCHIVE_EXCLUDES.has(name));

const listArchiveMembers = async (archive) => {
	try {
		const members = [];
		await list({ file: archive, strict: true, onReadEntry: (entry) => members.push(entry.path) });
		return members;
	} catch (error) {
		throw new Error(`The archive ${archive} could not be read: ${error.message}`);
	}
};

const lockOwner = async (profileDirectory) => {
	let target;
	try {
		target = await readlink(join(profileDirectory, "SingletonLock"));
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

const isProfileLocked = async (profileDirectory) => {
	const owner = await lockOwner(profileDirectory);
	if (owner === null) return false;
	if (owner.host !== hostname()) return false;
	return isProcessAlive(owner.pid);
};

const assertProfileIsFree = async (profileDirectory) => {
	const locked = await isProfileLocked(profileDirectory);
	if (!locked) return;
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

const pathExists = async (path) => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};

export const exportProfile = async ({ archivePath, cacheDirectory = CACHE_DIRECTORY } = {}) => {
	const profileDirectory = join(cacheDirectory, BROWSER_PROFILE_DIRECTORY_NAME);
	if (!(await pathExists(profileDirectory))) {
		throw new Error('There is no browser profile to export yet. Sign in first with "netsuite-cli login <url>".');
	}
	await assertProfileIsFree(profileDirectory);

	const archive = archivePathOf(archivePath);
	if (!(await pathExists(dirname(archive)))) {
		throw new Error(`The directory ${dirname(archive)} does not exist.`);
	}

	const members = [BROWSER_PROFILE_DIRECTORY_NAME];
	for (const name of [SESSION_FILE_NAME, LOGIN_COOKIE_FILE_NAME]) {
		if (await pathExists(join(cacheDirectory, name))) members.push(name);
	}
	await writeFile(archive, "", { mode: 0o600 });
	await chmod(archive, 0o600);
	await create(
		{
			gzip: true,
			file: archive,
			cwd: cacheDirectory,
			strict: true,
			filter: (member) => !isExcludedMember(member),
		},
		members,
	);

	const { size } = await stat(archive);
	return { archive, bytes: size };
};

export const importProfile = async ({ archivePath, cacheDirectory = CACHE_DIRECTORY, force = false } = {}) => {
	const profileDirectory = join(cacheDirectory, BROWSER_PROFILE_DIRECTORY_NAME);
	const sessionPath = join(cacheDirectory, SESSION_FILE_NAME);
	const loginCookiePath = join(cacheDirectory, LOGIN_COOKIE_FILE_NAME);
	await assertProfileIsFree(profileDirectory);

	const archive = archivePathOf(archivePath);
	if (!(await pathExists(archive))) {
		throw new Error(`There is no archive at ${archive}.`);
	}

	const members = await listArchiveMembers(archive);
	const isProfileMember = (member) =>
		member === BROWSER_PROFILE_DIRECTORY_NAME ||
		(member.startsWith(`${BROWSER_PROFILE_DIRECTORY_NAME}/`) && !member.split("/").includes(".."));
	const isSessionMember = (member) => member === SESSION_FILE_NAME;
	const isLoginCookieMember = (member) => member === LOGIN_COOKIE_FILE_NAME;
	if (members.some((member) => !isProfileMember(member) && !isSessionMember(member) && !isLoginCookieMember(member))) {
		throw new Error(`The archive ${archive} is not a netsuite-cli profile archive.`);
	}
	if (!members.some(isProfileMember)) {
		throw new Error(`The archive ${archive} holds no browser profile.`);
	}

	const occupied =
		(await pathExists(loginCookiePath)) || (await pathExists(profileDirectory)) || (await pathExists(sessionPath));
	if (!force && occupied) {
		throw new UsageError(
			`Nothing was imported. ${cacheDirectory} already holds a browser profile, a cached session or login cookies; re-run with --force to replace it.`,
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
		await extract({ file: archive, cwd: cacheDirectory, preserveOwner: false, strict: true });
	} catch (error) {
		throw new Error(`The archive ${archive} could not be read: ${error.message}`);
	}
	const session = await pathExists(sessionPath);
	const loginCookies = await pathExists(loginCookiePath);
	if (session) await chmod(sessionPath, 0o600);
	if (loginCookies) await chmod(loginCookiePath, 0o600);

	return { archive, profile: profileDirectory, session, loginCookies };
};
