/**
 * @fileoverview check-node-version.mjs — Gate for pi-coding-agent's node floor: pi refuses
 * to run below 22.19, so failing here beats failing deep inside the launch. generate.sh
 * runs this on the Termux profile, where node is the system node; everywhere else node
 * comes from mise (pinned in ../mise.toml), so the floor is structural and this is never
 * called.
 *
 * Why 22.19 and not the generators' own floor: the generators only need
 * fetch/AbortSignal (>= 18), but pi itself enforces >= 22.19 in its engines,
 * and this script never uses --env-file, so the old ">= 20.6 for --env-file"
 * gate would let a 20/21-node host pass here and then fail inside pi.
 *
 * Usage: node check-node-version.mjs
 *   exit 0 = ok, 1 = too old (message on stderr)
 */

const [major, minor] = process.versions.node.split(".").map(Number);

if (!(major > 22 || (major === 22 && minor >= 19))) {
	process.stderr.write(
		`node ${process.versions.node} is too old (need >= 22.19 for pi-coding-agent)\n`,
	);
	process.exit(1);
}
