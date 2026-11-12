import path from "node:path";
import type { Config } from "../src/config.ts";
import type { OsInfo } from "../src/types.ts";

export function testConfig(root: string): Config {
  const dataDir = path.join(root, "data");
  return {
    root,
    dataDir,
    modelsDir: path.join(root, "models"),
    logsDir: path.join(root, "logs"),
    runDir: path.join(root, "run"),
    certsDir: path.join(root, "certs"),
    webDir: path.join(root, "web"),
    workspaceDir: path.join(root, "workspace"),
    dbFile: path.join(dataDir, "lama.db"),
    stateFile: path.join(dataDir, "engine.json"),
    lockFile: path.join(dataDir, "engine.lock"),
    pidFile: path.join(root, "run", "engine.pid"),
    envFile: path.join(root, ".env"),
    adminToken: "test-token",
    gatewayHost: "127.0.0.1",
    gatewayPort: 0,
    gatewayEngine: "http",
    gatewayUdsPath: "",
    tlsPort: 19930,
    gatewayOrigins: ["http://127.0.0.1:5252"],
    apiKey: "",
    apiAuth: "loopback",
    engineApiKey: "",
    engineHost: "127.0.0.1",
    enginePort: 19931,
    engineUrl: "http://127.0.0.1:19931",
    udsPath: path.join(root, "run", "llama.sock"),
    llamaBin: "llama-server",
    loadMode: "auto",
    accel: "cpu",
    build: null,
    tlsKey: path.join(root, "certs", "localhost-key.pem"),
    tlsCert: path.join(root, "certs", "localhost-cert.pem"),
    tls: false,
    serviceMode: "none",
    gatewayDir: path.join(root, "gateway"),
    defaultTtlHours: 4,
    warnings: [],
  };
}

export function testOs(): OsInfo {
  return {
    platform: "linux",
    arch: "x64",
    distro: "ubuntu",
    distroVersion: "24.04",
    glibc: "2.39",
    isRoot: false,
    serviceManager: "systemd",
    home: "/home/test",
    pathSep: "/",
  };
}
