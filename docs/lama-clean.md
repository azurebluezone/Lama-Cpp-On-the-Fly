# lama — clean local stack

The whole stack is loopback-only. Nothing here listens on a public interface.

```
TLS edge        :9931  Caddy, https://127.0.0.1:9931 -> gateway (repo cert, SAN localhost/127.0.0.1)
gateway         :5252  OpenAI + Anthropic API, admin API + UI, SSE (LAMA_GATEWAY_PORT)
engine          :9932  stock llama.cpp, --load-mode mmap (LAMA_ENGINE_PORT)
spare engine    :9934  blue-green warm-up port; the next reload moves the engine back to 9932
unix socket     /tmp/llama-1000/llama.sock   dir 0700, socket 0660
pointer         /home/sahon/zclama/gateway/llama.sock -> /tmp/llama-1000/llama.sock
registry        data/manager.db              SQLite (WAL)
seeds           db/seed/lama.json            declarative rows, applied by `node src/main.ts seed`
templates       templates/                   chat templates + MCP gateway template
```

## Who owns what

| Surface | Where | Notes |
| --- | --- | --- |
| TLS edge | `https://127.0.0.1:9931` | Caddy, user process, no root. `auto_https off`, repo self-signed cert. |
| OpenAI API | `http://127.0.0.1:5252/v1` | gateway; `/v1/chat/completions`, `/v1/models` |
| Anthropic API | `http://127.0.0.1:5252/v1/messages` | requires the `anthropic-version` header |
| Admin API | `http://127.0.0.1:5252/api/*` | `authorization: Bearer $LAMA_ADMIN_TOKEN` |
| Admin UI | `http://127.0.0.1:5252/admin` | static files from `web/` |
| SSE | `http://127.0.0.1:5252/api/events` | `text/event-stream`, `retry: 3000`, `hello` frame |
| Engine | `http://127.0.0.1:9932` | plain HTTP, never TLS |
| Engine UDS | `/tmp/llama-1000/llama.sock` | `--unix-socket` in curl |

## Edge sizing and headers

`Caddyfile` (repo root) is the single TLS listener and follows the Caddyfile global options:

- `servers { max_header_size 32KB }` — request/response header byte cap.
- `servers { timeouts { read_header 10s; read_body 0; write 0; write_idle 5m; idle 5m } }` —
  SSE streams and large uploads must not be cut off, dead sockets still get reaped.
- `request_body { max_size 64MB }` — oversized uploads are rejected with `413`.
- `header` — `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Server` removed.
- `reverse_proxy` — `flush_interval -1` keeps SSE token-by-token, `Host` keeps the original
  `{http.request.host}`, transport read/write timeouts are disabled for streams.

## Models and templates

| Model id | File | Quant | Chat template |
| --- | --- | --- | --- |
| `deepseek-v4-pro` | `models/DeepSeek-V4-Pro.gguf` | Q2_K | `templates/deepseek-v4-pro.jinja` |
| `huihui-qwen3-1.7b-abliterated` | `models/Huihui-Qwen3-1.7B-abliterated-v2.Q4_K_M.gguf` | Q4_K_M | `templates/qwen3-chat.jinja` |
| `qwen2-5-vl-3b-instruct-q2-k` | `models/Qwen2.5-VL-3B-Instruct-Q2_K.gguf` | Q2_K | — |

`templates/deepseek-v4-pro.jinja` is byte-identical to the chat template embedded in
`DeepSeek-V4-Pro.gguf` (sha256 `02d01fc2955dfad64d469780ae92245461a06f467dde7d3d157f823eda681abc`).

## Verification

```bash
npm test                        # node --test test/*.test.ts  → 103 tests
bash scripts/verify-release.sh  # typecheck + 103 tests + docs truth + verified HTTPS edge + tool call
bash scripts/caddy.sh status     # https://127.0.0.1:9931/healthz -> 200
```

`verify-release.sh` is the release gate: it verifies TLS with `--cacert certs/localhost-cert.pem`
(no `-k`), checks `/healthz`, `/v1/models`, `/v1/chat/completions` and `/api/tools/call` over the
edge, and fails loudly when the docs drift from the code.
