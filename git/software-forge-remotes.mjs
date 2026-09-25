/**
 * @fileoverview software-forge-remotes.mjs — parse and normalize software-forge
 * git remotes (the work machine's Visual Builder Studio tenant). The home
 * reference farm (`non-bare-issues.md`) is GitHub-shaped, so `git-lib.mjs`
 * can key it by host; the work farm is one private software forge that
 * exposes the SAME repository through three different URLs, none of which is
 * a plain `host/owner/repo` path:
 *
 *   ssh    ssh://idcs-<id>.<email>@<host>/<projectId>/<repo>.git
 *   https  https://<email>@<host>/<org>/s/<projectId>/scm/<repo>.git
 *   glass  https://<host>/<org>/#projects/<projectSlug>/scm/<repo>.git/tree
 *
 * All three carry one identity — `org / project / repo` — and that identity is
 * what the mirror layout and maintenance need. This module is that decoder:
 * `parseSoftwareForgeRemote()` (any shape → one struct) and the three rebuilders. It is
 * pure (no I/O), so it is also the unit the audit uses to show a human the
 * glass-pane link for a mirror (docs/d044).
 *
 * `projectId` and `projectSlug` differ: the id is
 * `<org>_<slug>_<numeric>` (`fabrikam-contoso-fabrikam-contoso-cicd_7008`) while the
 * slug is the human segment the glass UI uses (`grupo-nos-cd`). The ssh form
 * only carries the id, so the slug is recovered from it; the glass form only
 * carries the slug, so the id stays null there.
 */

/** Hosts under this suffix are software-forge hosts; the leading label is the org. */
const SOFTWARE_FORGE_HOST_SUFFIX = ".developer.ocp.oraclecloud.com";

/**
 * One software-forge repository identity, however it was spelled.
 * @typedef {object} SoftwareForgeRemote
 * @property {"ssh"|"https"|"glass"} kind  which URL shape was parsed
 * @property {string} host                 e.g. fabrikam-contoso.developer.ocp.oraclecloud.com
 * @property {string} org                  e.g. fabrikam-contoso
 * @property {string|null} projectId       e.g. fabrikam-contoso_fabrikam-contoso-cicd_7008
 * @property {string|null} projectSlug     e.g. fabrikam-contoso-cicd
 * @property {string} repo                 e.g. we_connect_app (no `.git`)
 * @property {string|null} user            decoded URL user (email, or `idcs-<id>.<email>` on ssh)
 */

/**
 * @param {string} value
 * @returns {string}
 */
function stripGitSuffix(value) {
	return value ? value.replace(/\.git$/, "") : "";
}

/**
 * The ssh URL embeds the IDCS identity as `idcs-<hex>.<email>`; the email is
 * the part a credential helper or https URL actually uses.
 * @param {SoftwareForgeRemote} remote
 * @returns {string|null}
 */
export function softwareForgeUserEmail(remote) {
	if (!remote.user) return null;
	return remote.user.replace(/^idcs-[0-9a-f]+\./i, "");
}

/**
 * Recover the glass slug from `<org>_<slug>_<numeric>`. The numeric id is what
 * makes a projectId unique on the tenant; the slug is the stable name.
 * @param {string} projectId
 * @param {string} org
 * @returns {string|null}
 */
function slugFromProjectId(projectId, org) {
	const prefix = `${org}_`;
	if (!projectId.startsWith(prefix)) return null;
	const rest = projectId.slice(prefix.length);
	const match = /^(.*)_\d+$/.exec(rest);
	return match ? match[1] : rest;
}

/**
 * The org is the leading label of the host, e.g.
 * `fabrikam-contoso` from `fabrikam-contoso.developer.ocp…`.
 * @param {string} host lowercase hostname
 * @returns {string|null}
 */
function orgFromHost(host) {
	if (!host.endsWith(SOFTWARE_FORGE_HOST_SUFFIX)) return null;
	const org = host.slice(0, -SOFTWARE_FORGE_HOST_SUFFIX.length);
	return org || null;
}

/**
 * Decode any of the three software-forge URL shapes into one identity.
 * Returns null for a URL that is not a software-forge repo, so callers can
 * fall through to the forge-agnostic path (`-forge-mirror.sh`, `audit.mjs`).
 * @param {string|null|undefined} raw
 * @returns {SoftwareForgeRemote|null}
 */
export function parseSoftwareForgeRemote(raw) {
	if (!raw) return null;
	/** @type {URL} */
	let url;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	if (!orgFromHost(host)) return null;

	const user = url.username ? decodeURIComponent(url.username) : null;
	const segments = url.pathname.split("/").filter(Boolean);

	// Glass pane: the repo identity lives in the fragment, not the path.
	if (url.hash) {
		const fragment = url.hash.replace(/^#/, "").split("?")[0];
		const parts = fragment.split("/").filter(Boolean);
		if (parts[0] === "projects" && parts[2] === "scm") {
			const projectSlug = parts[1];
			const repo = stripGitSuffix(parts[3]);
			const org = segments[0] || orgFromHost(host);
			if (projectSlug && repo && org) {
				return {
					kind: "glass",
					host,
					org,
					projectId: null,
					projectSlug,
					repo,
					user,
				};
			}
		}
	}

	// https: /<org>/s/<projectId>/scm/<repo>.git
	if (segments[1] === "s" && segments[3] === "scm") {
		const org = segments[0];
		const projectId = segments[2];
		const repo = stripGitSuffix(segments[4]);
		if (org && projectId && repo) {
			return {
				kind: "https",
				host,
				org,
				projectId,
				projectSlug: slugFromProjectId(projectId, org),
				repo,
				user,
			};
		}
	}

	// ssh: /<projectId>/<repo>.git
	if (url.protocol === "ssh:" && segments.length === 2) {
		const projectId = segments[0];
		const repo = stripGitSuffix(segments[1]);
		const org = orgFromHost(host);
		if (projectId && repo && org) {
			return {
				kind: "ssh",
				host,
				org,
				projectId,
				projectSlug: slugFromProjectId(projectId, org),
				repo,
				user,
			};
		}
	}

	return null;
}

/**
 * Rebuild the https fetch URL. This is the form that survives an IDCS ssh
 * identity rotation when a credential helper supplies the token, and the form
 * a human can paste into a browser after stripping the userinfo.
 * @param {SoftwareForgeRemote} remote
 * @param {string|null} [user] overrides the parsed user (email form)
 * @returns {string|null} null when the project id is unknown (a glass-only parse)
 */
export function softwareForgeHttpsUrl(remote, user) {
	if (!remote.projectId) return null;
	const who = user ?? softwareForgeUserEmail(remote);
	const auth = who ? `${encodeURIComponent(who)}@` : "";
	return `https://${auth}${remote.host}/${remote.org}/s/${remote.projectId}/scm/${remote.repo}.git`;
}

/**
 * Rebuild the ssh fetch URL (the shape the forge's own tooling and the work
 * clones use).
 * @param {SoftwareForgeRemote} remote
 * @param {string|null} [user] overrides the parsed user (raw `idcs-…` form)
 * @returns {string|null}
 */
export function softwareForgeSshUrl(remote, user) {
	if (!remote.projectId) return null;
	const who = user ?? remote.user;
	const auth = who ? `${encodeURIComponent(who)}@` : "";
	return `ssh://${auth}${remote.host}/${remote.projectId}/${remote.repo}.git`;
}

/**
 * The browser link a human opens to see the repo, e.g. for a code review
 * pointer in a report.
 * @param {SoftwareForgeRemote} remote
 * @param {string} [revision]
 * @returns {string|null} null when the glass-only slug is unknown
 */
export function softwareForgeGlassUrl(remote, revision = "main") {
	if (!remote.projectSlug) return null;
	const rev = revision ? `?revision=${encodeURIComponent(revision)}` : "";
	return `https://${remote.host}/${remote.org}/#projects/${remote.projectSlug}/scm/${remote.repo}.git/tree${rev}`;
}

/**
 * The mirror-relative path for a software-forge remote:
 * `<org>/<projectSlug>/<repo>.git`,
 * falling back to the numeric project id when only the ssh form was seen. This
 * is the work-farm analogue of the host-keyed layout `-forge-mirror.sh` builds.
 * @param {SoftwareForgeRemote} remote
 * @returns {string}
 */
export function softwareForgeMirrorRelPath(remote) {
	const project = remote.projectSlug ?? remote.projectId ?? "unknown";
	return `${remote.org}/${project}/${remote.repo}.git`;
}
