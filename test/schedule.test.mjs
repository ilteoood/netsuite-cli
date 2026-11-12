import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addDays,
	buildDesiredEntries,
	buildPlan,
	formatHours,
	normalizeExistingEntry,
	parseHours,
	totalMinutesOf,
	weekDates,
} from "../src/schedule.mjs";

const rows = [
	{
		projectId: "1000",
		projectName: "Example project",
		taskId: "2000",
		itemId: "90",
		memo: "Example memo",
		billable: true,
		dailyHours: [8, 8, 8, 8, 8, 0, 0],
	},
];

const existingEntry = (overrides = {}) =>
	normalizeExistingEntry({
		id: "1",
		entrydate: "2026-11-09",
		hours: "8",
		memo: "Example memo",
		customer: "1000",
		item: "90",
		casetaskevent: "2000",
		approvalstatus: "1",
		...overrides,
	});

test("parseHours reads plain, colon and decimal hours", () => {
	assert.deepStrictEqual(
		{
			plain: parseHours("8"),
			colon: parseHours("8:00"),
			half: parseHours("7:30"),
			decimal: parseHours("0.5"),
			empty: parseHours(""),
			missing: parseHours(null),
		},
		{ plain: 480, colon: 480, half: 450, decimal: 30, empty: 0, missing: 0 },
	);
});

test("formatHours writes NetSuite style durations", () => {
	assert.deepStrictEqual(
		{ eight: formatHours(480), sevenThirty: formatHours(450), zero: formatHours(0) },
		{ eight: "8:00", sevenThirty: "7:30", zero: "0:00" },
	);
});

test("buildDesiredEntries maps the week onto the configured hours", () => {
	const entries = buildDesiredEntries({ rows, weekStart: "2026-11-09" });

	assert.deepStrictEqual(
		{
			count: entries.length,
			firstDate: entries[0].date,
			lastDate: entries[4].date,
			customer: entries[0].customer,
			caseTaskEvent: entries[0].caseTaskEvent,
			item: entries[0].item,
			memo: entries[0].memo,
			totalMinutes: totalMinutesOf(entries),
		},
		{
			count: 5,
			firstDate: "2026-11-09",
			lastDate: "2026-11-13",
			customer: "1000",
			caseTaskEvent: "2000",
			item: "90",
			memo: "Example memo",
			totalMinutes: 2400,
		},
	);
});

test("addDays shifts a date by whole days", () => {
	assert.deepStrictEqual(
		{ week: addDays("2026-11-09", 7), year: addDays("2026-12-31", 1) },
		{ week: "2026-11-16", year: "2027-01-01" },
	);
});

test("weekDates walks the seven days of the week", () => {
	assert.deepStrictEqual(
		{ first: weekDates("2026-11-09"), second: weekDates("2026-12-28") },
		{
			first: ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"],
			second: ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"],
		},
	);
});

test("buildDesiredEntries rejects two rows scheduled on the same day", () => {
	assert.throws(
		() =>
			buildDesiredEntries({
				rows: [rows[0], { ...rows[0], projectName: "Other project" }],
				weekStart: "2026-11-09",
			}),
		/schedules .* twice on 2026-11-09/,
	);
});

test("normalizeExistingEntry turns a SuiteQL row into a comparable entry", () => {
	const entry = existingEntry();

	assert.deepStrictEqual(
		{
			date: entry.date,
			minutes: entry.minutes,
			customer: entry.customer,
			caseTaskEvent: entry.caseTaskEvent,
			approvalStatus: entry.approvalStatus,
		},
		{ date: "2026-11-09", minutes: 480, customer: "1000", caseTaskEvent: "2000", approvalStatus: "1" },
	);
});

test("buildPlan creates the missing days and keeps the matching ones", () => {
	const existing = [existingEntry({ id: "10", entrydate: "2026-11-09" })];

	const plan = buildPlan({ rows, weekStart: "2026-11-09", existingEntries: existing });

	assert.deepStrictEqual(
		{
			create: plan.create.length,
			keep: plan.keep.length,
			replace: plan.replace.length,
			remove: plan.remove.length,
		},
		{ create: 4, keep: 1, replace: 0, remove: 0 },
	);
});

test("buildPlan replaces an entry whose hours or memo changed", () => {
	const existing = [existingEntry({ id: "10", hours: "4", memo: "Other" })];

	const plan = buildPlan({ rows, weekStart: "2026-11-09", existingEntries: existing });

	assert.deepStrictEqual(
		{
			replace: plan.replace.length,
			id: plan.replace[0].existing.id,
			minutes: plan.replace[0].desired.minutes,
		},
		{ replace: 1, id: "10", minutes: 480 },
	);
});

test("buildPlan removes the entries of a managed project that are no longer scheduled", () => {
	const existing = [
		existingEntry({ id: "10", entrydate: "2026-11-09" }),
		existingEntry({ id: "11", entrydate: "2026-11-14" }),
	];

	const plan = buildPlan({ rows, weekStart: "2026-11-09", existingEntries: existing });

	assert.deepStrictEqual(
		{ remove: plan.remove.length, removedId: plan.remove[0].id, keep: plan.keep.length },
		{ remove: 1, removedId: "11", keep: 1 },
	);
});

test("buildPlan leaves the entries of other projects alone", () => {
	const existing = [existingEntry({ id: "10", customer: "2001", casetaskevent: "", item: "91" })];

	const plan = buildPlan({ rows, weekStart: "2026-11-09", existingEntries: existing });

	assert.deepStrictEqual({ untouched: plan.untouched.length, remove: plan.remove.length }, { untouched: 1, remove: 0 });
});

test("buildPlan refuses a week that already holds the same day twice", () => {
	const existing = [
		existingEntry({ id: "10", entrydate: "2026-11-09" }),
		existingEntry({ id: "11", entrydate: "2026-11-09" }),
	];

	assert.throws(
		() => buildPlan({ rows, weekStart: "2026-11-09", existingEntries: existing }),
		/already holds two entries/,
	);
});
