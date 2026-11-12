import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  identityHeaders,
  identityMetadata,
  loadIdentity,
  packageVersion,
  PROTOCOL,
  validateIdentity,
} from "../src/identity.ts";

/**
 * The identity is the one fact every response carries. These tests pin the
 * parts that a client relies on: the name, the version, the protocol, and the
 * rule that the build number comes from package.json rather than from a
 * hand-edited copy of the manifest.
 */
function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lama-identity-"));
}

test("the manifest supplies the name, the version and the protocol", () => {
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, "identity.json"),
    JSON.stringify({
      system_identity: {
        name: "lama",
        version: "0.0.1",
        tagline: "Stock llama.cpp, sovereign locally.",
        protocol: "SSI-Core/1",
        branding: { owner: "Sahon Srabon", organization: "Developer Zone" },
        license: "Proprietary - Local Freedom Protocol",
      },
    }),
  );
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));

  const identity = loadIdentity(root);
  assert.equal(identity.name, "lama");
  // package.json is the single source of truth for the build number.
  assert.equal(identity.version, "9.9.9");
  assert.equal(identity.protocol, "SSI-Core/1");
  assert.equal(identity.tagline, "Stock llama.cpp, sovereign locally.");
});

test("a missing manifest falls back to the default identity", () => {
  const root = tempRoot();
  const identity = loadIdentity(root);
  assert.equal(identity.name, "lama");
  assert.equal(identity.protocol, PROTOCOL);
  assert.ok(identity.version.length > 0);
});

test("a manifest without a protocol still gets the current one", () => {
  const identity = validateIdentity({
    system_identity: {
      name: "lama",
      version: "1.0.0",
      branding: { owner: "Sahon Srabon", organization: "Developer Zone" },
      license: "Proprietary - Local Freedom Protocol",
    },
  });
  assert.equal(identity.protocol, PROTOCOL);
});

test("a manifest without a name, version or owner is refused", () => {
  assert.throws(() => validateIdentity({ system_identity: { name: "x" } }), /version/);
  assert.throws(
    () => validateIdentity({ system_identity: { version: "1", branding: {}, license: "l" } }),
    /name/,
  );
});

test("every response header carries the name, the version and the protocol", () => {
  const headers = identityHeaders({
    name: "lama",
    version: "0.2.0",
    tagline: "",
    protocol: "SSI-Core/1",
    branding: { owner: "Sahon Srabon", organization: "Developer Zone" },
    license: "Proprietary - Local Freedom Protocol",
  });
  assert.equal(headers["x-system-identity"], "lama");
  assert.equal(headers["x-system-version"], "0.2.0");
  assert.equal(headers["x-system-protocol"], "SSI-Core/1");
  assert.equal(headers["x-system-owner"], "Sahon Srabon");
  assert.ok(headers["x-powered-by"]);
});

test("the system metadata repeats the same identity as the headers", () => {
  const identity = {
    name: "lama",
    version: "0.2.0",
    tagline: "Stock llama.cpp, sovereign locally.",
    protocol: "SSI-Core/1",
    branding: { owner: "Sahon Srabon", organization: "Developer Zone" },
    license: "Proprietary - Local Freedom Protocol",
  };
  const meta = identityMetadata(identity);
  assert.equal(meta.name, identity.name);
  assert.equal(meta.version, identity.version);
  assert.equal(meta.protocol, identity.protocol);
  assert.equal(meta.owner, identity.branding.owner);
});

test("packageVersion reads the build number and survives a broken manifest", () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "3.2.1" }));
  assert.equal(packageVersion(root), "3.2.1");

  fs.writeFileSync(path.join(root, "package.json"), "{ not json");
  assert.equal(typeof packageVersion(root), "string");
});
