import assert from "node:assert/strict";
import { test } from "node:test";
import { ABSENCE_QUERY, createAbsence, currentEmployeeId, EMPLOYEE_ID_QUERY, listAbsences } from "../src/absences.mjs";
import { NetsuiteError, UsageError } from "../src/errors.mjs";
import { weekStartOf } from "../src/schedule.mjs";

const today = "2026-11-10";

const absenceRow = (overrides = {}) => ({
	id: "10",
	custrecord_ct_hr_ext_leaveabsencetype: "84",
	startdate: "2026-12-28",
	enddate: "2026-12-31",
	custrecord_ct_hr_approvalstatus: "2",
	custrecord_ct_hr_ext_days_dur: 4,
	...overrides,
});

const clientReturning = (rows) => {
	const queries = [];
	return {
		queries,
		suiteql: async (query) => {
			queries.push(query);
			return rows;
		},
	};
};

test("listAbsences maps a SuiteQL row to the table shape", async () => {
	const rows = await listAbsences(clientReturning([absenceRow()]), { today });
	assert.deepStrictEqual(rows, [
		{
			id: "10",
			typeId: "84",
			typeLabel: "Annual Leave",
			startDate: "2026-12-28",
			endDate: "2026-12-31",
			statusId: "2",
			statusLabel: "Approval Requested",
			days: 4,
		},
	]);
});

test("listAbsences drops cancelled rows and rows that already ended", async () => {
	const rows = await listAbsences(
		clientReturning([
			absenceRow({ id: "10" }),
			absenceRow({ id: "11", custrecord_ct_hr_approvalstatus: "5" }),
			absenceRow({ id: "12", enddate: "2026-11-09" }),
			absenceRow({ id: "13", startdate: "2026-11-10", enddate: "2026-11-10" }),
		]),
		{ today },
	);
	assert.deepStrictEqual(
		rows.map((row) => row.id),
		["13", "10"],
	);
});

test("listAbsences sorts the rows by start date, soonest first", async () => {
	const rows = await listAbsences(
		clientReturning([
			absenceRow({ id: "20", startdate: "2026-12-28", enddate: "2026-12-31" }),
			absenceRow({ id: "21", startdate: "2026-11-16", enddate: "2026-11-16" }),
			absenceRow({ id: "22", startdate: "2026-11-20", enddate: "2026-11-20" }),
		]),
		{ today },
	);
	assert.deepStrictEqual(
		rows.map((row) => row.id),
		["21", "22", "20"],
	);
});

test("listAbsences reads the entries with one SuiteQL query", async () => {
	const client = clientReturning([]);
	await listAbsences(client, { today });

	assert.deepStrictEqual(
		{
			queries: client.queries,
			readsFromTheTimeEntryTable: /FROM customrecord_ct_hr_extendedtimeentry/.test(client.queries[0]),
			selectsEveryField: [
				"custrecord_ct_hr_ext_leaveabsencetype",
				"custrecord_ct_hr_absencestartdate2",
				"custrecord_ct_hr_absenceenddate2",
				"custrecord_ct_hr_approvalstatus",
				"custrecord_ct_hr_ext_days_dur",
			].map((field) => new RegExp(field).test(client.queries[0])),
			hasNoIdFilter: !/WHERE id/.test(client.queries[0]),
		},
		{
			queries: [ABSENCE_QUERY],
			readsFromTheTimeEntryTable: true,
			selectsEveryField: [true, true, true, true, true],
			hasNoIdFilter: true,
		},
	);
});

test("an id that is not in the label table prints as the id", async () => {
	const [row] = await listAbsences(
		clientReturning([
			absenceRow({ custrecord_ct_hr_ext_leaveabsencetype: "999", custrecord_ct_hr_approvalstatus: "9" }),
		]),
		{ today },
	);

	assert.deepStrictEqual(
		{ typeLabel: row.typeLabel, statusLabel: row.statusLabel },
		{ typeLabel: "999", statusLabel: "9" },
	);
});

const ABSENCE_PATH = "/services/rest/record/v1/customrecord_ct_hr_extendedtimeentry";

const writeClient = ({ absences = [], employees = [{ employee: "4242" }], location = `${ABSENCE_PATH}/9001` } = {}) => {
	const calls = { queries: [], posts: [] };
	return {
		calls,
		suiteql: async (query) => {
			calls.queries.push(query);
			return query.includes("FROM timesheet") ? employees : absences;
		},
		requestRaw: async (path, options) => {
			calls.posts.push({ path, ...options });
			return { status: 204, headers: new Headers(location ? { location } : {}), body: null };
		},
	};
};

const request = {
	typeId: "84",
	typeLabel: "Annual Leave",
	startDate: "2027-04-14",
	endDate: "2027-04-14",
	memo: "Family trip",
};

test("createAbsence posts the verified payload with the composed reference", async () => {
	const client = writeClient();

	const created = await createAbsence(client, request);

	assert.deepStrictEqual(
		{
			created,
			postCount: client.calls.posts.length,
			path: client.calls.posts[0].path,
			method: client.calls.posts[0].method,
			body: client.calls.posts[0].body,
		},
		{
			created: { id: "9001", reference: "Annual Leave 2027-04-14 → 2027-04-14" },
			postCount: 1,
			path: ABSENCE_PATH,
			method: "POST",
			body: {
				name: "Annual Leave 2027-04-14 → 2027-04-14",
				custrecord_ct_hr_lap_employeeid: { id: "4242" },
				custrecord_ct_hr_ext_leaveabsencetype: { id: "84" },
				custrecord_ct_hr_absencestartdate2: "2027-04-14",
				custrecord_ct_hr_absenceenddate2: "2027-04-14",
				custrecord_ct_hr_memo2: "Family trip",
				custrecord_ct_hr_approvalstatus: { id: "2" },
				custrecord_ct_hr_islapsubmitted: true,
			},
		},
	);
});

test("createAbsence uses an explicit reference verbatim and defaults the end date", async () => {
	const client = writeClient();

	const created = await createAbsence(client, { ...request, reference: "Easter break", endDate: undefined });

	assert.deepStrictEqual(
		{
			reference: created.reference,
			name: client.calls.posts[0].body.name,
			endDate: client.calls.posts[0].body.custrecord_ct_hr_absenceenddate2,
		},
		{ reference: "Easter break", name: "Easter break", endDate: "2027-04-14" },
	);
});

test("createAbsence is a NetsuiteError when the create returns no Location header", async () => {
	const client = writeClient({ location: null });

	await assert.rejects(createAbsence(client, request), (error) => {
		assert.ok(error instanceof NetsuiteError);
		assert.match(error.message, /Location/);
		return true;
	});
});

test("createAbsence refuses a range that overlaps an existing entry before any post", async () => {
	const client = writeClient({ absences: [absenceRow({ startdate: "2027-04-10", enddate: "2027-04-14" })] });

	await assert.rejects(createAbsence(client, request), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /Annual Leave 2027-04-10 → 2027-04-14 \(id 10\)/);
		return true;
	});
	assert.deepStrictEqual(
		{
			postCount: client.calls.posts.length,
			employeeFilter: /custrecord_ct_hr_lap_employeeid = '4242'/.test(client.calls.queries[1]),
		},
		{ postCount: 0, employeeFilter: true },
	);
});

test("createAbsence still sees an entry that ended in the past", async () => {
	const client = writeClient({
		absences: [absenceRow({ id: "31", startdate: "2020-03-01", enddate: "2020-03-05" })],
	});

	await assert.rejects(
		createAbsence(client, { ...request, startDate: "2020-03-05", endDate: "2020-03-06" }),
		(error) => error instanceof UsageError && /id 31/.test(error.message),
	);
	assert.strictEqual(client.calls.posts.length, 0);
});

test("createAbsence ignores a cancelled entry when checking overlaps", async () => {
	const client = writeClient({
		absences: [absenceRow({ custrecord_ct_hr_approvalstatus: "5" })],
	});

	const created = await createAbsence(client, request);

	assert.deepStrictEqual({ id: created.id, postCount: client.calls.posts.length }, { id: "9001", postCount: 1 });
});

test("createAbsence allows a range that starts the day after an existing one ends", async () => {
	const client = writeClient({ absences: [absenceRow({ startdate: "2027-04-01", enddate: "2027-04-13" })] });

	const created = await createAbsence(client, request);

	assert.deepStrictEqual({ id: created.id, postCount: client.calls.posts.length }, { id: "9001", postCount: 1 });
});

test("currentEmployeeId reads the employee of the current week's timesheet", async () => {
	const client = writeClient();

	assert.deepStrictEqual(
		{ employeeId: await currentEmployeeId(client), queries: client.calls.queries },
		{ employeeId: "4242", queries: [EMPLOYEE_ID_QUERY(weekStartOf())] },
	);
});

test("currentEmployeeId fails when the current week has no timesheet", async () => {
	const client = writeClient({ employees: [] });

	await assert.rejects(currentEmployeeId(client), (error) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, /No timesheet exists for the week starting/);
		return true;
	});
});

test("createAbsence refuses a range that ends before it starts", async () => {
	const client = clientReturning([absenceRow()]);

	await assert.rejects(
		createAbsence(client, { typeId: "84", startDate: "2027-04-14", endDate: "2027-04-13" }),
		(error) => {
			assert.ok(error instanceof UsageError);
			assert.match(error.message, /before the start date/);
			return true;
		},
	);
});
