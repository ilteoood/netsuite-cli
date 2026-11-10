export class UsageError extends Error {
	name = "UsageError";
}

export class NetsuiteError extends Error {
	name = "NetsuiteError";

	constructor(message, { status = null, detail = null } = {}) {
		super(message);
		this.status = status;
		this.detail = detail;
	}
}
