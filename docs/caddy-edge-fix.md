# Caddy edge fix — what changed and how it was proven

Scope: `/home/sahon/zclama/Caddyfile`, `templates/`, `db/seed/lama.json`, the reset of the local
stack, and the release gate. Reference for the Caddyfile options:
<https://caddyserver.com/docs/caddyfile/options> plus the local Caddy v2.11.9 source
(`/home/sahon/caddy/caddyconfig/httpcaddyfile/serveroptions.go:134-226`,
`/home/sahon/caddy/modules/caddyhttp/requestbody/caddyfile.go:36`).

## Caddyfile

| Requirement | Directive | Why |
| --- | --- | --- |
| header size cap | `servers { max_header_size 32KB }` | bound the header bytes a client may send |
| stream-safe timeouts | `servers { timeouts { read_header 10s; read_body 0; write 0; write_idle 5m; idle 5m } }` | SSE responses and large uploads must not be cut off; dead sockets still get reaped |
| request size cap | `request_body { max_size 64MB }` | oversized uploads are rejected with `413` instead of being buffered |
| client-expected headers | `header { X-Content-Type-Options nosniff; Cache-Control "no-store"; -Server }` | no second `Content-Type`, no proxy cache, no `Server` leak |
| SSE delivery | `reverse_proxy 127.0.0.1:5252 { flush_interval -1 }` | tokens reach the client one by one |
| original host / client address | `header_up Host {http.request.host}`, `header_up X-Real-IP {remote_host}` | the gateway sees the real host (with port) and client |
| no transport deadline | `transport http { read_timeout 0; write_timeout 0 }` | long-lived streams are not interrupted |
| local-only TLS | `auto_https off`, `admin off` | repo self-signed cert, no ACME, no clash with the system Caddy admin API |

Edge site: `{$LAMA_SITE:127.0.0.1}:{$LAMA_EDGE_PORT:9931}` -> gateway `127.0.0.1:5252`.
Port `9931` is used (not `443`) because the system Caddy already owns `:80/:443` and serves the
zombiebd/mission API; the zclama edge runs as a user process, so no root is needed.

## Model chat template

`templates/deepseek-v4-pro.jinja` was downloaded from
`https://huggingface.co/Jackrong/DeepSeek-V4-Pro-Qwen3.5-4B/raw/main/chat_template.jinja`
(sha256 `02d01fc2955dfad64d469780ae92245461a06f467dde7d3d157f823eda681abc`). It is byte-identical
to the `tokenizer.chat_template` embedded in `models/DeepSeek-V4-Pro.gguf`
(`MATCH_OK=1`, script `evidence/template-check.py`). The engine now starts with
`--chat-template-file /home/sahon/zclama/templates/deepseek-v4-pro.jinja`.

GGUF facts used for the seed row: `general.file_type=10` (Q2_K), `general.base_model.0.repo_url=
https://huggingface.co/unsloth/Qwen3.5-4B`, file size `1959169632` =
`DeepSeek-V4-Pro-Qwen3.5-4B.Q2_K.gguf`, file sha256 `21212f005b24872c746283bba925827517cba00c42d76cae7eeb8b1b118d1e44`.

## Seed (`db/seed/lama.json`)

- `deepseek-v4-pro` added: Q2_K, `load_mode mmap`, sha256, `chat_template` path + source.
- `qwen2-5-vl-3b-instruct-q2-k` added (the file exists under `models/`).
- Provider/transport notes corrected to the live topology: gateway `5252`, engine `9932`,
  TLS edge `127.0.0.1:9931`, engine-native TLS on `LAMA_TLS_PORT=9931`.
- MCP server workspace moved to `/home/sahon/zclama/workspace`, cwd `/home/sahon/zclama`.
- Applied with `node src/main.ts seed` -> models=3 seeded, 2 skipped (files not downloaded yet).

## Reset and re-test

1. `node src/main.ts seed` (fresh rows for every seeded model).
2. Stale registry row `e2e-qwen` (path `/home/sahon/lama/models/...`, file gone) deleted.
3. `systemctl --user restart lama-engine.service lama-gateway.service` -> engine PID 206671 with
   `--load-mode mmap --chat-template-file .../deepseek-v4-pro.jinja`.
4. `bash scripts/caddy.sh start` -> edge on `127.0.0.1:9931` (`/healthz` 200, `ssl_verify_result=0`).
5. `bash scripts/verify-release.sh` -> `VERIFY_OK`, exit `0`.

Gate drift fixed along the way: the gate expected `81 tests` (the suite is at `103`), pointed the
edge at `https://localhost` (the system Caddy, wrong cert) and asked for the
`qwen3-1.7b-abliterated` model (the live model is `deepseek-v4-pro`). `README.md` was restored from
`lama-dist-0.1.0.tgz` and patched; `docs/lama-clean.md` was written so the docs truth checks match
the code.

## Evidence

| Artifact | Content |
| --- | --- |
| `/home/sahon/lama/evidence/verify-release.log` | release gate output, ends with `VERIFY_OK` |
| `/home/sahon/lama/evidence/caddy-validate.log` | `caddy validate` -> `Valid configuration` |
| `/home/sahon/lama/evidence/template-check.log` | `MATCH_OK=1`, embedded sha256 == disk sha256 |
| `/home/sahon/lama/evidence/seed-check.log` | seed models, quant, chat template, topology notes |
| `/home/sahon/lama/evidence/verify-ops-rerun2.log` | `RESULT_OK=1` for the engine/UDS/swap checks |
