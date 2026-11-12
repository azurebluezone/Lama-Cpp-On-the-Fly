import { loadConfig } from "../config.ts";
import { ADAPTERS, adapterIds, buildAdapterConfig, type AdapterConfig } from "./registry.ts";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function usage(): void {
  process.stdout.write(`lama adapter — zero-headless client configs

Usage:
  node src/main.ts adapter list
  node src/main.ts adapter <id> [--base-url URL] [--model NAME] [--token TOKEN] [--json]

Adapters: ${adapterIds().join(", ")}

The command prints a config file and the exact headers the client must send.
No browser, no daemon, no hidden state.
`);
}

export async function runAdapterCli(args: string[]): Promise<void> {
  const action = args[0];
  if (!action || action === "list") {
    for (const adapter of ADAPTERS) {
      process.stdout.write(`${adapter.id.padEnd(12)} ${adapter.protocol.padEnd(9)} ${adapter.name} — ${adapter.description}\n`);
    }
    return;
  }
  if (action === "--help" || action === "-h") {
    usage();
    return;
  }

  const cfg = loadConfig();
  const baseUrl =
    option(args, "--base-url") ??
    process.env.LAMA_PUBLIC_URL ??
    `http://${cfg.gatewayHost}:${cfg.gatewayPort}`;
  const model = option(args, "--model") ?? "default";
  const token = option(args, "--token") ?? cfg.adminToken ?? cfg.apiKey ?? "";
  const config = buildAdapterConfig(action, { baseUrl, model, token });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }
  printConfig(config);
}

function printConfig(config: AdapterConfig): void {
  process.stdout.write(`adapter: ${config.name} (${config.protocol})\n`);
  process.stdout.write(`base:    ${config.base_url}\n`);
  process.stdout.write(`model:   ${config.model}\n`);
  process.stdout.write(`header:  ${Object.entries(config.headers).map(([key, value]) => `${key}: ${value}`).join(", ")}\n\n`);
  for (const file of config.files) {
    process.stdout.write(`--- ${file.path} ---\n${file.content}\n`);
  }
}
