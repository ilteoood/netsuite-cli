import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageError } from "../src/errors.mjs";
import { ACTIVITY_ITEMS, APPROVAL_STATUSES, LEAVE_TYPES, labelOf, resolveLeaveType } from "../src/labels.mjs";

test("labelOf reads the table and falls back to the raw id", () => {
	assert.equal(labelOf(LEAVE_TYPES, "84"), "Annual Leave");
	assert.equal(labelOf(APPROVAL_STATUSES, 5), "Cancelled");
	assert.equal(labelOf(ACTIVITY_ITEMS, "71"), "Solution Delivery");
	assert.equal(labelOf(LEAVE_TYPES, "999"), "999");
	assert.equal(labelOf(APPROVAL_STATUSES, 9), "9");
});

test("the label tables hold the account's own enums", () => {
	assert.deepEqual(LEAVE_TYPES, {
		84: "Annual Leave",
		85: "Bank Holiday",
		102: "Training",
		242: "Event Leave",
		252: "Other Leave",
	});
	assert.deepEqual(APPROVAL_STATUSES, {
		1: "Approved",
		2: "Approval Requested",
		3: "Rejected",
		4: "Cancel Requested",
		5: "Cancelled",
		6: "Request Incomplete",
	});
	assert.deepEqual(ACTIVITY_ITEMS, { 71: "Solution Delivery" });
});

test("resolveLeaveType matches a label case-insensitively by substring", () => {
	assert.deepEqual(resolveLeaveType("annual"), { id: "84", name: "Annual Leave" });
	assert.deepEqual(resolveLeaveType("  BANK  "), { id: "85", name: "Bank Holiday" });
	assert.deepEqual(resolveLeaveType("other"), { id: "252", name: "Other Leave" });
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
