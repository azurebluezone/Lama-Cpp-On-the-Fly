import assert from "node:assert/strict";
import test from "node:test";
import { assetName, pickAssets } from "../src/os.ts";
import type { OsInfo, ReleaseAsset, ReleaseInfo } from "../src/types.ts";

function os(platform: OsInfo["platform"], arch: OsInfo["arch"]): OsInfo {
  return {
    platform,
    arch,
    distro: "test",
    distroVersion: "",
    glibc: null,
    isRoot: false,
    serviceManager: platform === "linux" ? "systemd" : "unknown",
    home: "/home/test",
    pathSep: platform === "win32" ? "\\" : "/",
  };
}

function asset(name: string): ReleaseAsset {
  return { name, url: `https://example.invalid/${name}`, size: 1, digest: null };
}

test("linux x64 CPU asset matches the stock release name", () => {
  assert.equal(assetName("b11982", os("linux", "x64"), "cpu").primary, "llama-b11982-bin-ubuntu-x64.tar.gz");
});

test("linux arm64 CUDA includes the cudart companion", () => {
  const result = assetName("b11982", os("linux", "arm64"), "cuda");
  assert.equal(result.primary, "llama-b11982-bin-ubuntu-cuda-13.4-arm64.tar.gz");
  assert.deepEqual(result.extras, ["cudart-b11982-bin-ubuntu-cuda-13.4-arm64.tar.gz"]);
});

test("macOS and Windows names are explicit", () => {
  assert.equal(assetName("b11982", os("darwin", "arm64"), "cpu").primary, "llama-b11982-bin-macos-arm64.tar.gz");
  assert.equal(assetName("b11982", os("win32", "x64"), "cpu").primary, "llama-b11982-bin-win-cpu-x64.zip");
});

test("pickAssets selects primary and extra assets", () => {
  const release: ReleaseInfo = {
    tag: "b11982",
    build: 11982,
    assets: [
      asset("llama-b11982-bin-ubuntu-cuda-13.4-x64.tar.gz"),
      asset("cudart-b11982-bin-ubuntu-cuda-13.4-x64.tar.gz"),
    ],
  };
  const selected = pickAssets(release, os("linux", "x64"), "cuda");
  assert.equal(selected.primary.name, "llama-b11982-bin-ubuntu-cuda-13.4-x64.tar.gz");
  assert.equal(selected.extras.length, 1);
});

test("pickAssets fails loudly instead of guessing", () => {
  const release: ReleaseInfo = { tag: "b11982", build: 11982, assets: [asset("other.tar.gz")] };
  assert.throws(() => pickAssets(release, os("linux", "x64"), "cpu"), /no asset/);
});
