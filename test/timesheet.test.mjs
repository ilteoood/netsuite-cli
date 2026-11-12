import assert from "node:assert/strict";
import { test } from "node:test";
import { NetsuiteError, UsageError } from "../src/errors.mjs";
import { addTimeEntry, fillTimesheet, listTimesheet } from "../src/timesheet.mjs";
import { escapedPage, fixture } from "./support/netsuite-pages.mjs";

const weekStart = "2026-11-16";
const project = { id: "1234", name: "Acme Platform" };
const task = { id: "2001", name: "Internal Project Task" };

const entryRow = (overrides = {}) => ({
	id: "501",
	entrydate: "2026-11-16",
	hours: "7:30",
	memo: "Delivery",
	customer: "1234",
	item: "71",
	casetaskevent: "2001",
	approvalstatus: "1",
	...overrides,
});

const projectsPage = () => escapedPage({ custpage_filtered_projects: fixture.projects });

const clientWith = ({
	timesheet = { id: "900", employee: "4242" },
	entries = [],
	submitResult = { result: { success: true } },
} = {}) => {
	const calls = [];
	return {
		account: "1234567",
		calls,
		suiteql: async (query) => {
			calls.push({ query });
			return query.includes("FROM timesheet") ? (timesheet ? [timesheet] : []) : entries;
		},
		text: async (path) => {
			return path.includes("weeklytimebill") ? projectsPage() : JSON.stringify(fixture.tasks);
		},
		request: async (path, { method = "GET", body } = {}) => {
			calls.push({ path, method, body });
			return path.endsWith("/@submit") ? submitResult : null;
		},
	};
};

const writes = (client) => client.calls.filter((call) => call.path);
const writeCalls = (client) => writes(client).map(({ path, method, body }) => ({ path, method, body }));

const fillOptions = (overrides = {}) => ({
	weekStart,
	project,
	task,
	hours: "7:30",
	days: ["2026-11-16", "2026-11-17"],
	activityId: "71",
	memo: "Delivery",
	...overrides,
});

const addedBody = (tranDate, hours = "7:30") => ({
	employee: "4242",
	tranDate,
	hours,
	customer: "1234",
	item: "71",
	caseTaskEvent: "2001",
	memo: "Delivery",
	isBillable: true,
	timesheet: "900",
});

test("fillTimesheet creates every scheduled day of a fresh week", async () => {
	const client = clientWith();

	const report = await fillTimesheet(client, fillOptions());

	assert.deepStrictEqual(
		{
			report,
			selectsTheWeek: client.calls[0].query.includes("startdate = TO_DATE('2026-11-16', 'YYYY-MM-DD')"),
			selectsTheEntries: client.calls[1].query.includes("TO_CHAR(trandate, 'YYYY-MM-DD') AS entrydate"),
			selectsTheTimesheet: client.calls[1].query.includes("WHERE timesheet = '900'"),
			writes: writeCalls(client),
		},
		{
			report: {
				weekStart,
				timesheetId: "900",
				create: 2,
				replace: 0,
				remove: 0,
				keep: 0,
				untouched: 0,
				totalMinutes: 900,
				submitted: false,
			},
			selectsTheWeek: true,
			selectsTheEntries: true,
			selectsTheTimesheet: true,
			writes: [
				{ path: "/services/rest/record/v1/timebill", method: "POST", body: addedBody("2026-11-16") },
				{ path: "/services/rest/record/v1/timebill", method: "POST", body: addedBody("2026-11-17") },
			],
		},
	);
});

test("fillTimesheet replaces the entry whose hours changed and keeps the matching one", async () => {
	const client = clientWith({
		entries: [entryRow({ id: "501" }), entryRow({ id: "502", entrydate: "2026-11-17", hours: "8:00" })],
	});

	const report = await fillTimesheet(client, fillOptions({ hours: "8:00", force: true }));

	assert.deepStrictEqual(
		{
			create: report.create,
			replace: report.replace,
			keep: report.keep,
			totalMinutes: report.totalMinutes,
			writes: writeCalls(client),
		},
		{
			create: 0,
			replace: 1,
			keep: 1,
			totalMinutes: 960,
			writes: [
				{
					path: "/services/rest/record/v1/timebill",
					method: "POST",
					body: addedBody("2026-11-16", "8:00"),
				},
				{ path: "/services/rest/record/v1/timebill/501", method: "DELETE", body: undefined },
			],
		},
	);
});

test("fillTimesheet removes the days of the same project and task that are no longer scheduled", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501", entrydate: "2026-11-16" })] });

	const report = await fillTimesheet(client, fillOptions({ days: ["2026-11-17"], force: true }));

	assert.deepStrictEqual(
		{
			create: report.create,
			remove: report.remove,
			writes: writeCalls(client),
		},
		{
			create: 1,
			remove: 1,
			writes: [
				{ path: "/services/rest/record/v1/timebill", method: "POST", body: addedBody("2026-11-17") },
				{ path: "/services/rest/record/v1/timebill/501", method: "DELETE", body: undefined },
			],
		},
	);
});

test("fillTimesheet keeps the entries of other projects untouched and counts the week total", async () => {
	const client = clientWith({
		entries: [entryRow({ id: "601", customer: "1240", casetaskevent: "2003", hours: "4:00", memo: "Other" })],
	});

	const report = await fillTimesheet(client, fillOptions({ days: ["2026-11-16"] }));

	assert.deepStrictEqual(
		{
			untouched: report.untouched,
			create: report.create,
			totalMinutes: report.totalMinutes,
			writes: writeCalls(client),
		},
		{
			untouched: 1,
			create: 1,
			totalMinutes: 690,
			writes: [{ path: "/services/rest/record/v1/timebill", method: "POST", body: addedBody("2026-11-16") }],
		},
	);
});

test("fillTimesheet reports the plan of a dry run without writing", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501", hours: "7:00" })] });

	const report = await fillTimesheet(client, fillOptions({ hours: "8:00", dryRun: true }));

	assert.deepStrictEqual(
		{ replace: report.replace, totalMinutes: report.totalMinutes, writes: writeCalls(client) },
		{ replace: 1, totalMinutes: 960, writes: [] },
	);
});

test("fillTimesheet refuses to touch existing entries without force", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501", hours: "7:00" })] });

	await assert.rejects(fillTimesheet(client, fillOptions({ hours: "8:00" })), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /1 existing time entries would change and 0 would be removed/);
		assert.match(error.message, /--force/);
		return true;
	});
	assert.deepStrictEqual(writes(client), []);
});

test("fillTimesheet refuses to remove a day without force", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501", entrydate: "2026-11-16" })] });

	await assert.rejects(fillTimesheet(client, fillOptions({ days: ["2026-11-17"] })), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /0 existing time entries would change and 1 would be removed/);
		return true;
	});
	assert.deepStrictEqual(writes(client), []);
});

test("fillTimesheet refuses to change an approved time entry", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501", hours: "7:00", approvalstatus: "3" })] });

	await assert.rejects(fillTimesheet(client, fillOptions({ hours: "8:00", force: true })), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.match(error.message, /approved time entries/);
		assert.match(error.message, /2026-11-16 1234/);
		return true;
	});
	assert.deepStrictEqual(writes(client), []);
});

test("fillTimesheet reports a missing timesheet as a usage error naming the week", async () => {
	const client = clientWith({ timesheet: null });

	await assert.rejects(fillTimesheet(client, fillOptions()), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /No timesheet exists for the week starting 2026-11-16/);
		return true;
	});
	assert.deepStrictEqual({ calls: client.calls.length, writes: writes(client) }, { calls: 1, writes: [] });
});

test("fillTimesheet submits the week when asked", async () => {
	const client = clientWith();

	const report = await fillTimesheet(client, fillOptions({ days: ["2026-11-16"], submit: true }));

	assert.deepStrictEqual(
		{ submitted: report.submitted, lastWrite: writeCalls(client).at(-1) },
		{
			submitted: true,
			lastWrite: {
				path: "/services/rest/record/v1/timesheet/900/@submit",
				method: "POST",
				body: {},
			},
		},
	);
});

test("fillTimesheet refuses to submit when NetSuite answers success false", async () => {
	const client = clientWith({ submitResult: { result: { success: false } } });

	await assert.rejects(fillTimesheet(client, fillOptions({ days: ["2026-11-16"], submit: true })), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.match(error.message, /NetSuite refused to submit timesheet 900/);
		return true;
	});
});

test("fillTimesheet refuses to submit a week that holds an entry without a memo", async () => {
	const client = clientWith();

	await assert.rejects(
		fillTimesheet(client, fillOptions({ days: ["2026-11-16"], memo: "", submit: true })),
		(error) => {
			assert.ok(error instanceof NetsuiteError);
			assert.match(error.message, /memo on every time entry before submitting/);
			assert.match(error.message, /2026-11-16/);
			return true;
		},
	);
	assert.deepStrictEqual(writes(client), []);
});

test("addTimeEntry adds one day and leaves the other days of the project alone", async () => {
	const client = clientWith({
		entries: [entryRow({ id: "501", entrydate: "2026-11-16" }), entryRow({ id: "502", entrydate: "2026-11-17" })],
	});

	const report = await addTimeEntry(client, {
		date: "2026-11-18",
		project,
		task,
		hours: "7:30",
		activityId: "71",
		memo: "Delivery",
	});

	assert.deepStrictEqual(
		{
			report,
			writes: writeCalls(client),
		},
		{
			report: {
				weekStart,
				timesheetId: "900",
				create: 1,
				replace: 0,
				remove: 0,
				keep: 0,
				untouched: 0,
				totalMinutes: 1350,
			},
			writes: [{ path: "/services/rest/record/v1/timebill", method: "POST", body: addedBody("2026-11-18") }],
		},
	);
});

test("addTimeEntry replaces only the entry of the same day", async () => {
	const client = clientWith({
		entries: [
			entryRow({ id: "501", entrydate: "2026-11-16" }),
			entryRow({ id: "502", entrydate: "2026-11-18", hours: "7:00" }),
		],
	});

	const report = await addTimeEntry(client, {
		date: "2026-11-18",
		project,
		task,
		hours: "8:00",
		activityId: "71",
		memo: "Delivery",
	});

	assert.deepStrictEqual(
		{
			replace: report.replace,
			remove: report.remove,
			totalMinutes: report.totalMinutes,
			writes: writeCalls(client),
		},
		{
			replace: 1,
			remove: 0,
			totalMinutes: 930,
			writes: [
				{
					path: "/services/rest/record/v1/timebill",
					method: "POST",
					body: addedBody("2026-11-18", "8:00"),
				},
				{ path: "/services/rest/record/v1/timebill/502", method: "DELETE", body: undefined },
			],
		},
	);
});

test("addTimeEntry derives the Monday of a mid-week date", async () => {
	const client = clientWith();

	const report = await addTimeEntry(client, {
		date: "2026-11-20",
		project,
		task,
		hours: "7:30",
		activityId: "71",
		memo: "Delivery",
	});

	assert.deepStrictEqual(
		{
			weekStart: report.weekStart,
			create: report.create,
			selectsTheWeek: client.calls[0].query.includes("startdate = TO_DATE('2026-11-16', 'YYYY-MM-DD')"),
			writes: writeCalls(client),
		},
		{
			weekStart,
			create: 1,
			selectsTheWeek: true,
			writes: [{ path: "/services/rest/record/v1/timebill", method: "POST", body: addedBody("2026-11-20") }],
		},
	);
});

test("fillTimesheet refuses hours that are not a positive number", async () => {
	const client = clientWith();

	await assert.rejects(fillTimesheet(client, fillOptions({ hours: "8h" })), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /--hours expects a positive number/);
		return true;
	});
	assert.deepStrictEqual(writes(client), []);
});

test("fillTimesheet refuses a week that is already submitted", async () => {
	const client = clientWith({
		timesheet: { id: "900", employee: "4242", custrecord_timesheetsubmitted: "T" },
	});

	await assert.rejects(fillTimesheet(client, fillOptions()), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.match(error.message, /Timesheet 900 is already submitted/);
		return true;
	});
	assert.deepStrictEqual(writes(client), []);
});

test("fillTimesheet replaces the entry whose activity changed", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501" })] });

	const report = await fillTimesheet(client, fillOptions({ days: ["2026-11-16"], activityId: "72", force: true }));

	assert.deepStrictEqual(
		{
			replace: report.replace,
			writes: writeCalls(client),
		},
		{
			replace: 1,
			writes: [
				{
					path: "/services/rest/record/v1/timebill",
					method: "POST",
					body: { ...addedBody("2026-11-16"), item: "72" },
				},
				{ path: "/services/rest/record/v1/timebill/501", method: "DELETE", body: undefined },
			],
		},
	);
});

test("fillTimesheet leaves the existing entries in place when NetSuite refuses a new one", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501", hours: "7:00" })] });
	const request = client.request;
	client.request = async (path, options = {}) => {
		client.calls.push({ path, method: options.method, body: options.body });
		if (options.method === "POST") throw new NetsuiteError("NetSuite POST /timebill failed with HTTP 400.");
		return request(path, options);
	};

	await assert.rejects(fillTimesheet(client, fillOptions({ hours: "8:00", force: true })), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.match(error.message, /Nothing was removed/);
		return true;
	});
	assert.deepStrictEqual(
		writes(client).map(({ path, method }) => `${method} ${path}`),
		["POST /services/rest/record/v1/timebill"],
	);
});

test("listTimesheet names the project and task of every entry, ordered by date", async () => {
	const client = clientWith({
		entries: [
			entryRow({ id: "901", entrydate: "2026-11-17", hours: "8", memo: "WebPortal", casetaskevent: "2002" }),
			entryRow({ id: "902", entrydate: "2026-11-18", customer: "1240" }),
			entryRow({ id: "900", customer: "1240" }),
		],
	});

	assert.deepStrictEqual(
		{ week: await listTimesheet(client, weekStart), writes: writeCalls(client) },
		{
			week: {
				weekStart,
				timesheetId: "900",
				submitted: false,
				totalMinutes: 1380,
				entries: [
					{
						id: "900",
						date: "2026-11-16",
						projectName: "Internal Tools",
						taskName: "Internal Project Task",
						hours: "7:30",
						memo: "Delivery",
					},
					{
						id: "901",
						date: "2026-11-17",
						projectName: "Acme Platform",
						taskName: "Task 2",
						hours: "8:00",
						memo: "WebPortal",
					},
					{
						id: "902",
						date: "2026-11-18",
						projectName: "Internal Tools",
						taskName: "Internal Project Task",
						hours: "7:30",
						memo: "Delivery",
					},
				],
			},
			writes: [],
		},
	);
});

test("listTimesheet keeps the id of a project the week does not offer and reports the submitted flag", async () => {
	const client = clientWith({
		timesheet: { id: "900", employee: "4242", custrecord_timesheetsubmitted: "T" },
		entries: [entryRow({ customer: "9999" })],
	});

	assert.deepStrictEqual(
		{ week: await listTimesheet(client, weekStart), writes: writeCalls(client) },
		{
			week: {
				weekStart,
				timesheetId: "900",
				submitted: true,
				totalMinutes: 450,
				entries: [
					{
						id: "501",
						date: "2026-11-16",
						projectName: "9999",
						taskName: "Internal Project Task",
						hours: "7:30",
						memo: "Delivery",
					},
				],
			},
			writes: [],
		},
	);
});

test("listTimesheet reports an empty week with no time in it", async () => {
	const client = clientWith();

	assert.deepStrictEqual(await listTimesheet(client, weekStart), {
		weekStart,
		timesheetId: "900",
		submitted: false,
		totalMinutes: 0,
		entries: [],
	});
});

test("listTimesheet reads the timesheet record once", async () => {
	const client = clientWith({ entries: [entryRow()] });

	await listTimesheet(client, weekStart);

	assert.equal(client.calls.filter(({ query }) => query?.includes("FROM timesheet")).length, 1);
});
