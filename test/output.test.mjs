import assert from "node:assert/strict";
import test from "node:test";
import { formatJson, formatTable } from "../src/output.mjs";

const projectColumns = [
	{ header: "name", value: (project) => project.name },
	{ header: "id", value: (project) => project.id },
];

test("formatTable aligns the columns of ragged values with spaces", () => {
	const table = formatTable(
		[
			{ name: "Acme Platform", id: "1234" },
			{ name: "Internal Tools", id: "1240" },
		],
		projectColumns,
	);
	assert.equal(table, ["name            id", "Acme Platform   1234", "Internal Tools  1240"].join("\n"));
});

test("formatTable pads every line to the same width and leaves no trailing spaces", () => {
	const table = formatTable([{ name: "Acme Platform", id: "1234" }], projectColumns);
	for (const line of table.split("\n")) {
		assert.ok(!line.endsWith(" "), line);
	}
	assert.equal(table.split("\n")[1].length, "Acme Platform  1234".length);
});

test("formatTable prints a missing value as an empty cell", () => {
	assert.equal(formatTable([{ id: null }], projectColumns), "name  id\n");
});

test("formatTable prints the headers when there are no rows", () => {
	assert.equal(formatTable([], projectColumns), "name  id");
});

test("formatJson indents with two spaces", () => {
	assert.equal(formatJson({ id: "80004", days: 1 }), ["{", '  "id": "80004",', '  "days": 1', "}"].join("\n"));
});

test("formatJson prints an empty list as two brackets", () => {
	assert.equal(formatJson([]), "[]");
});
