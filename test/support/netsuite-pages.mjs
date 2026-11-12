import { readFileSync } from "node:fs";

export const fixture = JSON.parse(
	readFileSync(new URL("../fixtures/timesheet-2026-11-16.json", import.meta.url), "utf8"),
);

export const escapedPage = (fields) =>
	`<html><body>${Object.entries(fields)
		.map(
			([fieldId, options]) =>
				`${fieldId}\\":{\\"name\\":\\"${fieldId}\\",\\"supplementedOptions\\":${JSON.stringify(options).replaceAll('"', '\\"')},\\"hasBlankString\\":false`,
		)
		.join("")}</body></html>`;
