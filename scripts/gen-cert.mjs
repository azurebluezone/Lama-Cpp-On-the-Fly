#!/usr/bin/env node
/**
 * Generate the self-signed certificate llama.cpp uses for engine-native TLS.
 * Node built-ins only; the X.509 math is done by the system `openssl` binary.
 *
 *   node scripts/gen-cert.mjs              # create certs/localhost-{key,cert}.pem
 *   node scripts/gen-cert.mjs --force      # overwrite an existing pair
 *   node scripts/gen-cert.mjs --days 3650  # custom validity (default 825)
 *
 * After it runs, put the two printed lines into .env and restart the manager.
 * The certificate is self-signed on purpose: the engine is loopback-only, and
 * the manager connects with rejectUnauthorized:false. Do not reuse this pair
 * for anything that faces a network.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const daysIdx = args.indexOf("--days");
const days = daysIdx !== -1 ? Number(args[daysIdx + 1]) || 825 : 825;

const dir = path.join(LAMA, "certs");
const keyPath = path.join(dir, "localhost-key.pem");
const certPath = path.join(dir, "localhost-cert.pem");

const say = (m) => process.stdout.write(`gen-cert: ${m}\n`);
const die = (m) => { process.stderr.write(`gen-cert: ${m}\n`); process.exit(1); };

if (fs.existsSync(keyPath) && fs.existsSync(certPath) && !force) {
  say(`certificate already exists — keeping it`);
  say(`  ${keyPath}`);
  say(`  ${certPath}`);
  say("pass --force to regenerate");
  process.exit(0);
}

try {
  execFileSync("openssl", ["version"], { encoding: "utf8" });
} catch {
  die("openssl not found — install it first: sudo apt install openssl");
}

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

// A config file keeps this working on openssl 1.1.1 too (-addext is 3.x only).
const conf = path.join(os.tmpdir(), `lama-openssl-${process.pid}.cnf`);
fs.writeFileSync(conf, `[req]
prompt = no
distinguished_name = dn
x509_extensions = v3
[dn]
CN = localhost
[v3]
subjectAltName = DNS:localhost, IP:127.0.0.1
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
`);

try {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
    "-days", String(days),
    "-keyout", keyPath, "-out", certPath,
    "-config", conf,
  ], { stdio: ["ignore", "ignore", "pipe"] });
} catch (e) {
  die(`openssl failed: ${(e.stderr || e.message).toString().split("\n")[0]}`);
} finally {
  try { fs.unlinkSync(conf); } catch {}
}

fs.chmodSync(keyPath, 0o600);
fs.chmodSync(certPath, 0o600);

const info = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-subject", "-dates", "-ext", "subjectAltName"], { encoding: "utf8" }).trim();
say("created");
say(info.split("\n").map((l) => "  " + l.trim()).join("\n"));
say(`key mode 600: ${keyPath}`);
say("");
say("add these two lines to .env, then restart the manager:");
say(`  LAMA_SSL_KEY=${keyPath}`);
say(`  LAMA_SSL_CERT=${certPath}`);
