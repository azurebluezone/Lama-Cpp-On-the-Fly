export type Platform = "linux" | "darwin" | "win32";
export type Arch = "x64" | "arm64" | "s390x" | "unknown";
export type Accel = "cpu" | "cuda" | "vulkan" | "rocm" | "openvino" | "sycl";
export type ServiceMode = "none" | "user" | "system";
export type LoadMode = "auto" | "mmap" | "none" | "mlock" | "mmap+mlock" | "dio";
export type McpTransport = "stdio" | "http" | "sse";
export type EngineTransport = "http" | "https" | "uds";

export interface OsInfo {
  platform: Platform;
  arch: Arch;
  distro: string;
  distroVersion: string;
  glibc: string | null;
  isRoot: boolean;
  serviceManager: "systemd" | "launchd" | "windows-service" | "unknown";
  home: string;
  pathSep: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  digest: string | null;
}

export interface ReleaseInfo {
  tag: string;
  build: number;
  assets: ReleaseAsset[];
}

export interface ProviderRow {
  id: string;
  name: string;
  kind: "llamacpp";
  base_url: string;
  build: string | null;
  config_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface ModelRow {
  id: string;
  provider_id: string;
  name: string;
  model_id: string;
  path: string | null;
  context: number | null;
  max_tokens: number | null;
  temperature: number;
  quant: string | null;
  load_mode: LoadMode;
  ttl_hours: number | null;
  enabled: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface McpRow {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args_json: string;
  env_json: string;
  cwd: string | null;
  url: string | null;
  api_key_ref: string | null;
  timeout_ms: number;
  enabled: number;
  status: "unknown" | "active" | "inactive";
  last_probe_at: string | null;
  last_probe_detail: string;
  use_count: number;
  tools_count: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface TransportRow {
  id: string;
  name: string;
  protocol: EngineTransport;
  host: string | null;
  port: number | null;
  socket_path: string | null;
  tls_key: string | null;
  tls_cert: string | null;
  gateway_hint: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  status?: "unknown" | "up" | "down";
  connected_clients?: number;
}

export interface DocumentRow {
  id: string;
  slug: string;
  title: string;
  transport_id: string | null;
  body: string;
  verified_at: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  title: string;
  model_id: string | null;
  system_prompt_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface SessionMessageRow {
  id: number;
  session_id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  model_id: string | null;
  tokens: number | null;
  metadata_json: string;
  created_at: string;
}

export interface PromptRow {
  id: string;
  name: string;
  content: string;
  version: number;
  is_default: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface EngineState {
  model_id: string | null;
  pid: number | null;
  status: "stopped" | "starting" | "running" | "error";
  started_at: string | null;
  expires_at: string | null;
  load_mode: LoadMode;
  socket_path: string | null;
  port: number | null;
  build: string | null;
  mmap: MmapStatus | null;
  last_error: string | null;
  updated_at: string;
}

export interface MmapStatus {
  mapped: boolean;
  perms: string | null;
  bytes: number | null;
  source: "proc-maps" | "unavailable";
  detail: string;
}

export interface RequestLogRow {
  id: number;
  at: string;
  model_id: string | null;
  model_key: string | null;
  provider_id: string | null;
  transport_id: string | null;
  client_adapter: string | null;
  user_agent: string | null;
  protocol: "openai" | "anthropic" | "other";
  endpoint: string;
  method: string;
  status: number;
  ok: number;
  stream: number;
  duration_ms: number;
  first_token_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  bytes: number;
  system_prompt_id: string | null;
  detail: string;
}

export type RequestLogInput = Omit<RequestLogRow, "id" | "at"> & { at?: string };

export interface ToolUsageRow {
  id: number;
  at: string;
  tool: string;
  mcp_id: string | null;
  ok: number;
  duration_ms: number;
  detail: string;
}

export interface DownloadRow {
  id: number;
  repo: string;
  file: string;
  path: string;
  bytes_total: number;
  bytes_done: number;
  status: "queued" | "running" | "done" | "failed";
  error: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface McpToolRow {
  id: string;
  mcp_id: string;
  name: string;
  description: string;
  use_cases: string;
  enabled: number;
  updated_at: string;
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  source: "native" | "marker" | "json";
}

export interface ParseResult {
  calls: ToolCall[];
  rejected: Array<{ reason: string; raw: unknown }>;
}
