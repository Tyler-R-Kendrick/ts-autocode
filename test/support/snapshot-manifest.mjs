import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Orphan detection for the approved snapshots.
//
// `test/snapshots/**/*.verified.*` are reviewed artifacts, not generated ones:
// a diff in one is how a reviewer sees what a generator's output became. That
// only holds while every approved file is still compared against. Rename a
// subject and the old file stays behind, unread and indistinguishable from a
// current one -- which is worse than having no snapshot, because a reviewer
// reads it as current. Vitest tracks obsolete `.snap` blobs but not file
// snapshots, so `verify()` drops a marker per comparison and this reconciles
// the two.
//
// This runs from `test/run.mjs` rather than from a vitest `globalSetup`
// teardown, because a teardown that throws is logged and then ignored: the run
// still exits 0, which would make the whole check advisory.

const root = new URL("../../", import.meta.url);
const snapshotDirectory = fileURLToPath(new URL("test/snapshots/", root));
const markerDirectory = fileURLToPath(new URL("test/output/verified/", root));

/** Clears the markers from any previous run. */
export async function resetVerifiedMarkers() {
	await rm(markerDirectory, { recursive: true, force: true });
	await mkdir(markerDirectory, { recursive: true });
}

/** Approved snapshots no test compared against, relative to the repository. */
export async function orphanedSnapshots() {
	const approved = new Set(await approvedSnapshots());
	for (const marker of await readdir(markerDirectory).catch(() => [])) {
		// A marker that vanished between listing and reading tells us nothing;
		// reporting its snapshot as an orphan would be a false alarm, so skip it.
		const recorded = await readFile(join(markerDirectory, marker), "utf8").catch(() => undefined);
		if (recorded !== undefined) approved.delete(recorded);
	}
	const prefix = fileURLToPath(root);
	return [...approved].map((file) => file.startsWith(prefix) ? file.slice(prefix.length) : file).sort();
}

async function approvedSnapshots() {
	// Recursive string mode rather than `withFileTypes`: `Dirent.parentPath`
	// only arrived in Node 20.12, and `engines` declares Node 20.
	const entries = await readdir(snapshotDirectory, { recursive: true }).catch(() => []);
	return entries
		.filter((entry) => entry.includes(".verified."))
		.map((entry) => join(snapshotDirectory, entry));
}
