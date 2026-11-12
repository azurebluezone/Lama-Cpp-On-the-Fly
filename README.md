# Lama-Cpp-On-the-Fly

**আপনার নিজের কম্পিউটারে একটা AI চালু করুন — ইন্টারনেট ছাড়াই।**

এটা [llama.cpp](https://github.com/ggml-org/llama.cpp)-এর একটা সহজ খাম। llama.cpp হলো Meta-এর
Llama AI মডেল ফ্রি, দ্রুত, অফলাইন চালানোর ইঞ্জিন। এই খামটা সেই ইঞ্জিনটাকে
ইনস্টল করে, ডেটাবেস তৈরি করে, ফাইল আই ডাউনলোড করে, সার্ভিস চালু করে এবং একটা
ওয়েব-পেজ দেয় — যেখান থেকে আপনি মডেল লোড করবেন, আর OpenCode, Claude Code, VS Code
বা যেকোনো AI অ্যাপ এটার সাথে কথা বলতে পারবে।

| কী পাবেন | বিবরণ |
| --- | --- |
| **এক কমান্ডে ইনস্টল** | একটা লাইন কপি-পেস্ট করলেই সব হয়ে যায় |
| **নিজের সার্ভার** | আপনার মেশিনেই চলে, কোনো ক্লাউড নয়, ইন্টারনেট লাগে না |
| **সব লগ** | কোন মডেল, কোন প্রোটোকল, কে পাঠিয়েছে, কত সময় লেগেছে — সব ফাইলে |
| **GBNF Grammar** | মডেলকে বলে দিন উত্তর একটা নির্দিষ্ট ফরম্যাটে দিতে হবে |
| **MCP টুল** | মডেল আপনার ফাইল পড়তে, লিখতে ও কমান্ড চালাতে পারে |

---

## ⚡ শুরু করার জন্য (৩ মিনিট)

আপনার কম্পিউটারে **টার্মিনাল** খুলুন (Linux: Terminal, macOS: Terminal,
Windows: PowerShell), নিচের **একটা** কমান্ড কপি করে পেস্ট করুন, আর Enter চাপুন:

```bash
curl -fsSL https://raw.githubusercontent.com/azurebluezone/Lama-Cpp-On-the-Fly/main/scripts/bootstrap.sh | bash
```

ব্যস। এরপর স্ক্রিনে প্রতিটা ধাপের ফল দেখতে পাবেন:

```
lama bootstrap
  repo : azurebluezone/Lama-Cpp-On-the-Fly@main
  dest : /home/আপনার-নাম/lama
  node : downloading node-v24...
  fetch: https://github.com/.../archive/main.tar.gz
  code : updated (kept .env, data/, models/, logs/, identity.json)

running scripts/install.mjs
[ok]  node.js >= 24
[ok]  project dependencies
[ok]  llama.cpp engine
[ok]  model file
[ok]  environment, database, seeds
[ok]  TLS certificate check
[ok]  system services
[ok]  load newest model
[ok]  admin URL in browser

DONE — gateway: http://127.0.0.1:5252
```

সব শেষ হলে **আপনার ব্রাউজারে এই ঠিকানাটা খুলুন**:

```
http://127.0.0.1:5252/admin
```

প্রথমবার একটা **টোকেন** চাইবে। সেটা এখান থেকে দেখুন:

```bash
grep '^LAMA_ADMIN_TOKEN=' ~/lama/.env
```

যে লাইনের পরে যে লম্বা লেখাটা আছে, সেটাই টোকেন। কপি করে পেজে বসিয়ে দিন — আপনি
ভেতরে ঢুকে গেছেন।

### সার্ভারের ঠিকানা

| ঠিকানা | কী আছে |
| --- | --- |
| `http://127.0.0.1:5252/admin` | ওয়েব-পেজ (এখানেই সব নিয়ন্ত্রণ) |
| `http://127.0.0.1:5252/v1` | AI অ্যাপগুলোর জন্য (OpenAI-র মতো) |
| `https://127.0.0.1:9931` | HTTPS (TLS) — শুধু পরে চালু করলে |

---

## 🖥️ পেজে কী কী করবেন

প্রায় সব কাজ ব্রাউজারের পেজ থেকেই হয়, টার্মিনাল লাগে না:

| ট্যাব | কী করবেন |
| --- | --- |
| **Overview** | সবকিছুর সারাংশ — ইঞ্জিন চালু আছে কিনা, কত RAM ব্যবহার হচ্ছে |
| **Model List** | মডেল দেখুন, নতুন মডেল ডাউনলোড করুন, **Load** চাপুন |
| **Playground** | সরাসরি মডেলের সাথে কথা বলে দেখুন |
| **Logs** | প্রতিটি অনুরোধ দেখুন — কত সময় লেগেছে, কত টোকেন ব্যবহার হয়েছে |
| **Transports** | HTTP, HTTPS আর Unix socket — কোনটা দিয়ে কী চলছে |
| **MCP Servers** | টুল সার্ভার যোগ করুন, চালু/বন্ধ করুন |
| **Prompts** | সিস্টেম প্রম্পট বদলান (নাম-মালিকানা বদলানো যায় না — ইচ্ছাকৃত) |
| **Docs** | আপনার অ্যাপগুলো কীভাবে কানেক্ট করবে — সেখানে কোড কপি করার জন্য তৈরি |

**একটা মডেল চালু করতে:** Model List ট্যাব → মডেলটা খুঁজুন → **Load** বোতাম চাপুন →
অপেক্ষা করুন → Playground ট্যাবে গিয়ে লিখুন "হ্যালো" → Enter।

---

## 🔌 নিজের AI অ্যাপে যুক্ত করা

পেজের **Docs** ট্যাবে প্রতিটি অ্যাপের জন্য তৈরি কোড আছে (কপি-পেস্ট করার মতো)।
সবচেয়ে সাধারণ তিনটি:

**OpenCode** — `opencode.json`-এ এই ব্লক যোগ করুন:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "lama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Lama (local)",
      "options": { "baseURL": "http://127.0.0.1:5252/v1" },
      "models": { "deepseek-v4-pro": { "name": "DeepSeek V4 Pro (local)" } }
    }
  }
}
```

**Claude Code**:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:5252
export ANTHROPIC_AUTH_TOKEN=$(grep '^LAMA_ADMIN_TOKEN=' ~/lama/.env | cut -d= -f2)
export ANTHROPIC_MODEL=deepseek-v4-pro
```

**যেকোনো OpenAI-অ্যাপ (curl দিয়ে পরীক্ষা)**:

```bash
curl http://127.0.0.1:5252/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"Hello"}]}'
```

---

## 🎯 GBNF Grammar — উত্তর নির্দিষ্ট ফরম্যাটে আনা

কখনো দরকার হয় বলে মডেলকে বলা: "শুধু JSON দাও", "শুধু একটা শব্দ দাও", "ফোন নম্বর দাও"।
llama.cpp এটা নিজেই করে — উত্তর পড়ে ঠিক করে না, **উত্তর তৈরি করার সময়ই** প্রতিবন্ধ করে।

প্রতিটি অনুরোধে `grammar` ফিল্ড দিলেই কাজ করে:

```bash
curl http://127.0.0.1:5252/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [{"role": "user", "content": "তোমার নাম কী?"}],
    "grammar": "root ::= \"{\\\"answer\\\": \\\"\" [a-z]+ \"\\\"}\""
  }'
```

উত্তর আসবে ঠিক এভাবেই: `{"answer": "hello"}`

একটা মডেলের জন্য **সবসময়** grammar চালু রাখতে চাইলে সেই মডেলের
`metadata_json`-এ `grammar_file` দিন:

```json
{ "grammar_file": "grammars/json-object.gbnf" }
```

তাহলে ইঞ্জিন ওই মডেলের প্রতিটি উত্তরে নিজে থেকেই grammar মেনে চলবে।
রেডিমেড grammar আছে `grammars/` ফোল্ডারে: `json-object.gbnf` (যেকোনো JSON),
`answer-only.gbnf` (একটাই ছোট শব্দ)।

---

## 🧠 কী কী ফিচার

### একটাই পরিচয়, সব জায়গায়
প্রতিটি উত্তরে এই হেডারগুলো থাকে:

```
x-system-identity: lama
x-system-version: 0.2.0
x-system-protocol: SSI-Core/1
x-system-owner: Sahon Srabon
```

সিস্টেম প্রম্পটেও একই পরিচয় বাঁধা থাকে, তাই মডেল নিজের মালিক বদলে দিতে পারে না।

### আলাদা আলাদা লগ
`logs/` ফোল্ডারে প্রতিটি ট্রান্সপোর্টের আলাদা লগ আর প্রতিটি মডেলের আলাদা লগ:

```
logs/transport-http.log      ← HTTP-তে আসা প্রতিটি অনুরোধ
logs/transport-uds.log        ← Unix socket-এ আসা প্রতিটি অনুরোধ
logs/model-deepseek-v4-pro.log ← এই মডেলের প্রতিটি উত্তর
```

প্রতিটি লাইনে একটা JSON — কী মডেল, কোন প্রোটোকল, কে পাঠিয়েছে, MCP টুল চলেছে কিনা,
কত সময় লেগেছে, কত টোকেন ব্যবহার হয়েছে:

```json
{"at":"2026-11-12T01:28:26.744Z","transport":"http","model":"deepseek-v4-pro",
 "protocol":"openai","client":"curl","mcp_tool_executed":false,"mcp_tools":[],
 "cache_hit":true,"duration_ms":3,"prompt_tokens":17,"completion_tokens":2,
 "total_tokens":19}
```

পড়তে:

```bash
tail -f logs/transport-http.log | jq .
```

### দ্রুত ক্যাশ
একই প্রশ্ন আবার আসলে ইঞ্জিন আর ডাকা হয় না — উত্তর ক্যাশ থেকে সাথে সাথে ফেরত আসে
(উত্তরে `x-lama-cache: hit` হেডার দেখা যায়)।

### বড় ডেটা থেকে দরকারি অংশই
হাজার হাজার রেকর্ড থাকলে সবগুলো মডেলের পেটে ঢোকানোর দরকার নেই।
`/api/corpus` দিয়ে ডেটা জমা রাখুন, তারপর মডেল শুধু প্রাসঙ্গিক ১-২টি রেকর্ড পায়:

```bash
curl -X POST http://127.0.0.1:5252/api/corpus \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"c1","text":"আমি ঢাকায় থাকি।"}'
```

---

## 🛑 থামানো ও আপডেট করা

```bash
systemctl --user stop lama-gateway lama-engine   # থামানো
systemctl --user start lama-gateway              # আবার চালু
cd ~/lama && git pull && npm install              # আপডেট
```

লগ দেখা:

```bash
journalctl --user -u lama-gateway -f              # লাইভ সার্ভার লগ
```

---

## 🧰 কমান্ড লাইনে (ঐচ্ছিক)

```bash
node src/main.ts doctor          # সব কিছু ঠিক আছে কিনা দেখুন
node src/main.ts engine status   # ইঞ্জিনের অবস্থা
node src/main.ts engine load <model-id> --ttl 4
node src/main.ts service status user
npm run check                    # টাইপ-চেক + টেস্ট
```

---

## ❓ সমস্যা হলে

| সমস্যা | সমাধান |
| --- | --- |
| `node: command not found` | টার্মিনাল বন্ধ করে আবার খুলুন, তারপর `node -v` চেক করুন |
| পোর্ট ব্যবহার আছে | `.env`-এ `LAMA_GATEWAY_PORT=5253` বদলে দিন |
| ইঞ্জিন চালু হচ্ছে না | `journalctl --user -u lama-engine -n 50` দেখুন |
| মডেল ডাউনলোড হয়নি | Model List → **Discover** → ডাউনলোড → **Load** |
| `403` পেজে | ব্রাউজারে `localhost:5252` লিখুন, `127.0.0.1` নয় |
| আবার ইনস্টল করতে চান | উপরের এক কমান্ড আবার চালান — আগের সব ডেটা, মডেল আর টোকেন অক্ষত থাকবে |

---

## 🧱 কী কী ভেতরে আছে

```
src/            ম্যানেজার (ইঞ্জিন চালু, ডেটাবেস, ট্রান্সপোর্ট, admin API)
prompts/        সিস্টেম প্রম্পট (পরিচয় এখানে বাঁধা)
grammars/       রেডিমেড GBNF grammar
db/seed/        ডেটাবেসের প্রাথমিক সারি
web/            ওয়েব-পেজ (কোনো বিল্ড স্টেপ নেই)
scripts/        ইনস্টলার, যাচাই স্ক্রিপ্ট
test/           টেস্ট স্যুট
identity.json   পরিচয়ের ফাইল (পড়া-শুধু, মোড 0444)
```

**প্রযুক্তিঃ** TypeScript (Node 24), কোনো runtime dependency নেই। llama.cpp নিজে MIT লাইসেন্সের।

## 📜 লাইসেন্স

Proprietary — Local Freedom Protocol (llama.cpp নিজে আলাদা, MIT)। বিস্তারিত: `identity.json`।
