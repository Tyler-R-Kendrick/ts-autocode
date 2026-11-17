import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";


const root = new URL("../../", import.meta.url);
const snapshotDirectory = fileURLToPath(new URL("test/snapshots/", root));
const markerDirectory = fileURLToPath(new URL("test/output/verified/", root));

export async function resetVerifiedMarkers() {
	await rm(markerDirectory, { recursive: true, force: true });
	await mkdir(markerDirectory, { recursive: true });
}

export async function orphanedSnapshots() {
	const approved = new Set(await approvedSnapshots());
	for (const marker of await readdir(markerDirectory).catch(() => [])) {
		const recorded = await readFile(join(markerDirectory, marker), "utf8").catch(() => undefined);
		if (recorded !== undefined) approved.delete(recorded);
	}
	const prefix = fileURLToPath(root);
	return [...approved].map((file) => file.startsWith(prefix) ? file.slice(prefix.length) : file).sort();
}

async function approvedSnapshots() {
	const entries = await readdir(snapshotDirectory, { recursive: true }).catch(() => []);
	return entries
		.filter((entry) => entry.includes(".verified."))
		.map((entry) => join(snapshotDirectory, entry));
}
