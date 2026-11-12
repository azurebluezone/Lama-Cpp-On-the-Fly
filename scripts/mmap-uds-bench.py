#!/usr/bin/env python3
"""Raw mmap + mlock load, full pointer read, and UDS round-trip benchmark.

Real inputs only:
  - models/DeepSeek-V4-Pro.gguf (the running engine's file)
  - run/gateway.sock (the gateway UDS, which proxies to the engine UDS)

The script maps the file with libc mmap, locks every page with mlock, reads
every byte through the raw pointer for a checksum, then sends two real HTTP
requests over the Unix socket. It prints BENCH_OK=1 only when every step
succeeded, so the goal contract can verify the run without trusting prose.
"""

import ctypes
import hashlib
import json
import os
import socket
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.environ.get("LAMA_MODEL_FILE", os.path.join(ROOT, "models", "DeepSeek-V4-Pro.gguf"))
UDS = os.environ.get("LAMA_GATEWAY_UDS", os.path.join(ROOT, "run", "gateway.sock"))
MODEL_ID = os.environ.get("LAMA_MODEL", "deepseek-v4-pro")
PAGE = os.sysconf("SC_PAGE_SIZE")

PROT_READ = 1
MAP_SHARED = 1
MADV_WILLNEED = 3
MAP_FAILED = ctypes.c_void_p(-1).value

libc = ctypes.CDLL(None, use_errno=True)
libc.mmap.restype = ctypes.c_void_p
libc.mmap.argtypes = [
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_long,
]
libc.mlock.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
libc.mlock.restype = ctypes.c_int
libc.munlock.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
libc.munlock.restype = ctypes.c_int
libc.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
libc.munmap.restype = ctypes.c_int
libc.madvise.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
libc.madvise.restype = ctypes.c_int
libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_ubyte)]
libc.mincore.restype = ctypes.c_int


def fail(reason: str) -> None:
    print(f"BENCH_ERROR={reason}")
    print("BENCH_OK=0")
    sys.exit(1)


def mem_available() -> int:
    try:
        with open("/proc/meminfo", "r", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except OSError:
        pass
    return 0


def resident(addr: int, size: int) -> tuple[int, int, float]:
    pages = (size + PAGE - 1) // PAGE
    vec = (ctypes.c_ubyte * pages)()
    rc = libc.mincore(ctypes.c_void_p(addr), ctypes.c_size_t(size), vec)
    if rc != 0:
        fail(f"mincore_errno_{ctypes.get_errno()}")
    live = sum(1 for index in range(pages) if vec[index] & 1)
    return live, pages, (100.0 * live / pages if pages else 0.0)


def admin_token() -> str:
    try:
        with open(os.path.join(ROOT, ".env"), "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("LAMA_ADMIN_TOKEN="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def dechunk(data: bytes) -> bytes:
    out = bytearray()
    index = 0
    while True:
        end = data.find(b"\r\n", index)
        if end < 0:
            break
        size = int(data[index:end].split(b";", 1)[0], 16)
        if size == 0:
            break
        start = end + 2
        out.extend(data[start:start + size])
        index = start + size + 2
    return bytes(out)


def uds_call(raw: bytes, timeout: float = 120.0) -> tuple[int, bytes, float]:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    started = time.perf_counter()
    sock.connect(UDS)
    sock.sendall(raw)
    chunks = []
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    sock.close()
    data = b"".join(chunks)
    head, _, body = data.partition(b"\r\n\r\n")
    status = 0
    fields = head.split(b" ", 2)
    if len(fields) >= 2:
        try:
            status = int(fields[1])
        except ValueError:
            status = 0
    if b"transfer-encoding: chunked" in head.lower():
        body = dechunk(body)
    return status, body, elapsed_ms


def http_get(path: str) -> bytes:
    return (
        f"GET {path} HTTP/1.1\r\n"
        "Host: localhost\r\n"
        "Connection: close\r\n"
        "\r\n"
    ).encode("ascii")


def http_chat(payload: dict, token: str) -> bytes:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    lines = [
        b"POST /v1/chat/completions HTTP/1.1",
        b"Host: localhost",
        b"Content-Type: application/json",
        b"Connection: close",
        b"Content-Length: " + str(len(body)).encode("ascii"),
    ]
    if token:
        lines.append(b"Authorization: Bearer " + token.encode("utf-8"))
    return b"\r\n".join(lines) + b"\r\n\r\n" + body


if not os.path.isfile(MODEL):
    fail("model_file_missing")
if not os.path.exists(UDS):
    fail("uds_missing")

size = os.path.getsize(MODEL)
available = mem_available()
if available and available < size + 512 * 1024 * 1024:
    fail(f"low_mem_available_{available}")

fd = os.open(MODEL, os.O_RDONLY)
mapped_at = time.perf_counter()
addr = libc.mmap(None, size, PROT_READ, MAP_SHARED, fd, 0)
mmap_ms = (time.perf_counter() - mapped_at) * 1000.0
if not addr or addr == MAP_FAILED:
    os.close(fd)
    fail(f"mmap_errno_{ctypes.get_errno()}")

before_live, before_pages, before_pct = resident(addr, size)

locked_at = time.perf_counter()
lock_rc = libc.mlock(ctypes.c_void_p(addr), ctypes.c_size_t(size))
load_ms = (time.perf_counter() - locked_at) * 1000.0
locked = lock_rc == 0
lock_errno = ctypes.get_errno()
if not locked:
    libc.madvise(ctypes.c_void_p(addr), ctypes.c_size_t(size), MADV_WILLNEED)

after_load_live, after_load_pages, after_load_pct = resident(addr, size)

pointer = (ctypes.c_char * size).from_address(addr)
first_word = ctypes.c_uint64.from_address(addr).value
last_word = ctypes.c_uint64.from_address(addr + size - 8).value

read_at = time.perf_counter()
checksum = hashlib.sha256(pointer).hexdigest()
read_ms = (time.perf_counter() - read_at) * 1000.0
read_gbs = (size / (read_ms / 1000.0)) / 1_000_000_000 if read_ms > 0 else 0.0

after_read_live, after_read_pages, after_read_pct = resident(addr, size)

libc.munlock(ctypes.c_void_p(addr), ctypes.c_size_t(size))
libc.munmap(ctypes.c_void_p(addr), ctypes.c_size_t(size))
os.close(fd)

health_status, health_body, health_ms = uds_call(http_get("/healthz"))
health_ok = health_status == 200 and b'"ok":true' in health_body

token = admin_token()
chat_payload = {
    "model": MODEL_ID,
    "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
    "max_tokens": 8,
    "temperature": 0,
    "stream": False,
}
chat_status, chat_body, chat_ms = uds_call(http_chat(chat_payload, token))
try:
    chat_json = json.loads(chat_body.decode("utf-8", "replace"))
except (UnicodeDecodeError, json.JSONDecodeError):
    chat_json = {}
usage = chat_json.get("usage") or {}
timings = chat_json.get("timings") or {}
chat_ok = chat_status == 200 and usage.get("prompt_tokens") is not None

print(f"model={MODEL}")
print(f"model_bytes={size}")
print(f"mem_available_bytes={available}")
print(f"mmap_ms={round(mmap_ms, 3)}")
print(f"resident_before={before_live}/{before_pages} pct={round(before_pct, 3)}")
print(f"mmap_load_ms={round(load_ms, 3)}")
print(f"locked={1 if locked else 0} lock_errno={lock_errno}")
print(f"resident_after_load={after_load_live}/{after_load_pages} pct={round(after_load_pct, 3)}")
print(f"mmap_read_ms={round(read_ms, 3)}")
print(f"mmap_read_gbs={round(read_gbs, 3)}")
print(f"checksum_sha256={checksum}")
print(f"first_u64=0x{first_word:016x}")
print(f"last_u64=0x{last_word:016x}")
print(f"resident_after_read={after_read_live}/{after_read_pages} pct={round(after_read_pct, 3)}")
print(f"uds_health_status={health_status} uds_health_ms={round(health_ms, 3)}")
print(f"uds_chat_status={chat_status} uds_chat_ms={round(chat_ms, 3)}")
print(f"uds_prompt_tokens={usage.get('prompt_tokens')}")
print(f"uds_completion_tokens={usage.get('completion_tokens')}")
print(f"uds_prompt_ms={timings.get('prompt_ms')}")
print(f"uds_predicted_ms={timings.get('predicted_ms')}")
print(f"uds_tok_s={timings.get('predicted_per_second')}")
print(f"uds_content={json.dumps((chat_json.get('choices') or [{}])[0].get('message', {}).get('content'))}")

all_resident = after_read_pct >= 99.9
bench_ok = all_resident and read_ms > 0 and health_ok and chat_ok
print("BENCH_OK=1" if bench_ok else "BENCH_OK=0")
sys.exit(0 if bench_ok else 1)
