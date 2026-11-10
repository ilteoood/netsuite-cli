import { UsageError } from "./errors.mjs";

export const LEAVE_TYPES = {
	84: "Annual Leave",
	85: "Bank Holiday",
	102: "Training",
	242: "Event Leave",
	252: "Other Leave",
};

export const APPROVAL_STATUSES = {
	1: "Approved",
	2: "Approval Requested",
	3: "Rejected",
	4: "Cancel Requested",
	5: "Cancelled",
	6: "Request Incomplete",
};

export const ACTIVITY_ITEMS = {
	71: "Solution Delivery",
};

export const labelOf = (table, id) => table[id] ?? String(id);

const describe = (entries) => entries.map(([id, label]) => `${id} ${label}`).join(", ");

const resolveFrom = (table, value, what) => {
	const requested = String(value ?? "")
		.trim()
		.toLowerCase();
	const matches = Object.entries(table).filter(([, label]) => requested && label.toLowerCase().includes(requested));
	if (matches.length === 1) {
		const [id, label] = matches[0];
		return { id, name: label };
	}
	if (matches.length > 1)
		throw new UsageError(`"${value}" matches several ${what}s: ${describe(matches)}; use a longer name`);
	throw new UsageError(`unknown ${what} "${value}"; available: ${describe(Object.entries(table))}`);
};

export const resolveLeaveType = (name) => resolveFrom(LEAVE_TYPES, name, "leave type");

export const resolveActivity = (value) => {
	const text = String(value ?? "").trim();
	if (/^\d+$/.test(text)) return { id: text, name: labelOf(ACTIVITY_ITEMS, text) };
	return resolveFrom(ACTIVITY_ITEMS, text, "activity");
};
