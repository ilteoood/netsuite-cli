import { parseISO } from "date-fns/parseISO";
import { NetsuiteError, UsageError } from "./errors.mjs";
import { fetchProjectChoices, fetchTasks } from "./projects.mjs";
import {
	buildPlan,
	formatHours,
	normalizeExistingEntry,
	parseHours,
	totalMinutesOf,
	weekDates,
	weekStartOf,
} from "./schedule.mjs";

const RECORD_PATH = "/services/rest/record/v1";
const TIMEBILL_PATH = `${RECORD_PATH}/timebill`;
const TIMESHEET_PATH = `${RECORD_PATH}/timesheet`;
const APPROVED_TIMEBILL_STATUS = "3";
const weekRow = ({ weekStart, days, hours, project, task, activityId, memo }) => {
	const minutes = parseHours(hours);
	if (!(minutes > 0)) {
		throw new UsageError(`--hours expects a positive number such as 8 or 7:30, not "${hours}".`);
	}
	return {
		dailyHours: weekDates(weekStart).map((date) => (days.includes(date) ? minutes / 60 : 0)),
		projectId: project.id,
		taskId: task.id,
		itemId: activityId,
		memo,
		projectName: project.name,
	};
};

const readWeek = async (client, weekStart) => {
	const [timesheet] = await client.suiteql(
		`SELECT id, employee, custrecord_timesheetsubmitted FROM timesheet WHERE startdate = TO_DATE('${weekStart}', 'YYYY-MM-DD')`,
	);
	if (!timesheet) {
		throw new UsageError(`No timesheet exists for the week starting ${weekStart}.`);
	}
	const timesheetId = String(timesheet.id);
	const employeeId = String(timesheet.employee);
	const rows = await client.suiteql(
		`SELECT id, TO_CHAR(trandate, 'YYYY-MM-DD') AS entrydate, hours, memo, customer, item, casetaskevent, approvalstatus FROM timebill WHERE timesheet = '${timesheetId}'`,
	);
	return {
		timesheetId,
		employeeId,
		alreadySubmitted: timesheet.custrecord_timesheetsubmitted === "T",
		existingEntries: rows.map(normalizeExistingEntry),
	};
};

const assertNoApprovedEntries = ({ remove, replace }) => {
	const locked = [...remove, ...replace.map(({ existing }) => existing)].filter(
		(entry) => entry.approvalStatus === APPROVED_TIMEBILL_STATUS,
	);
	if (locked.length > 0) {
		throw new NetsuiteError(
			`NetSuite does not allow changing approved time entries: ${locked.map((entry) => `${entry.date} ${entry.customer}`).join(", ")}.`,
		);
	}
};

const assertForced = ({ replace, remove }, force) => {
	if (force || replace.length + remove.length === 0) return;
	throw new UsageError(
		`Nothing was written. ${replace.length} existing time entries would change and ${remove.length} would be removed; re-run with --force to apply it.`,
	);
};

const assertEveryEntryHasMemo = (entries) => {
	const withoutMemo = entries.filter((entry) => !entry.memo);
	if (withoutMemo.length > 0) {
		throw new NetsuiteError(
			`NetSuite needs a memo on every time entry before submitting. Missing: ${withoutMemo.map((entry) => entry.date).join(", ")}.`,
		);
	}
};
const assertWeekEditable = ({ timesheetId, alreadySubmitted }) => {
	if (alreadySubmitted) {
		throw new NetsuiteError(
			`Timesheet ${timesheetId} is already submitted. Retract it in NetSuite before filling it again.`,
		);
	}
};

const createEntry = (client, timesheetId, employeeId, entry) =>
	client.request(TIMEBILL_PATH, {
		method: "POST",
		body: {
			employee: employeeId,
			tranDate: entry.date,
			hours: formatHours(entry.minutes),
			customer: entry.customer,
			item: entry.item,
			caseTaskEvent: entry.caseTaskEvent,
			memo: entry.memo,
			isBillable: true,
			timesheet: String(timesheetId),
		},
	});

const writePlan = async (client, { timesheetId, employeeId, plan }) => {
	const created = [...plan.create, ...plan.replace.map(({ desired }) => desired)];
	for (const [index, entry] of created.entries()) {
		try {
			await createEntry(client, timesheetId, employeeId, entry);
		} catch (error) {
			throw new NetsuiteError(
				`NetSuite refused entry ${index + 1} of ${created.length} (${entry.date}): ${error.message} Nothing was removed, so the week can hold the new hours twice. Check it in NetSuite before running again.`,
				{ status: error.status ?? null, detail: error.detail ?? null },
			);
		}
	}
	const replaced = [...plan.remove, ...plan.replace.map(({ existing }) => existing)];
	for (const entry of replaced) {
		await client.request(`${TIMEBILL_PATH}/${entry.id}`, { method: "DELETE" });
	}
};

const submitWeek = async (client, timesheetId) => {
	const payload = await client.request(`${TIMESHEET_PATH}/${timesheetId}/@submit`, { method: "POST", body: {} });
	if (!payload?.result?.success) {
		throw new NetsuiteError(
			`NetSuite refused to submit timesheet ${timesheetId}: ${JSON.stringify(payload).slice(0, 400)}`,
		);
	}
};

const countsOf = (plan) => ({
	create: plan.create.length,
	replace: plan.replace.length,
	remove: plan.remove.length,
	keep: plan.keep.length,
	untouched: plan.untouched.length,
});

const namesOf = (choices) => new Map(choices.map(({ id, name }) => [id, name]));

const named = (names, id) => names.get(id) ?? id;

const byDateThenName = (left, right) =>
	left.date.localeCompare(right.date) ||
	left.projectName.localeCompare(right.projectName) ||
	left.taskName.localeCompare(right.taskName);

const describeEntry = ({ id, date, minutes, memo, customer, caseTaskEvent }, names) => ({
	id,
	date,
	projectName: named(names.projects, customer),
	taskName: named(names.tasks, caseTaskEvent),
	hours: formatHours(minutes),
	memo,
});

export const listTimesheet = async (client, weekStart) => {
	const { timesheetId, employeeId, alreadySubmitted, existingEntries } = await readWeek(client, weekStart);
	const { projects } = await fetchProjectChoices(client, weekStart);
	const tasks = await fetchTasks(client, { weekStart, employeeId });
	const names = { projects: namesOf(projects), tasks: namesOf(tasks) };
	return {
		weekStart,
		timesheetId,
		submitted: alreadySubmitted,
		totalMinutes: totalMinutesOf(existingEntries),
		entries: existingEntries.map((entry) => describeEntry(entry, names)).sort(byDateThenName),
	};
};

export const fillTimesheet = async (client, options) => {
	const {
		weekStart,
		project,
		task,
		hours,
		days,
		activityId,
		memo,
		dryRun = false,
		force = false,
		submit = false,
	} = options;
	const { timesheetId, employeeId, alreadySubmitted, existingEntries } = await readWeek(client, weekStart);
	const plan = buildPlan({
		rows: [weekRow({ weekStart, days, hours, project, task, activityId, memo })],
		weekStart,
		existingEntries,
	});
	const report = {
		weekStart,
		timesheetId,
		...countsOf(plan),
		totalMinutes: totalMinutesOf([...plan.desired, ...plan.untouched]),
		submitted: false,
	};

	if (dryRun) return report;

	assertWeekEditable({ timesheetId, alreadySubmitted });
	assertNoApprovedEntries(plan);
	assertForced(plan, force);
	if (submit) assertEveryEntryHasMemo([...plan.desired, ...plan.untouched]);
	await writePlan(client, { timesheetId, employeeId, plan });

	if (!submit) return report;

	await submitWeek(client, timesheetId);
	return { ...report, submitted: true };
};

export const addTimeEntry = async (client, options) => {
	const { date, project, task, hours, activityId, memo } = options;
	const weekStart = weekStartOf(parseISO(date));
	const { timesheetId, employeeId, alreadySubmitted, existingEntries } = await readWeek(client, weekStart);
	const plan = buildPlan({
		rows: [weekRow({ weekStart, days: [date], hours, project, task, activityId, memo })],
		weekStart,
		existingEntries,
	});
	const effectivePlan = { ...plan, remove: [] };
	const report = {
		weekStart,
		timesheetId,
		...countsOf(effectivePlan),
		totalMinutes: totalMinutesOf([...plan.desired, ...plan.untouched, ...plan.remove]),
	};

	assertWeekEditable({ timesheetId, alreadySubmitted });
	assertNoApprovedEntries(effectivePlan);
	await writePlan(client, { timesheetId, employeeId, plan: effectivePlan });
	return report;
};
