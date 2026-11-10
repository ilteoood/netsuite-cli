import assert from "node:assert/strict";
import { test } from "node:test";
import { NetsuiteError, UsageError } from "../src/errors.mjs";
import { addTimeEntry, fillTimesheet } from "../src/timesheet.mjs";

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

const clientWith = ({
	timesheet = { id: "900", employee: "4242" },
	entries = [],
	submitResult = { result: { success: true } },
} = {}) => {
	const calls = [];
	return {
		calls,
		suiteql: async (query) => {
			calls.push({ query });
			return query.includes("FROM timesheet") ? (timesheet ? [timesheet] : []) : entries;
		},
		request: async (path, { method = "GET", body } = {}) => {
			calls.push({ path, method, body });
			return path.endsWith("/@submit") ? submitResult : null;
		},
	};
};

const writes = (client) => client.calls.filter((call) => call.path);

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

	assert.deepEqual(report, {
		weekStart,
		timesheetId: "900",
		create: 2,
		replace: 0,
		remove: 0,
		keep: 0,
		untouched: 0,
		totalMinutes: 900,
		submitted: false,
	});
	assert.match(client.calls[0].query, /startdate = TO_DATE\('2026-11-16', 'YYYY-MM-DD'\)/);
	assert.match(client.calls[1].query, /TO_CHAR\(trandate, 'YYYY-MM-DD'\) AS entrydate/);
	assert.match(client.calls[1].query, /WHERE timesheet = '900'/);
	assert.deepEqual(
		writes(client).map(({ path, method, body }) => ({ path, method, body })),
		[
			{ path: "/services/rest/record/v1/timebill", method: "POST", body: addedBody("2026-11-16") },
			{ path: "/services/rest/record/v1/timebill", method: "POST", body: addedBody("2026-11-17") },
		],
	);
});

test("fillTimesheet replaces the entry whose hours changed and keeps the matching one", async () => {
	const client = clientWith({
		entries: [entryRow({ id: "501" }), entryRow({ id: "502", entrydate: "2026-11-17", hours: "8:00" })],
	});

	const report = await fillTimesheet(client, fillOptions({ hours: "8:00", force: true }));

	assert.equal(report.create, 0);
	assert.equal(report.replace, 1);
	assert.equal(report.keep, 1);
	assert.equal(report.totalMinutes, 960);
	assert.deepEqual(
		writes(client).map(({ path, method }) => `${method} ${path}`),
		["POST /services/rest/record/v1/timebill", "DELETE /services/rest/record/v1/timebill/501"],
	);
	assert.deepEqual(writes(client)[0].body, addedBody("2026-11-16", "8:00"));
});

test("fillTimesheet removes the days of the same project and task that are no longer scheduled", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501", entrydate: "2026-11-16" })] });

	const report = await fillTimesheet(client, fillOptions({ days: ["2026-11-17"], force: true }));

	assert.equal(report.create, 1);
	assert.equal(report.remove, 1);
	assert.deepEqual(
		writes(client).map(({ path, method }) => `${method} ${path}`),
		["POST /services/rest/record/v1/timebill", "DELETE /services/rest/record/v1/timebill/501"],
	);
	assert.deepEqual(writes(client)[0].body, addedBody("2026-11-17"));
});

test("fillTimesheet keeps the entries of other projects untouched and counts the week total", async () => {
	const client = clientWith({
		entries: [entryRow({ id: "601", customer: "1240", casetaskevent: "2003", hours: "4:00", memo: "Other" })],
	});

	const report = await fillTimesheet(client, fillOptions({ days: ["2026-11-16"] }));

	assert.equal(report.untouched, 1);
	assert.equal(report.create, 1);
	assert.equal(report.totalMinutes, 690);
	assert.deepEqual(
		writes(client).map(({ path, method }) => `${method} ${path}`),
		["POST /services/rest/record/v1/timebill"],
	);
});

test("fillTimesheet reports the plan of a dry run without writing", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501", hours: "7:00" })] });

	const report = await fillTimesheet(client, fillOptions({ hours: "8:00", dryRun: true }));

	assert.equal(report.replace, 1);
	assert.equal(report.totalMinutes, 960);
	assert.deepEqual(writes(client), []);
});

test("fillTimesheet refuses to touch existing entries without force", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501", hours: "7:00" })] });

	await assert.rejects(fillTimesheet(client, fillOptions({ hours: "8:00" })), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /1 existing time entries would change and 0 would be removed/);
		assert.match(error.message, /--force/);
		return true;
	});
	assert.deepEqual(writes(client), []);
});

test("fillTimesheet refuses to remove a day without force", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501", entrydate: "2026-11-16" })] });

	await assert.rejects(fillTimesheet(client, fillOptions({ days: ["2026-11-17"] })), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /0 existing time entries would change and 1 would be removed/);
		return true;
	});
	assert.deepEqual(writes(client), []);
});

test("fillTimesheet refuses to change an approved time entry", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501", hours: "7:00", approvalstatus: "3" })] });

	await assert.rejects(fillTimesheet(client, fillOptions({ hours: "8:00", force: true })), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.match(error.message, /approved time entries/);
		assert.match(error.message, /2026-11-16 1234/);
		return true;
	});
	assert.deepEqual(writes(client), []);
});

test("fillTimesheet reports a missing timesheet as a usage error naming the week", async () => {
	const client = clientWith({ timesheet: null });

	await assert.rejects(fillTimesheet(client, fillOptions()), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /No timesheet exists for the week starting 2026-11-16/);
		return true;
	});
	assert.equal(client.calls.length, 1);
	assert.deepEqual(writes(client), []);
});

test("fillTimesheet submits the week when asked", async () => {
	const client = clientWith();

	const report = await fillTimesheet(client, fillOptions({ days: ["2026-11-16"], submit: true }));

	assert.equal(report.submitted, true);
	assert.deepEqual(writes(client).at(-1), {
		path: "/services/rest/record/v1/timesheet/900/@submit",
		method: "POST",
		body: {},
	});
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
	assert.deepEqual(writes(client), []);
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

	assert.deepEqual(report, {
		weekStart,
		timesheetId: "900",
		create: 1,
		replace: 0,
		remove: 0,
		keep: 0,
		untouched: 0,
		totalMinutes: 1350,
	});
	assert.deepEqual(
		writes(client).map(({ path, method }) => `${method} ${path}`),
		["POST /services/rest/record/v1/timebill"],
	);
	assert.deepEqual(writes(client)[0].body, addedBody("2026-11-18"));
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

	assert.equal(report.replace, 1);
	assert.equal(report.remove, 0);
	assert.equal(report.totalMinutes, 930);
	assert.deepEqual(
		writes(client).map(({ path, method }) => `${method} ${path}`),
		["POST /services/rest/record/v1/timebill", "DELETE /services/rest/record/v1/timebill/502"],
	);
	assert.deepEqual(writes(client)[0].body, addedBody("2026-11-18", "8:00"));
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

	assert.equal(report.weekStart, weekStart);
	assert.equal(report.create, 1);
	assert.match(client.calls[0].query, /startdate = TO_DATE\('2026-11-16', 'YYYY-MM-DD'\)/);
	assert.deepEqual(writes(client)[0].body, addedBody("2026-11-20"));
});

test("fillTimesheet refuses hours that are not a positive number", async () => {
	const client = clientWith();

	await assert.rejects(fillTimesheet(client, fillOptions({ hours: "8h" })), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /--hours expects a positive number/);
		return true;
	});
	assert.deepEqual(writes(client), []);
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
	assert.deepEqual(writes(client), []);
});

test("fillTimesheet replaces the entry whose activity changed", async () => {
	const client = clientWith({ entries: [entryRow({ id: "501" })] });

	const report = await fillTimesheet(client, fillOptions({ days: ["2026-11-16"], activityId: "72", force: true }));

	assert.equal(report.replace, 1);
	assert.deepEqual(
		writes(client).map(({ path, method }) => `${method} ${path}`),
		["POST /services/rest/record/v1/timebill", "DELETE /services/rest/record/v1/timebill/501"],
	);
	assert.deepEqual(writes(client)[0].body, { ...addedBody("2026-11-16"), item: "72" });
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
	assert.deepEqual(
		writes(client).map(({ path, method }) => `${method} ${path}`),
		["POST /services/rest/record/v1/timebill"],
	);
});
