import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NetsuiteError, UsageError } from "../src/errors.mjs";
import { fetchProjectChoices, fetchTasks, resolveChoice } from "../src/projects.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/timesheet-2026-11-16.json", import.meta.url), "utf8"));
const capturedProjects = fixture.projects.map(({ id, text }) => ({ id, name: text }));
const capturedTasks = fixture.tasks.flatMap(({ id: projectId, tasks }) =>
	tasks.map(({ id, name }) => ({ id, name, projectId })),
);

const escapedPage = (fields) =>
	`<html><body>${Object.entries(fields)
		.map(
			([fieldId, options]) =>
				`${fieldId}\\":{\\"name\\":\\"${fieldId}\\",\\"supplementedOptions\\":${JSON.stringify(options).replaceAll('"', '\\"')},\\"hasBlankString\\":false`,
		)
		.join("")}</body></html>`;

const capturedPage = escapedPage({ custpage_filtered_projects: fixture.projects });

const clientWith = ({ page, rows = [{ id: fixture.timesheetId, employee: fixture.employeeId }] }) => {
	const calls = { queries: [], paths: [] };
	return {
		account: "1234567",
		calls,
		suiteql: async (query) => {
			calls.queries.push(query);
			return rows;
		},
		text: async (path) => {
			calls.paths.push(path);
			return page;
		},
	};
};

test("fetchProjectChoices reads the captured page in its own order", async () => {
	const client = clientWith({ page: capturedPage });

	const choices = await fetchProjectChoices(client, fixture.week);

	assert.equal(choices.timesheetId, fixture.timesheetId);
	assert.equal(choices.employeeId, fixture.employeeId);
	assert.deepEqual(choices.projects, capturedProjects);
	assert.match(client.calls.queries[0], /startdate = TO_DATE\('2026-11-16', 'YYYY-MM-DD'\)/);
	assert.equal(
		client.calls.paths[0],
		`/app/accounting/transactions/time/weeklytimebill.nl?id=${fixture.timesheetId}&whence=&e=T`,
	);
});

test("fetchTasks reads every task of the week in one suitelet call, grouped by project", async () => {
	const client = clientWith({ page: JSON.stringify(fixture.tasks) });

	const tasks = await fetchTasks(client, { weekStart: fixture.week, employeeId: fixture.employeeId });

	assert.deepEqual(tasks, capturedTasks);
	assert.match(client.calls.paths[0], /script=1394&deploy=1&compid=1234567/);
	assert.match(client.calls.paths[0], /trandate=2026-11-16&employeeId=4242&projectId=$/);
});

test("fetchTasks reports an unreadable task list", async () => {
	const client = clientWith({ page: "<html>not json</html>" });

	await assert.rejects(fetchTasks(client, { weekStart: fixture.week, employeeId: fixture.employeeId }), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.match(error.message, /task list this CLI cannot read/);
		return true;
	});
});

test("a task name shared by several projects resolves under its own project", () => {
	const shared = capturedTasks.filter((task) => task.name === "Internal Project Task");

	assert.equal(shared.length, 6);
	assert.equal(
		resolveChoice(
			shared.filter((task) => task.projectId === "1242"),
			"internal",
			"task",
		).id,
		"2004",
	);
});

test("fetchProjectChoices reports a missing timesheet as a Monday problem", async () => {
	const client = clientWith({ page: capturedPage, rows: [] });

	await assert.rejects(fetchProjectChoices(client, "2026-11-17"), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /pre-creates/);
		assert.match(error.message, /not a Monday/);
		return true;
	});
	assert.deepEqual(client.calls.paths, []);
});

test("fetchProjectChoices reports the login page as an expired session", async () => {
	const client = clientWith({
		page: '<html><body><form action="/app/login/secure/enterpriselogin.nl"></form></body></html>',
	});

	await assert.rejects(fetchProjectChoices(client, fixture.week), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.match(error.message, /session has expired/);
		assert.doesNotMatch(error.message, /offers no projects/);
		return true;
	});
});

test("fetchProjectChoices reports an empty project list as no projects", async () => {
	const client = clientWith({
		page: escapedPage({ custpage_filtered_projects: [], custpage_filtered_tasks: [] }),
	});

	await assert.rejects(fetchProjectChoices(client, fixture.week), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /offers no projects/);
		assert.doesNotMatch(error.message, /expired/);
		return true;
	});
});

test("resolveChoice resolves one case-insensitive substring match", () => {
	const project = resolveChoice(capturedProjects, "  acme   PLATFORM ", "project");

	assert.deepEqual(project, { id: "1234", name: "Acme Platform" });
});

test("resolveChoice refuses an ambiguous name and lists every candidate", () => {
	assert.throws(
		() => resolveChoice(capturedProjects, "internal", "project"),
		(error) => {
			assert.ok(error instanceof UsageError);
			assert.match(error.message, /matches several projects/);
			assert.match(error.message, /"Internal Tools" \(id 1240\)/);
			assert.match(error.message, /"Internal Meetings" \(id 1244\)/);
			return true;
		},
	);
});

test("resolveChoice refuses a name that matches nothing and lists the closest labels", () => {
	assert.throws(
		() => resolveChoice(capturedProjects, "acme platfrom", "project"),
		(error) => {
			assert.ok(error instanceof UsageError);
			assert.match(error.message, /No project matches "acme platfrom"/);
			assert.match(error.message, /Closest: .*"Acme Platform" \(id 1234\)/);
			return true;
		},
	);
});
