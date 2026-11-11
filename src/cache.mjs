import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const CACHE_DIRECTORY = join(homedir(), ".cache", "netsuite-cli");
export const SESSION_FILE_NAME = "session.json";
export const SESSION_CACHE_PATH = join(CACHE_DIRECTORY, SESSION_FILE_NAME);
export const BROWSER_PROFILE_DIRECTORY_NAME = "browser-profile";
export const BROWSER_PROFILE_DIRECTORY = join(CACHE_DIRECTORY, BROWSER_PROFILE_DIRECTORY_NAME);
export const LOGIN_COOKIE_FILE_NAME = "login-cookies.json";
export const LOGIN_COOKIE_PATH = join(CACHE_DIRECTORY, LOGIN_COOKIE_FILE_NAME);

export const clearCache = ({ directory = CACHE_DIRECTORY } = {}) => {
	if (basename(directory) !== "netsuite-cli") {
		throw new Error(`Refusing to remove ${directory}: only a netsuite-cli cache directory can be cleared.`);
	}
	if (!existsSync(directory)) return { removed: false, directory };
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch (error) {
		throw new Error(`Could not remove ${directory}: ${error.code}. Close every Chrome window and try again.`, {
			cause: error,
		});
	}
	return { removed: true, directory };
};
