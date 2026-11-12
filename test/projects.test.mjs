import assert from "node:assert/strict";
import { test } from "node:test";
import { NetsuiteError, UsageError } from "../src/errors.mjs";
import { fetchProjectChoices, fetchTasks, resolveChoice } from "../src/projects.mjs";
import { escapedPage, fixture } from "./support/netsuite-pages.mjs";

const capturedProjects = fixture.projects.map(({ id, text }) => ({ id, name: text }));
const capturedTasks = fixture.tasks.flatMap(({ id: projectId, tasks }) =>
	tasks.map(({ id, name }) => ({ id, name, projectId })),
);
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

	assert.deepStrictEqual(
		{
			timesheetId: choices.timesheetId,
			employeeId: choices.employeeId,
			projects: choices.projects,
			query: client.calls.queries[0],
			path: client.calls.paths[0],
		},
		{
			timesheetId: fixture.timesheetId,
			employeeId: fixture.employeeId,
			projects: capturedProjects,
			query: `SELECT id, employee, custrecord_timesheetsubmitted FROM timesheet WHERE startdate = TO_DATE('${fixture.week}', 'YYYY-MM-DD')`,
			path: `/app/accounting/transactions/time/weeklytimebill.nl?id=${fixture.timesheetId}&whence=&e=T`,
		},
	);
});

test("fetchTasks reads every task of the week in one suitelet call, grouped by project", async () => {
	const client = clientWith({ page: JSON.stringify(fixture.tasks) });

	const tasks = await fetchTasks(client, { weekStart: fixture.week, employeeId: fixture.employeeId });

	assert.deepStrictEqual(
		{ tasks, path: client.calls.paths[0] },
		{
			tasks: capturedTasks,
			path: `/app/site/hosting/scriptlet.nl?script=1394&deploy=1&compid=1234567&trandate=${fixture.week}&employeeId=${fixture.employeeId}&projectId=`,
		},
	);
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

	assert.deepStrictEqual(
		{
			sharedCount: shared.length,
			id: resolveChoice(
				shared.filter((task) => task.projectId === "1242"),
				"internal",
				"task",
			).id,
		},
		{ sharedCount: 6, id: "2004" },
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
	assert.deepStrictEqual(client.calls.paths, []);
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

	assert.deepStrictEqual(project, { id: "1234", name: "Acme Platform" });
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
