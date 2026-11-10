import { addDays as addCalendarDays } from "date-fns/addDays";
import { format } from "date-fns/format";
import { parseISO } from "date-fns/parseISO";
import { startOfWeek } from "date-fns/startOfWeek";

const MINUTES_PER_HOUR = 60;
const DAYS_IN_WEEK = 7;

export const addDays = (isoDate, days) => format(addCalendarDays(parseISO(isoDate), days), "yyyy-MM-dd");

export const weekStartOf = (date = new Date()) => format(startOfWeek(date, { weekStartsOn: 1 }), "yyyy-MM-dd");

export const weekDates = (weekStart) => Array.from({ length: DAYS_IN_WEEK }, (_, index) => addDays(weekStart, index));

export const formatHours = (minutes) =>
	`${Math.floor(minutes / MINUTES_PER_HOUR)}:${String(minutes % MINUTES_PER_HOUR).padStart(2, "0")}`;

export const parseHours = (value) => {
	const text = String(value ?? "").trim();
	if (!text) return 0;
	if (text.includes(":")) {
		const [hours, minutes] = text.split(":");
		return Number(hours) * MINUTES_PER_HOUR + Number(minutes);
	}
	return Math.round(Number(text.replace(",", ".")) * MINUTES_PER_HOUR);
};

export const buildDesiredEntries = ({ rows, weekStart }) => {
	const dates = weekDates(weekStart);
	const entries = [];
	for (const row of rows) {
		row.dailyHours.forEach((hours, dayIndex) => {
			if (!hours) return;
			entries.push({
				date: dates[dayIndex],
				minutes: Math.round(hours * MINUTES_PER_HOUR),
				customer: String(row.projectId),
				item: String(row.itemId),
				caseTaskEvent: String(row.taskId),
				memo: row.memo ?? "",
				label: row.projectName ?? row.projectId,
			});
		});
	}
	const seen = new Map();
	for (const entry of entries) {
		const key = entryKey(entry);
		if (seen.has(key)) {
			throw new Error(
				`The configuration schedules ${entry.label} twice on ${entry.date}. Give each project and task its own row.`,
			);
		}
		seen.set(key, entry);
	}
	return entries;
};

export const normalizeExistingEntry = (row) => ({
	id: String(row.id),
	date: String(row.entrydate ?? ""),
	minutes: parseHours(row.hours),
	memo: row.memo ?? "",
	customer: String(row.customer ?? ""),
	item: String(row.item ?? ""),
	caseTaskEvent: String(row.casetaskevent ?? ""),
	approvalStatus: String(row.approvalstatus ?? ""),
});

const entryKey = (entry) => `${entry.date}|${entry.customer}|${entry.caseTaskEvent}`;
const pairKey = (entry) => `${entry.customer}|${entry.caseTaskEvent}`;

export const buildPlan = ({ rows, weekStart, existingEntries }) => {
	const desired = buildDesiredEntries({ rows, weekStart });
	const managedPairs = new Set(desired.map(pairKey));
	const existingByKey = new Map();
	for (const entry of existingEntries) {
		const key = entryKey(entry);
		if (existingByKey.has(key)) {
			throw new Error(
				`Timesheet ${weekStart} already holds two entries for ${entry.customer} on ${entry.date}. Fix them in NetSuite before filling it again.`,
			);
		}
		existingByKey.set(key, entry);
	}

	const create = [];
	const replace = [];
	const keep = [];
	for (const entry of desired) {
		const existing = existingByKey.get(entryKey(entry));
		if (!existing) {
			create.push(entry);
			continue;
		}
		if (existing.minutes !== entry.minutes || existing.memo !== entry.memo || existing.item !== entry.item) {
			replace.push({ existing, desired: entry });
			continue;
		}
		keep.push(existing);
	}

	const desiredKeys = new Set(desired.map(entryKey));
	const remove = [];
	const untouched = [];
	for (const entry of existingEntries) {
		if (!managedPairs.has(pairKey(entry))) {
			untouched.push(entry);
			continue;
		}
		if (desiredKeys.has(entryKey(entry))) continue;
		remove.push(entry);
	}

	return { desired, create, replace, remove, keep, untouched };
};

export const totalMinutesOf = (entries) => entries.reduce((total, entry) => total + entry.minutes, 0);
