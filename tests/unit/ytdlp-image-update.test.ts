import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

interface Release {
  version: string;
  hashes: string[];
}
interface Distribution {
  filename: string;
  packagetype: string;
  url: string;
  yanked: boolean;
  digests: { sha256: string };
}
interface Metadata {
  info: { name: string; version: string };
  urls: Distribution[];
}
const updater = (await import(
  new URL("../../scripts/image/update-ytdlp.mjs", import.meta.url).href
)) as {
  PYPI_YTDLP_URL: string;
  resolveLatestYtDlp(metadata: unknown): Release;
  refreshYtDlpLock(source: string, release: Release): string;
  updateYtDlpImage(options: {
    root: string;
    fetchMetadata: typeof fetch;
  }): Promise<{ version: string; updated: boolean }>;
};
const oldVersion = "2026.10.21";
const newVersion = "2026.10.26";
const oldHash = "0".repeat(64);
const wheelHash = "a".repeat(64);
const sourceHash = "b".repeat(64);
const otherHash = "c".repeat(64);
const workspaces: string[] = [];
const lock = () =>
  [
    "# Complete Python runtime lock; verified against PyPI metadata on2026-10-26.",
    `# Direct applications: yt-dlp[default]${oldVersion}; faster-whisper1.2.1.`,
    "--index-url https://pypi.org/simple",
    "",
    "faster-whisper==1.2.1 \\",
    `    --hash=sha256:${otherHash}`,
    "",
    `yt-dlp[default]==${oldVersion} \\`,
    `    --hash=sha256:${oldHash}`,
    "",
    "yt-dlp-ejs==0.8.0 \\",
    `    --hash=sha256:${otherHash}`,
    "",
  ].join("\n");
function metadata(version = newVersion): Metadata {
  const wheel = `yt_dlp-${version}-py3-none-any.whl`;
  const source = `yt_dlp-${version}.tar.gz`;
  return {
    info: { name: "yt-dlp", version },
    urls: [
      {
        filename: source,
        packagetype: "sdist",
        url: `https://files.pythonhosted.org/packages/aa/bb/${source}`,
        yanked: false,
        digests: { sha256: sourceHash },
      },
      {
        filename: wheel,
        packagetype: "bdist_wheel",
        url: `https://files.pythonhosted.org/packages/cc/dd/${wheel}`,
        yanked: false,
        digests: { sha256: wheelHash },
      },
    ],
  };
}
async function workspace(contents = lock()) {
  const root = await mkdtemp(join(tmpdir(), "scrub-ytdlp-image-"));
  workspaces.push(root);
  const directory = join(root, "deployments/image");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "requirements.txt");
  await writeFile(path, contents);
  return { root, directory, path };
}
afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("latest yt-dlp image lock", () => {
  it("selects sorted hashes for non-yanked distributions from the latest stable release", () => {
    const data = metadata();
    data.urls.push({
      ...data.urls[0],
      yanked: true,
      digests: { sha256: "invalid-yanked-hash" },
    });
    expect(updater.resolveLatestYtDlp(data)).toEqual({
      version: newVersion,
      hashes: [wheelHash, sourceHash],
    });
  });

  it.each([
    [
      "wrong package",
      (data: Metadata) => {
        data.info.name = "another-package";
      },
    ],
    [
      "development release",
      (data: Metadata) => {
        data.info.version = "2026.10.26.dev1";
      },
    ],
    [
      "invalid date",
      (data: Metadata) => {
        data.info.version = "2026.2.30";
      },
    ],
    [
      "missing SHA-256",
      (data: Metadata) => {
        data.urls[0].digests.sha256 = "invalid";
      },
    ],
    [
      "wrong filename version",
      (data: Metadata) => {
        data.urls[0].filename = `yt_dlp-${oldVersion}.tar.gz`;
      },
    ],
    [
      "untrusted distribution host",
      (data: Metadata) => {
        data.urls[0].url = "https://example.test/packages/source.tar.gz";
      },
    ],
    [
      "authenticated distribution URL",
      (data: Metadata) => {
        data.urls[0].url = data.urls[0].url.replace(
          "https://",
          "https://user:password@"
        );
      },
    ],
    [
      "missing wheel",
      (data: Metadata) => {
        data.urls = data.urls.filter(
          (item) => item.packagetype !== "bdist_wheel"
        );
      },
    ],
    [
      "all distributions yanked",
      (data: Metadata) => {
        for (const item of data.urls) item.yanked = true;
      },
    ],
  ])("rejects %s metadata", (_name, change) => {
    const data = metadata();
    change(data);
    expect(() => updater.resolveLatestYtDlp(data)).toThrow();
  });

  it("refreshes only the yt-dlp requirement and direct-application version", () => {
    const original = lock();
    const updated = updater.refreshYtDlpLock(
      original,
      updater.resolveLatestYtDlp(metadata())
    );
    expect(updated).toBe(
      original
        .replace(
          `yt-dlp[default]${oldVersion};`,
          `yt-dlp[default]${newVersion};`
        )
        .replace(
          `yt-dlp[default]==${oldVersion} \\\n    --hash=sha256:${oldHash}`,
          `yt-dlp[default]==${newVersion} \\\n    --hash=sha256:${wheelHash} \\\n    --hash=sha256:${sourceHash}`
        )
    );
    expect(
      updater.refreshYtDlpLock(updated, updater.resolveLatestYtDlp(metadata()))
    ).toBe(updated);
    expect(
      updater.refreshYtDlpLock(
        original.replaceAll("\n", "\r\n"),
        updater.resolveLatestYtDlp(metadata())
      )
    ).toBe(updated.replaceAll("\n", "\r\n"));
  });

  it("fails on ambiguous locks or upstream metadata older than the checked-in version", () => {
    const release = updater.resolveLatestYtDlp(metadata());
    for (const malformed of [
      lock() +
        `\nyt-dlp[default]==${oldVersion} \\\n    --hash=sha256:${oldHash}\n`,
      lock() + "\nyt-dlp==2026.10.21\n",
      lock().replace(
        `yt-dlp[default]${oldVersion};`,
        "yt-dlp[default]2026.10.20;"
      ),
      lock().replace(`--hash=sha256:${oldHash}`, "--hash=sha256:invalid"),
      lock().replace(`--hash=sha256:${oldHash}`, `--hash=sha256:${oldHash} \\`),
    ])
      expect(() => updater.refreshYtDlpLock(malformed, release)).toThrow();
    expect(() =>
      updater.refreshYtDlpLock(lock(), { ...release, version: "2026.10.20" })
    ).toThrow("refusing to downgrade");
  });

  it("checks PyPI every invocation, writes atomically, and preserves current locks without touching their mtime", async () => {
    const files = await workspace();
    await chmod(files.path, 0o640);
    const fetchMetadata = vi.fn(async () => ({
      ok: true,
      json: async () => metadata(),
    })) as unknown as typeof fetch;
    await expect(
      updater.updateYtDlpImage({ root: files.root, fetchMetadata })
    ).resolves.toEqual({ version: newVersion, updated: true });
    const updated = await readFile(files.path, "utf8");
    expect(updated).toContain(`yt-dlp[default]==${newVersion}`);
    expect((await stat(files.path)).mode & 0o777).toBe(0o640);
    const earlier = new Date("2020-01-01T00:00:00.000Z");
    await utimes(files.path, earlier, earlier);
    await expect(
      updater.updateYtDlpImage({ root: files.root, fetchMetadata })
    ).resolves.toEqual({ version: newVersion, updated: false });
    expect((await stat(files.path)).mtime.toISOString()).toBe(
      earlier.toISOString()
    );
    expect(await readdir(files.directory)).toEqual(["requirements.txt"]);
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
    expect(fetchMetadata).toHaveBeenCalledWith(
      updater.PYPI_YTDLP_URL,
      expect.objectContaining({
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", "cache-control": "no-cache" },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it.each([
    [
      "network failure",
      async () => {
        throw new Error("private-transport-error");
      },
    ],
    ["HTTP failure", async () => ({ ok: false, json: async () => metadata() })],
    [
      "invalid JSON",
      async () => ({
        ok: true,
        json: async () => {
          throw new Error("response-preview");
        },
      }),
    ],
    [
      "invalid metadata",
      async () => ({
        ok: true,
        json: async () => ({ info: { name: "other" } }),
      }),
    ],
  ])("leaves the lock untouched after %s", async (_name, implementation) => {
    const files = await workspace();
    const fetchMetadata = vi.fn(implementation) as unknown as typeof fetch;
    await expect(
      updater.updateYtDlpImage({ root: files.root, fetchMetadata })
    ).rejects.toThrow();
    expect(await readFile(files.path, "utf8")).toBe(lock());
    expect(await readdir(files.directory)).toEqual(["requirements.txt"]);
  });
});
