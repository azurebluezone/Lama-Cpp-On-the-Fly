import fs from "node:fs";
import path from "node:path";

/**
 * The single wire protocol of this build. Every response header and every
 * system prompt carries it, so a client can tell which contract it is talking
 * to without guessing from the version alone.
 */
export const PROTOCOL = "SSI-Core/1";

export interface SystemIdentity {
  name: string;
  version: string;
  tagline: string;
  /** Wire protocol this build speaks, e.g. "SSI-Core/1". Always present. */
  protocol: string;
  branding: {
    owner: string;
    organization: string;
    address?: string;
    location?: string;
  };
  contact?: {
    phone?: string;
    email?: string;
    website?: string;
  };
  license: string;
}

const DEFAULT_IDENTITY: SystemIdentity = {
  name: "lama",
  version: "0.1.0",
  tagline: "Stock llama.cpp, sovereign locally.",
  protocol: PROTOCOL,
  branding: {
    owner: "Sahon Srabon",
    organization: "Developer Zone",
    location: "Dhaka, Bangladesh",
  },
  contact: { website: "https://zombiecoder.my.id/" },
  license: "Proprietary - Local Freedom Protocol",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateIdentity(value: unknown): SystemIdentity {
  if (!isRecord(value)) throw new Error("identity.json must contain an object");
  const raw = isRecord(value.system_identity) ? value.system_identity : value;
  const branding = isRecord(raw.branding) ? raw.branding : {};
  const contact = isRecord(raw.contact) ? raw.contact : {};
  const text = (input: unknown, field: string): string => {
    if (typeof input !== "string" || !input.trim()) throw new Error(`identity.${field} is required`);
    return input.trim();
  };
  const identity: SystemIdentity = {
    name: text(raw.name, "name"),
    version: text(raw.version, "version"),
    tagline: typeof raw.tagline === "string" ? raw.tagline : "",
    protocol: text(raw.protocol ?? PROTOCOL, "protocol"),
    branding: {
      owner: text(branding.owner, "branding.owner"),
      organization: text(branding.organization, "branding.organization"),
      ...(typeof branding.location === "string" ? { location: branding.location } : {}),
      ...(typeof branding.address === "string" ? { address: branding.address } : {}),
    },
    license: text(raw.license, "license"),
  };
  const phone = typeof contact.phone === "string" ? contact.phone : undefined;
  const email = typeof contact.email === "string" ? contact.email : undefined;
  const website = typeof contact.website === "string" ? contact.website : undefined;
  if (phone || email || website) {
    identity.contact = {
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
      ...(website ? { website } : {}),
    };
  }
  return identity;
}

export function identityPath(root: string): string {
  return path.join(root, "identity.json");
}

/**
 * The package version is the single source of truth for the build number.
 * identity.json may pin its own version, but a stale copy would put a wrong
 * number in every response header, so the manifest always wins.
 */
export function packageVersion(root: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof raw.version === "string" && raw.version.trim()) return raw.version.trim();
  } catch {
    // A missing or broken package.json falls back to the manifest value.
  }
  return DEFAULT_IDENTITY.version;
}

export function loadIdentity(root: string): SystemIdentity {
  const file = identityPath(root);
  const manifest = fs.existsSync(file)
    ? validateIdentity(JSON.parse(fs.readFileSync(file, "utf8")) as unknown)
    : DEFAULT_IDENTITY;
  // The build number comes from package.json, never from a hand-edited copy.
  return { ...manifest, version: packageVersion(root) };
}

export function ensureIdentityFile(root: string): { path: string; created: boolean } {
  const file = identityPath(root);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${JSON.stringify({ system_identity: DEFAULT_IDENTITY }, null, 2)}\n`, { mode: 0o444 });
    return { path: file, created: true };
  }
  try {
    fs.chmodSync(file, 0o444);
  } catch {
    // read-only enforcement is best effort on filesystems without POSIX modes
  }
  return { path: file, created: false };
}

/**
 * The identity headers every response carries. The name, the version and the
 * protocol travel together, so a client never has to infer one from another.
 */
export function identityHeaders(identity: SystemIdentity): Record<string, string> {
  return {
    "x-powered-by": `${identity.name}-by-${identity.branding.owner.replace(/\s+/g, "")}`,
    "x-system-identity": identity.name,
    "x-system-version": identity.version,
    "x-system-protocol": identity.protocol,
    "x-system-owner": identity.branding.owner,
  };
}

/**
 * The identity block the system metadata enforces: the same facts the headers
 * carry, in a shape an API consumer can read as data instead of parsing
 * headers.
 */
export function identityMetadata(identity: SystemIdentity): Record<string, unknown> {
  return {
    name: identity.name,
    version: identity.version,
    protocol: identity.protocol,
    tagline: identity.tagline,
    owner: identity.branding.owner,
    organization: identity.branding.organization,
    license: identity.license,
  };
}
