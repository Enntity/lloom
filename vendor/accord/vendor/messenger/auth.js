import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fail } from "./errors.js";

const TOKEN_PREFIX = "enm_";

export function createToken() {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function tokenHash(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

export function tokenHint(token) {
  return String(token || "").slice(0, 12);
}

export function bearerToken(request) {
  const authorization = String(request.headers.authorization || "");
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) fail("AUTH_REQUIRED", "A bearer credential is required", 401);
  return match[1];
}

export function safeHashEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
