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
	assert.equal(parseHours("8"), 480);
	assert.equal(parseHours("8:00"), 480);
	assert.equal(parseHours("7:30"), 450);
	assert.equal(parseHours("0.5"), 30);
	assert.equal(parseHours(""), 0);
	assert.equal(parseHours(null), 0);
});

test("formatHours writes NetSuite style durations", () => {
	assert.equal(formatHours(480), "8:00");
	assert.equal(formatHours(450), "7:30");
	assert.equal(formatHours(0), "0:00");
});

test("buildDesiredEntries maps the week onto the configured hours", () => {
	const entries = buildDesiredEntries({ rows, weekStart: "2026-11-09" });

	assert.equal(entries.length, 5);
	assert.equal(entries[0].date, "2026-11-09");
	assert.equal(entries[4].date, "2026-11-13");
	assert.equal(entries[0].customer, "1000");
	assert.equal(entries[0].caseTaskEvent, "2000");
	assert.equal(entries[0].item, "90");
	assert.equal(entries[0].memo, "Example memo");
	assert.equal(totalMinutesOf(entries), 2400);
});

test("addDays shifts a date by whole days", () => {
	assert.equal(addDays("2026-11-09", 7), "2026-11-16");
	assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("weekDates walks the seven days of the week", () => {
	assert.deepEqual(weekDates("2026-11-09"), [
		"2026-11-09",
		"2026-11-10",
		"2026-11-11",
		"2026-11-12",
		"2026-11-13",
		"2026-11-14",
		"2026-11-15",
	]);
	assert.deepEqual(weekDates("2026-12-28"), [
		"2026-12-28",
		"2026-12-29",
		"2026-12-30",
		"2026-12-31",
		"2027-01-01",
		"2027-01-02",
		"2027-01-03",
	]);
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

	assert.equal(entry.date, "2026-11-09");
	assert.equal(entry.minutes, 480);
	assert.equal(entry.customer, "1000");
	assert.equal(entry.caseTaskEvent, "2000");
	assert.equal(entry.approvalStatus, "1");
});

test("buildPlan creates the missing days and keeps the matching ones", () => {
	const existing = [existingEntry({ id: "10", entrydate: "2026-11-09" })];

	const plan = buildPlan({ rows, weekStart: "2026-11-09", existingEntries: existing });

	assert.equal(plan.create.length, 4);
	assert.equal(plan.keep.length, 1);
	assert.equal(plan.replace.length, 0);
	assert.equal(plan.remove.length, 0);
});

test("buildPlan replaces an entry whose hours or memo changed", () => {
	const existing = [existingEntry({ id: "10", hours: "4", memo: "Other" })];

	const plan = buildPlan({ rows, weekStart: "2026-11-09", existingEntries: existing });

	assert.equal(plan.replace.length, 1);
	assert.equal(plan.replace[0].existing.id, "10");
	assert.equal(plan.replace[0].desired.minutes, 480);
});

test("buildPlan removes the entries of a managed project that are no longer scheduled", () => {
	const existing = [
		existingEntry({ id: "10", entrydate: "2026-11-09" }),
		existingEntry({ id: "11", entrydate: "2026-11-14" }),
	];

	const plan = buildPlan({ rows, weekStart: "2026-11-09", existingEntries: existing });

	assert.equal(plan.remove.length, 1);
	assert.equal(plan.remove[0].id, "11");
	assert.equal(plan.keep.length, 1);
});

test("buildPlan leaves the entries of other projects alone", () => {
	const existing = [existingEntry({ id: "10", customer: "2001", casetaskevent: "", item: "91" })];

	const plan = buildPlan({ rows, weekStart: "2026-11-09", existingEntries: existing });

	assert.equal(plan.untouched.length, 1);
	assert.equal(plan.remove.length, 0);
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
