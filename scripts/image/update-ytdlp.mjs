import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PYPI_YTDLP_URL = "https://pypi.org/pypi/yt-dlp/json";
const stableVersion = /^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/;
const sha256 = /^[a-f0-9]{64}$/;

function requireCheck(value, message) {
  if (!value) throw new Error(message);
}

function versionParts(version) {
  requireCheck(
    typeof version === "string" && stableVersion.test(version),
    "PyPI must report a stable yt-dlp release version"
  );
  const [year, month, day, patch = 0] = version.split(".").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  requireCheck(
    year >= 2000 &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day &&
      Number.isSafeInteger(patch),
    "PyPI must report a valid stable yt-dlp release version"
  );
  return [year, month, day, patch];
}

/** Resolve exact release hashes; pip still verifies every installed distribution. */
export function resolveLatestYtDlp(metadata) {
  requireCheck(
    metadata?.info?.name === "yt-dlp",
    "PyPI returned an unexpected package instead of yt-dlp"
  );
  const version = metadata.info.version;
  versionParts(version);
  requireCheck(
    Array.isArray(metadata.urls) && metadata.urls.length <= 100,
    "PyPI did not return valid yt-dlp release distributions"
  );
  const distributions = metadata.urls.filter((item) => item?.yanked === false);
  let hasWheel = false;
  const hashes = [];
  for (const distribution of distributions) {
    const { filename, packagetype, digests } = distribution;
    const prefix = `yt_dlp-${version}`;
    const wheel =
      packagetype === "bdist_wheel" &&
      typeof filename === "string" &&
      filename.startsWith(`${prefix}-`) &&
      /^[A-Za-z0-9_.+-]+\.whl$/.test(filename);
    const source =
      packagetype === "sdist" &&
      [
        `${prefix}.tar.gz`,
        `${prefix}.zip`,
        `yt-dlp-${version}.tar.gz`,
        `yt-dlp-${version}.zip`,
      ].includes(filename);
    let url;
    try {
      url = new URL(distribution.url);
    } catch {
      /* Invalid metadata is rejected below without printing response contents. */
    }
    requireCheck(
      (wheel || source) &&
        url?.protocol === "https:" &&
        url.hostname === "files.pythonhosted.org" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.startsWith("/packages/") &&
        url.pathname.endsWith(`/${filename}`) &&
        typeof digests?.sha256 === "string" &&
        sha256.test(digests.sha256),
      "PyPI returned invalid yt-dlp distribution identity or SHA-256 metadata"
    );
    hasWheel ||= wheel;
    hashes.push(digests.sha256);
  }
  requireCheck(
    hasWheel && hashes.length > 0,
    "The latest stable yt-dlp release has no non-yanked wheel"
  );
  return { version, hashes: [...new Set(hashes)].sort() };
}

/** Keep the complete runtime lock intact except for the exact yt-dlp release. */
export function refreshYtDlpLock(source, release) {
  const latest = versionParts(release?.version);
  requireCheck(
    Array.isArray(release.hashes) &&
      release.hashes.length > 0 &&
      release.hashes.every(
        (value) => typeof value === "string" && sha256.test(value)
      ),
    "A stable yt-dlp release with verified distribution hashes is required"
  );
  const blocks = [
    ...source.matchAll(
      /^yt-dlp\[default\]==([^\s\\]+)[ \t]*\\\r?\n(?:[ \t]+--hash=sha256:[a-f0-9]{64}[ \t]*\\?(?:\r?\n|$))+/gm
    ),
  ];
  requireCheck(
    blocks.length === 1 &&
      [...source.matchAll(/^yt-dlp(?:\[[^\]\r\n]+\])?==/gm)].length === 1 &&
      !blocks[0][0].trimEnd().endsWith("\\") &&
      !/^[ \t]+--hash=/.test(
        source.slice(blocks[0].index + blocks[0][0].length)
      ),
    "Expected one hash-locked yt-dlp[default] requirement"
  );
  const [block] = blocks;
  const current = versionParts(block[1]);
  const firstDifference = latest.findIndex(
    (value, index) => value !== current[index]
  );
  requireCheck(
    firstDifference === -1 ||
      latest[firstDifference] > current[firstDifference],
    "PyPI reports an older yt-dlp release; refusing to downgrade the runtime lock"
  );
  const comments = [
    ...source.matchAll(
      /^(# Direct applications: yt-dlp\[default\])([^;\s]+)(;[^\r\n]*)$/gm
    ),
  ];
  requireCheck(
    comments.length === 1 && comments[0][2] === block[1],
    "The direct-application yt-dlp version must match its locked requirement"
  );
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hashes = [...new Set(release.hashes)].sort();
  const replacement = [
    `yt-dlp[default]==${release.version} \\`,
    ...hashes.map(
      (hash, index) =>
        `    --hash=sha256:${hash}${index < hashes.length - 1 ? " \\" : ""}`
    ),
    "",
  ].join(newline);
  return source
    .replace(block[0], replacement)
    .replace(
      comments[0][0],
      `${comments[0][1]}${release.version}${comments[0][3]}`
    );
}

export async function updateYtDlpImage({
  root = fileURLToPath(new URL("../../", import.meta.url)),
  fetchMetadata = fetch,
} = {}) {
  let metadata;
  try {
    const response = await fetchMetadata(PYPI_YTDLP_URL, {
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(20_000),
    });
    requireCheck(
      response.ok,
      "Unable to check the latest yt-dlp release on PyPI"
    );
    metadata = await response.json();
  } catch {
    throw new Error(
      "Unable to check the latest yt-dlp release on PyPI; image preparation stopped"
    );
  }
  const release = resolveLatestYtDlp(metadata);
  const path = join(root, "deployments/image/requirements.txt");
  const info = await lstat(path);
  requireCheck(
    info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024,
    "The image runtime lock must be a regular file of at most 2 MiB"
  );
  const source = await readFile(path, "utf8");
  const updated = refreshYtDlpLock(source, release);
  if (source !== updated) {
    const temporary = join(dirname(path), `.requirements-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", info.mode & 0o777);
      await handle.writeFile(updated);
      await handle.chmod(info.mode & 0o777);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }
  return { version: release.version, updated: source !== updated };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await updateYtDlpImage();
    console.log(
      `Checked PyPI latest stable yt-dlp: ${result.version}; image lock ${result.updated ? "updated" : "already current"}`
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "yt-dlp release check failed"
    );
    process.exitCode = 1;
  }
}
