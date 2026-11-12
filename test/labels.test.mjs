import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageError } from "../src/errors.mjs";
import { ACTIVITY_ITEMS, APPROVAL_STATUSES, LEAVE_TYPES, labelOf, resolveLeaveType } from "../src/labels.mjs";

test("labelOf reads the table and falls back to the raw id", () => {
	assert.deepStrictEqual(
		{
			leaveType: labelOf(LEAVE_TYPES, "84"),
			approvalStatus: labelOf(APPROVAL_STATUSES, 5),
			activityItem: labelOf(ACTIVITY_ITEMS, "71"),
			unknownLeaveType: labelOf(LEAVE_TYPES, "999"),
			unknownApprovalStatus: labelOf(APPROVAL_STATUSES, 9),
		},
		{
			leaveType: "Annual Leave",
			approvalStatus: "Cancelled",
			activityItem: "Solution Delivery",
			unknownLeaveType: "999",
			unknownApprovalStatus: "9",
		},
	);
});

test("the label tables hold the account's own enums", () => {
	assert.deepStrictEqual(
		{ leaveTypes: LEAVE_TYPES, approvalStatuses: APPROVAL_STATUSES, activityItems: ACTIVITY_ITEMS },
		{
			leaveTypes: {
				84: "Annual Leave",
				85: "Bank Holiday",
				102: "Training",
				242: "Event Leave",
				252: "Other Leave",
			},
			approvalStatuses: {
				1: "Approved",
				2: "Approval Requested",
				3: "Rejected",
				4: "Cancel Requested",
				5: "Cancelled",
				6: "Request Incomplete",
			},
			activityItems: { 71: "Solution Delivery" },
		},
	);
});

test("resolveLeaveType matches a label case-insensitively by substring", () => {
	assert.deepStrictEqual(
		[resolveLeaveType("annual"), resolveLeaveType("  BANK  "), resolveLeaveType("other")],
		[
			{ id: "84", name: "Annual Leave" },
			{ id: "85", name: "Bank Holiday" },
			{ id: "252", name: "Other Leave" },
		],
	);
});

test("resolveLeaveType refuses an ambiguous name and lists the candidates", () => {
	assert.throws(
		() => resolveLeaveType("leave"),
		(error) =>
			error instanceof UsageError &&
			error.message.includes("84 Annual Leave") &&
			error.message.includes("242 Event Leave"),
	);
});

test("resolveLeaveType refuses an unknown name and lists what is available", () => {
	assert.throws(
		() => resolveLeaveType("sabbatical"),
		(error) =>
			error instanceof UsageError && error.message.includes("available") && error.message.includes("252 Other Leave"),
	);
});

test("resolveLeaveType refuses an empty name instead of matching everything", () => {
	assert.throws(
		() => resolveLeaveType(""),
		(error) => error instanceof UsageError && error.message.includes("available"),
	);
});
