import { currentEmployeeId, employeeAbsences } from "./absences.mjs";
import { NetsuiteError, UsageError } from "./errors.mjs";
import { ANNUAL_LEAVE_TYPE, APPROVAL_REQUESTED, APPROVED, CANCEL_REQUESTED } from "./labels.mjs";

const BOOKED = new Set([APPROVED, CANCEL_REQUESTED]);
const PENDING = new Set([APPROVAL_REQUESTED]);
const HOURS_PER_DAY = 8;

export const ALLOWANCE_QUERY = (employeeId) =>
	`SELECT id, TO_CHAR(custrecord_ct_hr_periodstart, 'YYYY-MM-DD') AS periodstart, TO_CHAR(custrecord_ct_hr_periodend, 'YYYY-MM-DD') AS periodend, custrecord_ct_hr_contractualleavedays AS contractual, custrecord_ct_hr_leave_cf AS carriedforward, custrecord_ct_hr_totalannualleave AS entitlement FROM customrecord_ct_hr_annualleaveallowance WHERE custrecord_ct_hr_employeeid4 = '${employeeId}' AND isinactive = 'F' AND custrecord_ct_hr_periodstart IS NOT NULL AND custrecord_ct_hr_periodend IS NOT NULL`;

export const ADJUSTMENT_QUERY = (employeeId) =>
	`SELECT id, BUILTIN.DF(custrecord_ct_hr_annual_leave_adj_type) AS type, custrecord_ct_hr_annual_leave_adj_adjust AS days, custrecord_ct_hr_annual_leave_adj_hrs AS inhours, TO_CHAR(custrecord_ct_hr_annual_leave_adj_af_dte, 'YYYY-MM-DD') AS effectivefrom, TO_CHAR(custrecord_ct_hr_leave_adjust__eff_until, 'YYYY-MM-DD') AS effectiveuntil FROM customrecord_ct_hr_annual_leave_adjust WHERE custrecord_ct_hr_annual_leave_adj_emp = '${employeeId}' AND isinactive = 'F'`;

const amountOf = (value, what) => {
	if (value === undefined || value === null || value === "") return null;
	const amount = Number(value);
	if (Number.isFinite(amount)) return amount;
	throw new NetsuiteError(`NetSuite returned "${value}" as the ${what}, which is not a number`);
};

const toAllowance = (row) => {
	const entitlement = amountOf(row.entitlement, `entitlement of allowance ${row.id}`);
	if (entitlement === null) throw new NetsuiteError(`Annual leave allowance ${row.id} has no entitlement`);
	return {
		id: String(row.id),
		start: row.periodstart,
		end: row.periodend,
		contractual: amountOf(row.contractual, `contractual days of allowance ${row.id}`) ?? 0,
		carriedForward: amountOf(row.carriedforward, `carried forward days of allowance ${row.id}`) ?? 0,
		entitlement,
	};
};

const toAdjustment = (row) => ({
	type: row.type,
	days: amountOf(row.days, `days of adjustment ${row.id}`) ?? 0,
	inHours: row.inhours === "T",
	effectiveFrom: row.effectivefrom ?? null,
	effectiveUntil: row.effectiveuntil ?? null,
});

const toLeave = (absence) => ({
	id: absence.id,
	typeId: absence.typeId,
	statusId: absence.statusId,
	startDate: absence.startDate,
	endDate: absence.endDate,
	days: amountOf(absence.days, `days of absence ${absence.id}`) ?? 0,
	hours: amountOf(absence.hours, `hours of absence ${absence.id}`) ?? 0,
});

const round = (value) => Math.round(value * 100) / 100;

const allowanceOf = (allowances, year) => {
	const matching = allowances.filter((allowance) => allowance.start.startsWith(`${year}-`));
	if (matching.length === 1) return matching[0];
	if (matching.length > 1) {
		const ids = matching.map((allowance) => allowance.id).join(", ");
		throw new NetsuiteError(`NetSuite has several annual leave allowances starting in ${year} (${ids})`);
	}
	const known = [...new Set(allowances.map((allowance) => allowance.start.slice(0, 4)))].sort();
	throw new UsageError(
		`NetSuite has no annual leave allowance starting in ${year}; allowances exist for ${known.join(", ") || "no year"}`,
	);
};

export const computeLeaveBalance = ({ year, allowances, adjustments, absences }) => {
	const allowance = allowanceOf(allowances, year);
	const overlaps = (start, end) =>
		(start === null || start <= allowance.end) && (end === null || end >= allowance.start);
	const leave = absences.filter(
		(absence) =>
			absence.typeId === ANNUAL_LEAVE_TYPE &&
			(BOOKED.has(absence.statusId) || PENDING.has(absence.statusId)) &&
			overlaps(absence.startDate, absence.endDate),
	);
	const daysIn = (statuses) =>
		round(
			leave
				.filter((absence) => statuses.has(absence.statusId))
				.reduce((sum, absence) => sum + absence.hours / HOURS_PER_DAY, 0),
		);
	const booked = daysIn(BOOKED);
	const pending = daysIn(PENDING);
	return {
		year,
		periodStart: allowance.start,
		periodEnd: allowance.end,
		contractual: allowance.contractual,
		carriedForward: allowance.carriedForward,
		entitlement: allowance.entitlement,
		booked,
		pending,
		remaining: round(allowance.entitlement - booked - pending),
		unrecorded: leave
			.filter((absence) => absence.hours <= 0)
			.map(({ id, startDate, endDate, days }) => ({ id, startDate, endDate, days })),
		adjustments: adjustments
			.filter((adjustment) => !adjustment.inHours && overlaps(adjustment.effectiveFrom, adjustment.effectiveUntil))
			.map(({ type, days, effectiveFrom, effectiveUntil }) => ({ type, days, effectiveFrom, effectiveUntil })),
	};
};

export const fetchLeaveBalance = async (client, { year }) => {
	const employeeId = await currentEmployeeId(client);
	const [allowances, adjustments, absences] = await Promise.all([
		client.suiteql(ALLOWANCE_QUERY(employeeId)),
		client.suiteql(ADJUSTMENT_QUERY(employeeId)),
		employeeAbsences(client, employeeId),
	]);
	return computeLeaveBalance({
		year,
		allowances: allowances.map(toAllowance),
		adjustments: adjustments.map(toAdjustment),
		absences: absences.map(toLeave),
	});
};
