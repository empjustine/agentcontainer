/**
 * @fileoverview Enumerates the two living-off-the-land corpora the closed tool
 * surface has to answer for — GTFOBins and LOLBAS — and projects them onto the
 * tool names such a surface would expose (docs/d194).
 *
 * WHY the corpora are read instead of trusted: the denylist is not the policy.
 * GTFOBins annotates each capability with the context that reaches it
 * (unprivileged, sudo, SUID, capabilities), and LOLBAS documents only
 * UNINTENDED functionality, so both are evidence about which FEATURE is
 * dangerous — not about which tool is. The projection below is what turns that
 * evidence into the two questions this framework asks per command: which
 * functions does the unprivileged context reach, and which of them does the
 * curated surface deliberately not expose.
 *
 * WHY the farm is the input: the corpora are bare mirrors under
 * ~/Downloads/references/github.com, and the projection is only as current as
 * the tip it read. The committed outputs carry those tips and --check fails on
 * a moved corpus, so a stale projection is a loud finding rather than a quietly
 * aged table.
 *
 * USAGE: ./node-run.sh codemode2/enumerate.mjs [--farm DIR] [--check]
 *   writes codemode2/taxonomy.json + codemode2/attack-corpus.json;
 *   --check compares them to disk and exits 1 on drift.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAXONOMY = join(HERE, "taxonomy.json");
const ATTACKS = join(HERE, "attack-corpus.json");
const SURFACE = join(HERE, "surface.json");

/** Where the bare mirrors live on a dev host (docs/d043). */
const DEFAULT_FARM = join(homedir(), "Downloads", "references", "github.com");

/** The two corpora, named by their path under the farm. */
const CORPORA = {
	gtfobins: { gitDir: ["GTFOBins", "GTFOBins.github.io.git"], entries: "_gtfobins/" },
	lolbas: { gitDir: ["LOLBAS-Project", "LOLBAS.git"], entries: "yml/" },
};

/**
 * The POSIX/Unix tool names a coding workflow reaches for — POSIX utilities,
 * coreutils, util-linux, diffutils, findutils, the compression families and the
 * few non-POSIX tools a harness's base inventory assumes (d150).
 * @type {readonly string[]}
 */
const POSIX_CANDIDATES = [
	"arch", "b2sum", "base32", "base64", "basename", "basenc", "cat", "chcon", "chgrp", "chmod",
	"chown", "cksum", "comm", "cp", "csplit", "cut", "date", "dd", "df", "dircolors", "dirname",
	"du", "echo", "env", "expand", "expr", "factor", "false", "fmt", "fold", "head", "hostname",
	"id", "install", "join", "link", "ln", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp",
	"mv", "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste", "pathchk", "pr", "printenv",
	"printf", "ptx", "pwd", "readlink", "realpath", "rm", "rmdir", "seq", "sha1sum", "sha256sum",
	"shred", "shuf", "sleep", "sort", "split", "stat", "stdbuf", "stty", "sum", "sync", "tac",
	"tail", "tee", "test", "timeout", "touch", "tr", "true", "truncate", "tsort", "tty", "uname",
	"unexpand", "uniq", "unlink", "users", "wc", "who", "whoami", "yes",
	"blkid", "blockdev", "cal", "chcpu", "chfn", "chrt", "chsh", "col", "colcrt", "colrm",
	"column", "dmesg", "eject", "fallocate", "flock", "fsck", "getopt", "hexdump", "hwclock",
	"ionice", "ipcs", "kill", "logger", "login", "look", "losetup", "lsblk", "lscpu", "lsipc",
	"lslocks", "lsns", "mesg", "mkfs", "mount", "mountpoint", "namei", "nologin", "nsenter",
	"partx", "pivot_root", "prlimit", "rename", "renice", "rev", "rfkill", "rtcwake", "script",
	"scriptreplay", "setarch", "setsid", "setterm", "su", "sulogin", "swapon", "switch_root",
	"taskset", "ul", "umount", "unshare", "utmpdump", "uuidgen", "wall", "wdctl", "whereis",
	"wipefs", "write",
	"cmp", "diff", "diff3", "sdiff", "find", "xargs", "locate", "grep", "egrep", "fgrep", "sed",
	"awk", "gawk", "mawk", "iconv", "nroff", "troff",
	"gzip", "gunzip", "zcat", "bzip2", "bunzip2", "xz", "unxz", "tar", "cpio", "pax", "zip",
	"unzip", "7z",
	"curl", "wget", "openssl", "ssh", "scp", "sftp", "rsync", "nc", "socat", "telnet", "ftp",
	"tftp", "python3", "perl", "node", "git", "make", "gcc", "jq", "sqlite3", "busybox", "vim",
	"nano", "less", "more", "man", "strings", "file", "patch", "ldd", "nm", "objdump", "readelf",
	"ssh-keygen", "sshfs", "expect", "tmux", "screen", "watch",
];

/**
 * The Windows binaries a tool surface would be asked for — the cmdlets and
 * cmd.exe built-ins of a coding workflow, plus the script hosts and transfer
 * utilities LOLBAS carries.
 * @type {readonly string[]}
 */
const WINDOWS_CANDIDATES = [
	"type", "more", "dir", "copy", "move", "del", "ren", "md", "rd", "sort", "fc", "tree", "attrib",
	"echo", "cmd", "powershell", "pwsh", "reg", "regedit", "sc", "net", "net1", "netsh", "at",
	"schtasks", "wmic", "certutil", "bitsadmin", "mshta", "rundll32", "regsvr32", "regasm",
	"regsvcs", "cscript", "wscript", "msiexec", "installutil", "odbcconf", "forfiles", "where",
	"findstr", "expand", "extrac32", "makecab", "replace", "robocopy", "xcopy", "tar", "curl",
	"ssh", "scp", "sftp", "ftp", "tftp", "pktmon", "psr", "print", "fsutil", "diskshadow",
	"vssadmin", "wbadmin", "bcdedit", "cipher", "icacls", "takeown", "nltest", "openfiles",
	"query", "rasdial", "route", "runas", "setspn", "subst", "sxstrace", "systeminfo",
	"taskkill", "tasklist", "telnet", "typeperf", "vbc", "verifier", "vol", "wecutil",
	"wevtutil", "wlrmdr", "wsl", "bash", "conhost", "control", "mmc", "msbuild", "csc", "jsc",
	"aspnet_compiler", "cdb", "windbg", "dump64", "procdump", "comsvcs", "esentutl", "ldifde",
	"mavinject", "pcalua", "odbcad32", "computerdefaults", "eventvwr", "wsreset", "sdclt",
	"fodhelper",
];

/** GTFOBins functions that hand over arbitrary execution. @type {readonly string[]} */
const EXEC_FUNCTIONS = [
	"shell",
	"command",
	"inherit",
	"reverse-shell",
	"bind-shell",
	"library-load",
];

/** GTFOBins functions that move data off or onto the machine. @type {readonly string[]} */
const TRANSFER_FUNCTIONS = ["upload", "download"];

/** LOLBAS categories that reach code execution. @type {readonly string[]} */
const LOLBAS_EXEC_CATEGORIES = ["Execute", "AWL Bypass", "Compile", "UAC Bypass"];

/** GTFOBins function to the surface grant that exposes it. @type {Record<string, string>} */
const FUNCTION_GRANT = { "file-read": "fs.read", "file-write": "fs.write" };

/**
 * @typedef {{ code: string, contexts: string[] }} Example
 * @typedef {{ examples: Example[], contexts: Set<string> }} GtfobinsFunction
 * @typedef {{ alias: string | null, functions: Map<string, GtfobinsFunction> }} GtfobinsEntry
 */

/**
 * @param {string} gitDir
 * @param {string[]} args
 * @returns {string}
 */
function gitText(gitDir, args) {
	return execFileSync("git", ["--git-dir", gitDir, ...args], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
}

/**
 * Reads every blob under a prefix in one repository in two git calls.
 * @param {string} gitDir
 * @param {string} prefix
 * @returns {{ tip: string, files: Map<string, string> }}
 */
function readRepoTree(gitDir, prefix) {
	const tip = gitText(gitDir, ["rev-parse", "HEAD"]).trim();
	const listing = gitText(gitDir, ["ls-tree", "-r", "-z", "HEAD", prefix]);
	/** @type {string[]} */
	const paths = [];
	/** @type {string[]} */
	const shas = [];
	for (const record of listing.split("\0")) {
		if (record === "") { continue; }
		const tab = record.indexOf("\t");
		const meta = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		const sha = meta[2];
		if (sha === undefined) { throw new Error(`unreadable ls-tree record: ${record}`); }
		paths.push(path);
		shas.push(sha);
	}
	const batch = execFileSync("git", ["--git-dir", gitDir, "cat-file", "--batch"], {
		input: `${shas.join("\n")}\n`,
		maxBuffer: 512 * 1024 * 1024,
	});
	/** @type {Map<string, string>} */
	const files = new Map();
	let offset = 0;
	for (const path of paths) {
		const newline = batch.indexOf(0x0a, offset);
		const header = batch.subarray(offset, newline).toString("utf8");
		const match = /^[0-9a-f]+ \w+ (\d+)$/.exec(header);
		const size = match?.[1];
		if (size === undefined) { throw new Error(`unreadable cat-file header: ${header}`); }
		const start = newline + 1;
		const end = start + Number(size);
		files.set(path, batch.subarray(start, end).toString("utf8"));
		offset = end + 1;
	}
	return { tip, files };
}

/**
 * Reads one GTFOBins entry: an optional alias, and the functions its examples
 * reach. A function with no contexts block is unprivileged by the site's own
 * default (_data/contexts.yml lists unprivileged first, docs/d194).
 * @param {string} source
 * @returns {GtfobinsEntry}
 */
export function parseGtfobins(source) {
	const lines = source.split("\n");
	const open = lines.indexOf("---");
	const close = lines.indexOf("...", open + 1);
	if (open === -1 || close === -1) { throw new Error("no frontmatter delimited by --- and ..."); }
	/** @type {string | null} */
	let alias = null;
	/** @type {Map<string, GtfobinsFunction>} */
	const functions = new Map();
	/** @type {GtfobinsFunction | null} */
	let current = null;
	let inFunctions = false;
	let inContexts = false;
	/** @type {Example | null} */
	let inCode = null;
	for (const line of lines.slice(open + 1, close)) {
		const body = /^ {6}(.*)$/.exec(line)?.[1];
		if (inCode !== null && body !== undefined) {
			inCode.code += (inCode.code === "" ? "" : "\n") + body;
			continue;
		}
		inCode = null;
		const aliasMatch = /^alias:\s*(\S+)$/.exec(line);
		if (aliasMatch?.[1] !== undefined) {
			alias = aliasMatch[1];
			continue;
		}
		if (/^functions:\s*$/.test(line)) {
			inFunctions = true;
			continue;
		}
		if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(line)) {
			inFunctions = false;
			current = null;
			continue;
		}
		if (!inFunctions) { continue; }
		const name = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line)?.[1];
		if (name !== undefined) {
			current = { examples: [], contexts: new Set() };
			functions.set(name, current);
			inContexts = false;
			continue;
		}
		if (current === null) { continue; }
		if (inContexts) {
			const context = /^ {6}([a-z][a-z0-9-]*):/.exec(line)?.[1];
			if (context !== undefined) {
				current.contexts.add(context);
				continue;
			}
			// A context may carry an extra field of its own (SUID's shell: true),
			// indented one level deeper than the context key itself.
			if (/^ {7,}\S/.test(line)) { continue; }
			inContexts = false;
		}
		if (/^ {4}contexts:\s*$/.test(line)) {
			inContexts = true;
			continue;
		}
		if (/^ {2}- code: \|-$/.test(line)) {
			inCode = { code: "", contexts: [...current.contexts] };
			current.examples.push(inCode);
			continue;
		}
		const inline = /^ {2}- code: (.+)$/.exec(line)?.[1];
		if (inline !== undefined) {
			current.examples.push({ code: inline, contexts: [...current.contexts] });
		}
	}
	return { alias, functions };
}

/**
 * The functions an unprivileged process reaches.
 * @param {GtfobinsEntry} entry
 * @returns {string[]}
 */
export function unprivilegedFunctions(entry) {
	/** @type {string[]} */
	const out = [];
	for (const [name, fn] of entry.functions) {
		if (fn.contexts.size === 0 || fn.contexts.has("unprivileged")) { out.push(name); }
	}
	return out.sort();
}

/**
 * @param {string} source
 * @returns {string[]}
 */
export function parseLolbas(source) {
	/** @type {Set<string>} */
	const categories = new Set();
	for (const match of source.matchAll(/^\s*-?\s*Category:\s*(.+?)\s*$/gm)) {
		const value = match[1];
		if (value !== undefined) { categories.add(value); }
	}
	return [...categories].sort();
}

/**
 * The class a corpus row puts a command in: what an unprivileged process
 * reaches, in descending order of severity. A command the corpus lists with no
 * unprivileged function is "privileged", not safe — the examples exist, and
 * they need sudo, SUID or capabilities to work.
 * @param {readonly string[]} functions
 * @returns {"shell" | "transfer" | "write" | "read" | "privileged"}
 */
export function posixClass(functions) {
	if (functions.length === 0) { return "privileged"; }
	if (functions.some((fn) => EXEC_FUNCTIONS.includes(fn))) { return "shell"; }
	if (functions.some((fn) => TRANSFER_FUNCTIONS.includes(fn))) { return "transfer"; }
	if (functions.includes("file-write")) { return "write"; }
	return "read";
}

/**
 * @param {readonly string[]} categories
 * @returns {"exec" | "transfer" | "other"}
 */
export function windowsClass(categories) {
	if (categories.some((category) => LOLBAS_EXEC_CATEGORIES.includes(category))) { return "exec"; }
	if (
		categories.some((category) =>
			["Download", "Upload", "Copy", "Decode", "Encode"].includes(category),
		)
	) {
		return "transfer";
	}
	return "other";
}

/**
 * @param {{ posix: string[], windows: string[] }} names
 * @param {Map<string, GtfobinsEntry>} gtfobins
 * @param {Map<string, string[]>} lolbas
 * @returns {{ posix: unknown[], windows: unknown[] }}
 */
function project(names, gtfobins, lolbas) {
	/** @type {Map<string, string>} */
	const aliases = new Map();
	for (const [name, entry] of gtfobins) {
		if (entry.alias !== null) { aliases.set(name, entry.alias); }
	}
	/** @type {unknown[]} */
	const posix = names.posix.map((name) => {
		const canonical = aliases.get(name) ?? name;
		const entry = gtfobins.get(canonical);
		const functions = entry === undefined ? [] : unprivilegedFunctions(entry);
		return {
			name,
			corpus: entry === undefined ? null : canonical,
			functions,
			class: entry === undefined ? "absent" : posixClass(functions),
		};
	});
	/** @type {unknown[]} */
	const windows = names.windows.map((name) => {
		const categories = lolbas.get(name.toLowerCase()) ?? [];
		return {
			name,
			corpus: categories.length === 0 ? null : name,
			categories,
			class: windowsClass(categories),
		};
	});
	return { posix, windows };
}

/**
 * @param {unknown[]} rows
 * @returns {Record<string, number>}
 */
function tally(rows) {
	/** @type {Record<string, number>} */
	const counts = {};
	for (const row of rows) {
		const key = /** @type {{ class: string }} */ (row).class;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

/**
 * The corpus's examples of the functions a command does NOT expose: each is a
 * probe the closed surface has to refuse, so the corpus doubles as the red-team
 * suite for the commands it lists.
 * @param {{ posix: Array<{ command: string, grants: string[] }> }} surface
 * @param {Map<string, GtfobinsEntry>} gtfobins
 * @returns {unknown[]}
 */
export function attacksFor(surface, gtfobins) {
	/** @type {unknown[]} */
	const out = [];
	for (const row of surface.posix) {
		const entry = gtfobins.get(row.command);
		if (entry === undefined) { continue; }
		const exposed = new Set(
			row.grants.flatMap((grant) => Object.keys(FUNCTION_GRANT).filter((fn) => FUNCTION_GRANT[fn] === grant)),
		);
		for (const [name, fn] of entry.functions) {
			if (exposed.has(name)) { continue; }
			for (const example of fn.examples) {
				out.push({ command: row.command, function: name, code: example.code });
			}
		}
	}
	return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/**
 * @param {string} farm
 * @returns {{ taxonomy: Record<string, unknown>, attacks: unknown[] }}
 */
function build(farm) {
	/** @type {Map<string, GtfobinsEntry>} */
	const gtfobins = new Map();
	/** @type {Map<string, string[]>} */
	const lolbas = new Map();
	const gtfoTree = readRepoTree(join(farm, ...CORPORA.gtfobins.gitDir), "_gtfobins");
	const lolTree = readRepoTree(join(farm, ...CORPORA.lolbas.gitDir), "yml");
	for (const [path, text] of gtfoTree.files) {
		gtfobins.set(path.slice("_gtfobins/".length), parseGtfobins(text));
	}
	for (const [path, text] of lolTree.files) {
		if (!path.endsWith(".yml")) { continue; }
		const name = path.slice(path.lastIndexOf("/") + 1, -".yml".length);
		lolbas.set(name.toLowerCase(), parseLolbas(text));
	}
	/** @type {Record<string, number>} */
	const lolbasCategories = {};
	for (const categories of lolbas.values()) {
		for (const category of categories) {
			lolbasCategories[category] = (lolbasCategories[category] ?? 0) + 1;
		}
	}
	/** @type {Record<string, { total: number, unprivileged: number }>} */
	const functions = {};
	for (const entry of gtfobins.values()) {
		for (const [name, fn] of entry.functions) {
			const row = functions[name] ?? { total: 0, unprivileged: 0 };
			row.total += 1;
			if (fn.contexts.size === 0 || fn.contexts.has("unprivileged")) { row.unprivileged += 1; }
			functions[name] = row;
		}
	}
	const projected = project(
		{ posix: [...POSIX_CANDIDATES], windows: [...WINDOWS_CANDIDATES] },
		gtfobins,
		lolbas,
	);
	const surface = /** @type {{ posix: Array<{ command: string, grants: string[] }> }} */ (
		JSON.parse(readFileSync(SURFACE, "utf8"))
	);
	const aliases = [...gtfobins.values()].filter((entry) => entry.alias !== null).length;
	const taxonomy = {
		generated: "codemode2/enumerate.mjs — docs/d194",
		sources: {
			gtfobins: {
				repo: "GTFOBins/GTFOBins.github.io.git",
				tip: gtfoTree.tip,
				files: gtfoTree.files.size,
				canonical: gtfoTree.files.size - aliases,
				aliases,
			},
			lolbas: {
				repo: "LOLBAS-Project/LOLBAS.git",
				tip: lolTree.tip,
				files: [...lolTree.files.keys()].filter((path) => path.endsWith(".yml")).length,
				names: lolbas.size,
				categories: lolbasCategories,
			},
		},
		functions: Object.fromEntries(
			Object.entries(functions).sort(([a], [b]) => a.localeCompare(b)),
		),
		classes: { posix: tally(projected.posix), windows: tally(projected.windows) },
		posix: projected.posix,
		windows: projected.windows,
	};
	return { taxonomy, attacks: attacksFor(surface, gtfobins) };
}

/**
 * @param {string} path
 * @param {unknown} value
 */
function writeCanonical(path, value) {
	// tmp + rename: a crash mid-write would otherwise leave a truncated committed
	// taxonomy that the next enumeration reads as its input (docs/d228 R8).
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	renameSync(tmp, path);
}

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function flagValue(name) {
	const argv = process.argv.slice(2);
	const index = argv.indexOf(name);
	if (index === -1) { return ; }
	const value = argv[index + 1];
	if (value === undefined) { throw new Error(`${name} needs a value`); }
	return value;
}

function main() {
	const farm = flagValue("--farm") ?? DEFAULT_FARM;
	const { taxonomy, attacks } = build(farm);
	if (process.argv.includes("--check")) {
		const stale = [
			[TAXONOMY, taxonomy],
			[ATTACKS, attacks],
		].filter(([path, value]) => readFileSync(/** @type {string} */ (path), "utf8") !== `${JSON.stringify(value, null, "\t")}\n`);
		if (stale.length > 0) {
			throw new Error(`the committed projection has drifted from the corpus at ${farm}`);
		}
		process.stdout.write("codemode2: projection matches the corpus\n");
		return;
	}
	writeCanonical(TAXONOMY, taxonomy);
	writeCanonical(ATTACKS, attacks);
	const sources = /** @type {{ gtfobins: { files: number }, lolbas: { files: number } }} */ (taxonomy.sources);
	const classes = /** @type {{ posix: Record<string, number>, windows: Record<string, number> }} */ (taxonomy.classes);
	process.stdout.write(
		"gtfobins " + String(sources.gtfobins.files) + " files, lolbas " + String(sources.lolbas.files) + " entries\n" +
			"posix candidates " + String(/** @type {unknown[]} */ (taxonomy.posix).length) + " -> " + JSON.stringify(classes.posix) + "\n" +
			"windows candidates " + String(/** @type {unknown[]} */ (taxonomy.windows).length) + " -> " + JSON.stringify(classes.windows) + "\n" +
			"attacks " + String(attacks.length) + " (corpus examples of functions the surface does not expose)\n",
	);
}

// The tests import the parsers, so the CLI runs only when this file is the
// entry point — otherwise a unit test would rewrite the committed projection
// and depend on the farm being present.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	main();
}
