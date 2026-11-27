import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPLOYEE_ABSENCES_QUERY } from "../src/absences.mjs";
import { NetsuiteError, UsageError } from "../src/errors.mjs";
import { ADJUSTMENT_QUERY, ALLOWANCE_QUERY, computeLeaveBalance, fetchLeaveBalance } from "../src/leave-balance.mjs";

const allowance = (overrides = {}) => ({
	id: "70002",
	start: "2026-01-01",
	end: "2026-12-31",
	contractual: 24,
	carriedForward: 4,
	entitlement: 28,
	...overrides,
});

const leave = (startDate, endDate, hours, statusId = "1", overrides = {}) => ({
	id: startDate,
	typeId: "84",
	statusId,
	startDate,
	endDate,
	days: hours / 8,
	hours,
	...overrides,
});

const adjustment = (type, days, effectiveFrom, effectiveUntil, inHours = false) => ({
	type,
	days,
	inHours,
	effectiveFrom,
	effectiveUntil,
});

const balanceOf = (overrides) =>
	computeLeaveBalance({ year: "2026", allowances: [allowance()], adjustments: [], absences: [], ...overrides });

test("computeLeaveBalance counts the hours of the annual leave that overlaps the period", () => {
	const balance = balanceOf({
		allowances: [allowance({ id: "70001", start: "2025-01-01", end: "2025-12-31", entitlement: 32 }), allowance()],
		absences: [
			leave("2025-12-26", "2026-01-01", 24),
			leave("2025-12-09", "2025-12-12", 32),
			leave("2026-04-14", "2026-04-17", 32),
			leave("2026-08-24", "2026-09-07", 88, "4"),
			leave("2026-11-02", "2026-11-02", 4),
			leave("2026-12-14", "2026-12-15", 16, "2"),
			leave("2026-12-21", "2026-12-21", 8, "6"),
			leave("2026-07-01", "2026-07-02", 16, "5"),
			leave("2026-07-08", "2026-07-08", 8, "3"),
			leave("2026-05-04", "2026-05-05", 16, "1", { typeId: "102" }),
		],
	});

	assert.deepStrictEqual(balance, {
		year: "2026",
		periodStart: "2026-01-01",
		periodEnd: "2026-12-31",
		contractual: 24,
		carriedForward: 4,
		entitlement: 28,
		booked: 18.5,
		pending: 2,
		remaining: 7.5,
		unrecorded: [],
		adjustments: [],
	});
});

test("computeLeaveBalance lists booked or pending annual leave with no recorded hours as not counted", () => {
	const balance = balanceOf({
		absences: [
			leave("2026-12-28", "2026-12-31", 0, "1", { id: "80004", days: 4 }),
			leave("2026-12-14", "2026-12-14", 0, "5", { days: 1 }),
			leave("2026-04-14", "2026-04-17", 32),
		],
	});

	assert.deepStrictEqual(
		{ booked: balance.booked, remaining: balance.remaining, unrecorded: balance.unrecorded },
		{
			booked: 4,
			remaining: 24,
			unrecorded: [{ id: "80004", startDate: "2026-12-28", endDate: "2026-12-31", days: 4 }],
		},
	);
});

test("computeLeaveBalance shows the day adjustments valid during the period apart from the remaining days", () => {
	const balance = computeLeaveBalance({
		year: "2027",
		allowances: [allowance({ start: "2027-01-01", end: "2027-12-31", entitlement: 24, carriedForward: 0 })],
		adjustments: [
			adjustment("Rol (IT)", 2.6, "2026-06-26", "2027-06-30"),
			adjustment("Transfer", 1, "2025-05-01", null),
			adjustment("Purchased Leave", 2, "2026-01-01", "2026-12-31"),
			adjustment("TOIL", 8, "2027-03-01", null, true),
		],
		absences: [],
	});

	assert.deepStrictEqual(
		{ remaining: balance.remaining, adjustments: balance.adjustments },
		{
			remaining: 24,
			adjustments: [
				{ type: "Rol (IT)", days: 2.6, effectiveFrom: "2026-06-26", effectiveUntil: "2027-06-30" },
				{ type: "Transfer", days: 1, effectiveFrom: "2025-05-01", effectiveUntil: null },
			],
		},
	);
});

test("computeLeaveBalance names the years that have an allowance when the requested one has none", () => {
	assert.throws(
		() =>
			balanceOf({
				year: "2023",
				allowances: [allowance({ start: "2025-01-01" }), allowance({ id: "70003", start: "2025-01-01" }), allowance()],
			}),
		(error) => error instanceof UsageError && error.message.endsWith("allowances exist for 2025, 2026"),
	);
});

test("computeLeaveBalance refuses to choose between two allowances of the same year", () => {
	assert.throws(
		() =>
			balanceOf({
				allowances: [allowance({ id: "70002", end: "2026-05-31" }), allowance({ id: "70003", start: "2026-06-01" })],
			}),
		(error) =>
			error instanceof NetsuiteError &&
			error.message.includes("several annual leave allowances starting in 2026 (70002, 70003)"),
	);
});

const absenceRow = (overrides = {}) => ({
	id: "1",
	custrecord_ct_hr_ext_leaveabsencetype: "84",
	startdate: "2024-07-01",
	enddate: "2024-07-02",
	custrecord_ct_hr_approvalstatus: "1",
	custrecord_ct_hr_ext_days_dur: "2",
	custrecord_ct_hr_ext_hours_dur: "16",
	...overrides,
});

const clientAnswering = ({ allowances, adjustments = [], absences = [] }) => {
	const queries = [];
	const answers = new Map([
		[ALLOWANCE_QUERY("4242"), allowances],
		[ADJUSTMENT_QUERY("4242"), adjustments],
		[EMPLOYEE_ABSENCES_QUERY("4242"), absences],
	]);
	return {
		queries,
		suiteql: async (query) => {
			queries.push(query);
			if (query.startsWith("SELECT employee FROM timesheet")) return [{ employee: "4242" }];
			return answers.get(query) ?? [];
		},
	};
};

const allowanceRow = {
	id: "70001",
	periodstart: "2024-06-03",
	periodend: "2024-12-31",
	contractual: "16.2",
	entitlement: "16",
};

test("fetchLeaveBalance parses the NetSuite rows of the signed-in employee", async () => {
	const client = clientAnswering({
		allowances: [allowanceRow],
		absences: [
			absenceRow(),
			absenceRow({
				id: "2",
				startdate: "2024-12-23",
				enddate: "2024-12-24",
				custrecord_ct_hr_ext_hours_dur: undefined,
			}),
		],
	});

	const balance = await fetchLeaveBalance(client, { year: "2024" });

	assert.deepStrictEqual(
		{
			figures: [balance.contractual, balance.carriedForward, balance.entitlement, balance.booked, balance.remaining],
			unrecorded: balance.unrecorded,
			queries: client.queries.slice(1).sort(),
		},
		{
			figures: [16.2, 0, 16, 2, 14],
			unrecorded: [{ id: "2", startDate: "2024-12-23", endDate: "2024-12-24", days: 2 }],
			queries: [ADJUSTMENT_QUERY("4242"), ALLOWANCE_QUERY("4242"), EMPLOYEE_ABSENCES_QUERY("4242")].sort(),
		},
	);
});

test("fetchLeaveBalance refuses a value that is not a number and an allowance without an entitlement", async () => {
	await assert.rejects(
		fetchLeaveBalance(
			clientAnswering({
				allowances: [allowanceRow],
				absences: [absenceRow({ custrecord_ct_hr_ext_hours_dur: "7:30" })],
			}),
			{ year: "2024" },
		),
		(error) => error instanceof NetsuiteError && error.message.includes('"7:30" as the hours of absence 1'),
	);
	await assert.rejects(
		fetchLeaveBalance(clientAnswering({ allowances: [{ ...allowanceRow, entitlement: undefined }] }), { year: "2024" }),
		(error) => error instanceof NetsuiteError && error.message.includes("allowance 70001 has no entitlement"),
	);
});
