import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const CACHE_DIRECTORY = join(homedir(), ".cache", "netsuite-cli");
export const SESSION_CACHE_PATH = join(CACHE_DIRECTORY, "session.json");
export const BROWSER_PROFILE_DIRECTORY = join(CACHE_DIRECTORY, "browser-profile");

export const clearCache = ({ directory = CACHE_DIRECTORY } = {}) => {
	if (basename(directory) !== "netsuite-cli") {
		throw new Error(`Refusing to remove ${directory}: only a netsuite-cli cache directory can be cleared.`);
	}
	if (!existsSync(directory)) return { removed: false, directory };
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch (error) {
		throw new Error(`Could not remove ${directory}. Close every Chrome window and try again.`, { cause: error });
	}
	return { removed: true, directory };
};
