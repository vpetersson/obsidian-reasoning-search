/**
 * Bump the version everywhere Obsidian looks for it, build, and zip the release files.
 *
 *   bun run release            # patch bump
 *   bun run release minor      # or major, or an explicit 1.2.3
 *
 * Writes release/reasoning-search-<version>.zip containing main.js, manifest.json and styles.css.
 * Commit, tag (`git tag <version>`, no "v" prefix, as Obsidian expects) and attach the three
 * files to a GitHub release yourself.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { $ } from "bun";

const bump = Bun.argv[2] ?? "patch";

/** Minimal uncompressed (stored) zip writer, so releasing doesn't depend on a `zip` binary. */
export function storedZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = Bun.hash.crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function nextVersion(current: string, how: string): string {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major = 0, minor = 0, patch = 0] = current.split(".").map(Number);
  if (how === "major") return `${major + 1}.0.0`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  if (how === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump "${how}": use patch, minor, major or x.y.z`);
}

const manifest = await readJson<{ id: string; version: string; minAppVersion: string }>("manifest.json");
const pkg = await readJson<{ version: string }>("package.json");
const versions = await readJson<Record<string, string>>("versions.json");

const version = nextVersion(manifest.version, bump);
manifest.version = version;
pkg.version = version;
versions[version] = manifest.minAppVersion;

await writeJson("manifest.json", manifest);
await writeJson("package.json", pkg);
await writeJson("versions.json", versions);

await $`bun test`;
await $`bun run build`;
await mkdir("release", { recursive: true });
const zip = `release/${manifest.id}-${version}.zip`;
const files = ["main.js", "manifest.json", "styles.css"];
await writeFile(zip, storedZip(await Promise.all(files.map(async (name) => ({ name, data: new Uint8Array(await readFile(name)) })))));
console.log(`\nReleased ${version} -> ${zip}`);
