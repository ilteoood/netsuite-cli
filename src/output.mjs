export const formatTable = (rows, columns) => {
	const cells = rows.map((row) => columns.map(({ value }) => String(value(row) ?? "")));
	const widths = columns.map(({ header }, index) => Math.max(header.length, ...cells.map((row) => row[index].length)));
	const line = (row) =>
		row
			.map((cell, index) => cell.padEnd(widths[index]))
			.join("  ")
			.trimEnd();
	return [columns.map(({ header }) => header), ...cells].map(line).join("\n");
};

export const formatJson = (value) => JSON.stringify(value, null, 2);
