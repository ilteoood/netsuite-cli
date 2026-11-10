import { format } from "date-fns/format";
import { NetsuiteError, UsageError } from "./errors.mjs";
import { APPROVAL_STATUSES, LEAVE_TYPES, labelOf } from "./labels.mjs";
import { weekStartOf } from "./schedule.mjs";

const CANCELLED_STATUS = "5";
const APPROVAL_REQUESTED = "2";
const ABSENCE_RECORD = "customrecord_ct_hr_extendedtimeentry";

const ABSENCE_COLUMNS =
	"id, custrecord_ct_hr_ext_leaveabsencetype, TO_CHAR(custrecord_ct_hr_absencestartdate2, 'YYYY-MM-DD') AS startdate, TO_CHAR(custrecord_ct_hr_absenceenddate2, 'YYYY-MM-DD') AS enddate, custrecord_ct_hr_approvalstatus";

export const ABSENCE_QUERY = `SELECT ${ABSENCE_COLUMNS}, custrecord_ct_hr_ext_days_dur FROM ${ABSENCE_RECORD}`;

export const EMPLOYEE_ID_QUERY = (weekStart) =>
	`SELECT employee FROM timesheet WHERE startdate = TO_DATE('${weekStart}', 'YYYY-MM-DD')`;

export const EMPLOYEE_ABSENCES_QUERY = (employeeId) =>
	`SELECT ${ABSENCE_COLUMNS} FROM ${ABSENCE_RECORD} WHERE custrecord_ct_hr_lap_employeeid = '${employeeId}'`;

const toAbsence = (row) => {
	const typeId = String(row.custrecord_ct_hr_ext_leaveabsencetype);
	const statusId = String(row.custrecord_ct_hr_approvalstatus);
	return {
		id: String(row.id),
		typeId,
		typeLabel: labelOf(LEAVE_TYPES, typeId),
		startDate: row.startdate,
		endDate: row.enddate,
		statusId,
		statusLabel: labelOf(APPROVAL_STATUSES, statusId),
		days: row.custrecord_ct_hr_ext_days_dur,
	};
};

export const listAbsences = async (client, { today = format(new Date(), "yyyy-MM-dd") } = {}) => {
	const rows = await client.suiteql(ABSENCE_QUERY);
	return rows
		.map(toAbsence)
		.filter((row) => row.endDate >= today && row.statusId !== CANCELLED_STATUS)
		.sort((left, right) => left.startDate.localeCompare(right.startDate));
};

export const currentEmployeeId = async (client) => {
	const weekStart = weekStartOf();
	const ids = [...new Set((await client.suiteql(EMPLOYEE_ID_QUERY(weekStart))).map((row) => String(row.employee)))];
	if (ids.length === 1) return ids[0];
	throw new UsageError(
		ids.length === 0
			? `No timesheet exists for the week starting ${weekStart}, so the CLI cannot tell which employee is signed in.`
			: `The timesheets of the week starting ${weekStart} name several employees (${ids.join(", ")}).`,
	);
};

export const createAbsence = async (
	client,
	{ typeId, typeLabel, startDate, endDate = startDate, memo = "", reference },
) => {
	if (endDate < startDate) {
		throw new UsageError(`The end date ${endDate} is before the start date ${startDate}.`);
	}
	const employeeId = await currentEmployeeId(client);
	const existing = (await client.suiteql(EMPLOYEE_ABSENCES_QUERY(employeeId)))
		.map(toAbsence)
		.filter((row) => row.statusId !== CANCELLED_STATUS);
	const clash = existing.find((row) => row.startDate <= endDate && startDate <= row.endDate);
	if (clash) {
		throw new UsageError(
			`${startDate} → ${endDate} overlaps ${clash.typeLabel} ${clash.startDate} → ${clash.endDate} (id ${clash.id}).`,
		);
	}

	const name = reference ?? `${typeLabel ?? labelOf(LEAVE_TYPES, typeId)} ${startDate} → ${endDate}`;
	const { headers } = await client.requestRaw(`/services/rest/record/v1/${ABSENCE_RECORD}`, {
		method: "POST",
		body: {
			name,
			custrecord_ct_hr_lap_employeeid: { id: employeeId },
			custrecord_ct_hr_ext_leaveabsencetype: { id: typeId },
			custrecord_ct_hr_absencestartdate2: startDate,
			custrecord_ct_hr_absenceenddate2: endDate,
			custrecord_ct_hr_memo2: memo,
			custrecord_ct_hr_approvalstatus: { id: APPROVAL_REQUESTED },
			custrecord_ct_hr_islapsubmitted: true,
		},
	});
	const id = headers.get("location")?.split("/").filter(Boolean).pop();
	if (!id)
		throw new NetsuiteError("NetSuite accepted the absence but returned no Location header, so its id is unknown.");
	return { id, reference: name };
};
