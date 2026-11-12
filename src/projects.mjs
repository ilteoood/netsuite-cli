import { NetsuiteError, UsageError } from "./errors.mjs";

const PROJECTS_FIELD = "custpage_filtered_projects";
const TIMESHEET_PAGE = "/app/accounting/transactions/time/weeklytimebill.nl";
const TASKS_SUITELET = "/app/site/hosting/scriptlet.nl?script=1394&deploy=1";

const choice = (id, name) => ({ id: String(id), name: String(name) });

const decodeOptions = (html, fieldId) => {
	const fieldAt = html.indexOf(`${fieldId}\\":{\\"name\\"`);
	if (fieldAt < 0) return null;
	const optionsAt = html.indexOf('supplementedOptions\\":[', fieldAt);
	if (optionsAt < 0) return null;
	const endAt = html.indexOf('],\\"hasBlankString', optionsAt);
	if (endAt < 0) return null;
	const options = html.slice(optionsAt + 'supplementedOptions\\":'.length, endAt + 1).replaceAll('\\"', '"');
	try {
		return JSON.parse(options);
	} catch {
		throw new NetsuiteError("NetSuite answered with a timesheet page whose project list this CLI cannot read.");
	}
};

const parseTasks = (body) => {
	try {
		return JSON.parse(body);
	} catch {
		throw new NetsuiteError("NetSuite answered with a task list this CLI cannot read.");
	}
};

const normalize = (value) =>
	String(value ?? "")
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase();

const quoted = (project) => `"${project.name}" (id ${project.id})`;

const commonSubstring = (left, right) => {
	let longest = 0;
	for (let start = 0; start < left.length; start += 1) {
		for (let end = start + longest + 1; end <= left.length; end += 1) {
			if (!right.includes(left.slice(start, end))) break;
			longest = end - start;
		}
	}
	return longest;
};

const closestChoices = (choices, query) =>
	choices
		.map((project) => ({ project, score: commonSubstring(query, normalize(project.name)) }))
		.sort((left, right) => right.score - left.score)
		.slice(0, 3)
		.map(({ project }) => project);

export const readWeekHeader = async (client, weekStart) => {
	const [timesheet] = await client.suiteql(
		`SELECT id, employee, custrecord_timesheetsubmitted FROM timesheet WHERE startdate = TO_DATE('${weekStart}', 'YYYY-MM-DD')`,
	);
	if (!timesheet) {
		throw new UsageError(
			`No timesheet exists for the week starting ${weekStart}. NetSuite pre-creates every week, so ${weekStart} is probably not a Monday.`,
		);
	}
	return {
		timesheetId: String(timesheet.id),
		employeeId: String(timesheet.employee),
		alreadySubmitted: timesheet.custrecord_timesheetsubmitted === "T",
	};
};

export const fetchProjectChoices = async (client, weekStart, header = null) => {
	const { timesheetId, employeeId } = header ?? (await readWeekHeader(client, weekStart));
	const html = await client.text(`${TIMESHEET_PAGE}?id=${timesheetId}&whence=&e=T`);
	const projects = decodeOptions(html, PROJECTS_FIELD)?.map((project) => choice(project.id, project.text)) ?? null;
	if (!projects) {
		throw new NetsuiteError(
			"The NetSuite session has expired: the timesheet page returned the login page instead of its project list. Sign in again and retry.",
		);
	}
	if (projects.length === 0) {
		throw new UsageError(`The timesheet page for the week starting ${weekStart} offers no projects for this employee.`);
	}
	return { timesheetId, employeeId, projects };
};

export const fetchTasks = async (client, { weekStart, employeeId }) => {
	const body = await client.text(
		`${TASKS_SUITELET}&compid=${client.account}&trandate=${weekStart}&employeeId=${employeeId}&projectId=`,
	);
	return parseTasks(body).flatMap((group) =>
		group.tasks.map((task) => ({ ...choice(task.id, task.name), projectId: String(group.id) })),
	);
};

export const resolveChoice = (choices, requested, what) => {
	const query = normalize(requested);
	const matches = choices.filter((candidate) => normalize(candidate.name).includes(query));
	if (matches.length === 1) return choice(matches[0].id, matches[0].name);
	if (matches.length > 1) {
		throw new UsageError(
			`"${requested}" matches several ${what}s: ${matches.map(quoted).join(", ")}. Use a more specific name.`,
		);
	}
	const closest = closestChoices(choices, query);
	throw new UsageError(
		`No ${what} matches "${requested}".${closest.length ? ` Closest: ${closest.map(quoted).join(", ")}.` : ""}`,
	);
};
