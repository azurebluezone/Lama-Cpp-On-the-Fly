export type AdapterProtocol = "openai" | "anthropic";

export interface AdapterDefinition {
  id: string;
  name: string;
  protocol: AdapterProtocol;
  description: string;
  /** Header value the client should send so the gateway can attribute calls. */
  client_header: string;
}

export const ADAPTERS: AdapterDefinition[] = [
  {
    id: "opencode",
    name: "OpenCode",
    protocol: "openai",
    description: "OpenCode provider block for the OpenAI-compatible gateway.",
    client_header: "opencode",
  },
  {
    id: "vscode",
    name: "VSCode",
    protocol: "openai",
    description: "OpenAI-compatible settings for VSCode extensions such as Continue.",
    client_header: "vscode",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    protocol: "anthropic",
    description: "Anthropic-compatible environment for Claude Code.",
    client_header: "claude-code",
  },
  {
    id: "curl",
    name: "curl",
    protocol: "openai",
    description: "Copy-paste curl examples for both wire protocols.",
    client_header: "curl",
  },
];

export interface AdapterConfigInput {
  baseUrl: string;
  model: string;
  token: string;
}

export interface AdapterFile {
  path: string;
  content: string;
}

export interface AdapterConfig {
  id: string;
  name: string;
  protocol: AdapterProtocol;
  base_url: string;
  model: string;
  headers: Record<string, string>;
  files: AdapterFile[];
}

export function adapterById(id: string): AdapterDefinition | undefined {
  return ADAPTERS.find((adapter) => adapter.id === id.trim().toLowerCase());
}

export function adapterIds(): string[] {
  return ADAPTERS.map((adapter) => adapter.id);
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function openAiBase(baseUrl: string): string {
  const base = trimBaseUrl(baseUrl);
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function buildAdapterConfig(id: string, input: AdapterConfigInput): AdapterConfig {
  const definition = adapterById(id);
  if (!definition) {
    throw new Error(`unknown adapter ${id}; choose ${adapterIds().join(", ")}`);
  }
  const baseUrl = trimBaseUrl(input.baseUrl);
  const model = input.model.trim() || "default";
  const token = input.token || "<LAMA_ADMIN_TOKEN>";
  const headers: Record<string, string> = {
    "x-lama-client": definition.client_header,
  };

  if (definition.id === "opencode") {
    // OpenCode V2 reads `providers` + `package`; the V1 `provider`/`npm`/`options`
    // shape is silently inactive. The admin token is omitted because /v1 is
    // guarded by LAMA_API_KEY, not the admin token.
    const config = {
      $schema: "https://opencode.ai/config.json",
      providers: {
        lama: {
          name: "Lama Clean",
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: openAiBase(baseUrl),
          },
          headers,
          models: {
            [model]: { name: model, modelID: model },
          },
        },
      },
    };
    return {
      id: definition.id,
      name: definition.name,
      protocol: definition.protocol,
      base_url: openAiBase(baseUrl),
      model,
      headers,
      files: [{ path: "opencode.json", content: `${JSON.stringify(config, null, 2)}\n` }],
    };
  }

  if (definition.id === "vscode") {
    const config = {
      models: [
        {
          title: `Lama Clean (${model})`,
          provider: "openai",
          model,
          apiBase: openAiBase(baseUrl),
          apiKey: token,
          requestOptions: { headers },
        },
      ],
    };
    return {
      id: definition.id,
      name: definition.name,
      protocol: definition.protocol,
      base_url: openAiBase(baseUrl),
      model,
      headers,
      files: [{ path: "continue-config.json", content: `${JSON.stringify(config, null, 2)}\n` }],
    };
  }

  if (definition.id === "claude-code") {
    const env = [
      `ANTHROPIC_BASE_URL=${baseUrl}`,
      `ANTHROPIC_AUTH_TOKEN=${token}`,
      `ANTHROPIC_MODEL=${model}`,
      `ANTHROPIC_CUSTOM_HEADERS=x-lama-client: ${definition.client_header}`,
    ].join("\n");
    return {
      id: definition.id,
      name: definition.name,
      protocol: definition.protocol,
      base_url: baseUrl,
      model,
      headers,
      files: [{ path: ".env.claude-code", content: `${env}\n` }],
    };
  }

  const curl = [
    `# OpenAI wire protocol`,
    `curl -sS ${openAiBase(baseUrl)}/chat/completions \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H 'authorization: Bearer ${token}' \\`,
    `  -H 'x-lama-client: ${definition.client_header}' \\`,
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"ping"}],"stream":true}'`,
    ``,
    `# Anthropic wire protocol`,
    `curl -sS ${baseUrl}/v1/messages \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H 'anthropic-version: 2023-06-01' \\`,
    `  -H 'authorization: Bearer ${token}' \\`,
    `  -H 'x-lama-client: ${definition.client_header}' \\`,
    `  -d '{"model":"${model}","max_tokens":64,"messages":[{"role":"user","content":"ping"}],"stream":true}'`,
    ``,
  ].join("\n");
  return {
    id: definition.id,
    name: definition.name,
    protocol: definition.protocol,
    base_url: baseUrl,
    model,
    headers,
    files: [{ path: "curl.sh", content: curl }],
  };
}

/**
 * Attribution is a label, not an authentication boundary. Normalise whatever
 * the client sent so the transport stats stay groupable.
 */
export function detectAdapter(explicit: string, userAgent: string): string {
  const requested = explicit.trim().toLowerCase();
  if (requested) return requested.slice(0, 64);
  const ua = userAgent.trim().toLowerCase();
  if (!ua) return "unknown";
  if (ua.includes("opencode")) return "opencode";
  if (ua.includes("claude-code") || ua.includes("claude code")) return "claude-code";
  if (ua.includes("vscode") || ua.includes("visual studio code")) return "vscode";
  if (ua.includes("curl")) return "curl";
  if (ua.includes("python")) return "python";
  if (ua.includes("node")) return "node";
  return "other";
}
