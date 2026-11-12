import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { Accel, Arch, OsInfo, Platform, ReleaseAsset, ReleaseInfo } from "./types.ts";

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? (result.stdout || "").trim() : "";
}

export function detectOs(): OsInfo {
  const platform: Platform =
    process.platform === "linux" || process.platform === "darwin" || process.platform === "win32"
      ? process.platform
      : "linux";
  const arch: Arch =
    process.arch === "x64" || process.arch === "arm64" || process.arch === "s390x"
      ? process.arch
      : "unknown";

  let distro = "unknown";
  let distroVersion = "";
  if (platform === "linux") {
    try {
      const release = fs.readFileSync("/etc/os-release", "utf8");
      const fields = new Map<string, string>();
      for (const line of release.split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1).replace(/^"|"$/g, ""));
      }
      distro = fields.get("ID") || fields.get("NAME") || "linux";
      distroVersion = fields.get("VERSION_ID") || "";
    } catch {
      distro = "linux";
    }
  }

  const glibc =
    platform === "linux"
      ? (() => {
          const text = run("ldd", ["--version"]);
          return /GLIBC\s+([\d.]+)/i.exec(text)?.[1] ?? /\)\s+([\d.]+)/.exec(text)?.[1] ?? null;
        })()
      : null;

  const isRoot =
    platform === "win32"
      ? false
      : typeof process.getuid === "function" && process.getuid() === 0;

  const serviceManager =
    platform === "linux"
      ? fs.existsSync("/run/systemd/system")
        ? "systemd"
        : "unknown"
      : platform === "darwin"
        ? "launchd"
        : "windows-service";

  return {
    platform,
    arch,
    distro,
    distroVersion,
    glibc,
    isRoot,
    serviceManager,
    home: os.homedir(),
    pathSep: process.platform === "win32" ? "\\" : "/",
  };
}

export function parseBuildTag(tag: string): number {
  const match = /^b(\d+)$/i.exec(tag.trim());
  return match ? Number(match[1]) : 0;
}

export function assetName(tag: string, os: OsInfo, accel: Accel): { primary: string; extras: string[] } {
  const b = tag.startsWith("b") ? tag : `b${tag}`;
  const cuda = os.platform === "linux" ? "13.4" : "13.4";
  if (os.platform === "linux") {
    if (os.arch === "x64") {
      const primary = (() => {
        switch (accel) {
          case "cuda":
            return `llama-${b}-bin-ubuntu-cuda-${cuda}-x64.tar.gz`;
          case "vulkan":
            return `llama-${b}-bin-ubuntu-vulkan-x64.tar.gz`;
          case "rocm":
            return `llama-${b}-bin-ubuntu-rocm-10.0-x64.tar.gz`;
          case "openvino":
            return `llama-${b}-bin-ubuntu-openvino-2026.4.1-x64.tar.gz`;
          case "sycl":
            return `llama-${b}-bin-ubuntu-sycl-fp16-x64.tar.gz`;
          default:
            return `llama-${b}-bin-ubuntu-x64.tar.gz`;
        }
      })();
      return {
        primary,
        extras: accel === "cuda" ? [`cudart-${b}-bin-ubuntu-cuda-${cuda}-x64.tar.gz`] : [],
      };
    }
    if (os.arch === "arm64") {
      const primary =
        accel === "cuda"
          ? `llama-${b}-bin-ubuntu-cuda-${cuda}-arm64.tar.gz`
          : accel === "vulkan"
            ? `llama-${b}-bin-ubuntu-vulkan-arm64.tar.gz`
            : `llama-${b}-bin-ubuntu-arm64.tar.gz`;
      return {
        primary,
        extras: accel === "cuda" ? [`cudart-${b}-bin-ubuntu-cuda-${cuda}-arm64.tar.gz`] : [],
      };
    }
    return { primary: `llama-${b}-bin-ubuntu-s390x.tar.gz`, extras: [] };
  }

  if (os.platform === "darwin") {
    return { primary: `llama-${b}-bin-macos-${os.arch}.tar.gz`, extras: [] };
  }

  if (os.arch === "arm64") {
    const primary =
      accel === "cuda"
        ? `llama-${b}-bin-win-cuda-${cuda}-arm64.zip`
        : accel === "vulkan"
          ? `llama-${b}-bin-win-vulkan-arm64.zip`
          : `llama-${b}-bin-win-cpu-arm64.zip`;
    return {
      primary,
      extras: accel === "cuda" ? [`cudart-llama-bin-win-cuda-${cuda}-arm64.zip`] : [],
    };
  }

  const primary = (() => {
    switch (accel) {
      case "cuda":
        return `llama-${b}-bin-win-cuda-${cuda}-x64.zip`;
      case "vulkan":
        return `llama-${b}-bin-win-vulkan-x64.zip`;
      case "rocm":
        return `llama-${b}-bin-win-rocm-10.0-x64.zip`;
      case "openvino":
        return `llama-${b}-bin-win-openvino-2026.4.1-x64.zip`;
      case "sycl":
        return `llama-${b}-bin-win-sycl-x64.zip`;
      default:
        return `llama-${b}-bin-win-cpu-x64.zip`;
    }
  })();
  return {
    primary,
    extras: accel === "cuda" ? [`cudart-llama-bin-win-cuda-${cuda}-x64.zip`] : [],
  };
}

export function pickAssets(release: ReleaseInfo, os: OsInfo, accel: Accel): { primary: ReleaseAsset; extras: ReleaseAsset[] } {
  const wanted = assetName(release.tag, os, accel);
  const byName = new Map(release.assets.map((asset) => [asset.name, asset]));
  const primary = byName.get(wanted.primary);
  if (!primary) {
    const names = release.assets.map((asset) => asset.name).slice(0, 12).join(", ");
    throw new Error(`release ${release.tag} has no asset ${wanted.primary} (first assets: ${names})`);
  }
  return {
    primary,
    extras: wanted.extras.map((name) => {
      const asset = byName.get(name);
      if (!asset) throw new Error(`release ${release.tag} has no companion asset ${name}`);
      return asset;
    }),
  };
}
