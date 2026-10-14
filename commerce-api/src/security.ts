import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { RequestHandler } from "express";
import { AppError } from "./errors.js";
export type Principal = {
  sub: string;
  role: string;
  permissions: string[];
  authVersion?: number;
};
declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}
export function signAccessToken(principal: Principal, secret: string) {
  return jwt.sign(principal, secret, {
    algorithm: "HS256",
    expiresIn: "15m",
    issuer: "sri-varahi-traders-commerce",
    audience: "store-api",
  });
}
export function authenticate(secret: string): RequestHandler {
  return (req, _res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token)
      return next(
        new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication required"),
      );
    try {
      req.principal = jwt.verify(token, secret, {
        algorithms: ["HS256"],
        issuer: "sri-varahi-traders-commerce",
        audience: "store-api",
      }) as Principal;
      next();
    } catch {
      return next(
        new AppError(401, "INVALID_TOKEN", "Session is invalid or expired"),
      );
    }
  };
}
export function optionalAuthenticate(secret: string): RequestHandler {
  const required = authenticate(secret);
  return (req, res, next) => {
    if (!req.headers.authorization) return next();
    return required(req, res, next);
  };
}
export function authorize(...permissions: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.principal)
      return next(
        new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication required"),
      );
    if (
      req.principal.permissions.includes("*") ||
      permissions.every((x) => req.principal!.permissions.includes(x))
    )
      return next();
    next(
      new AppError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      ),
    );
  };
}
export class SecretVault {
  private key: Buffer;
  constructor(encoded: string) {
    this.key = crypto.createHash("sha256").update(encoded).digest();
  }
  encrypt(value: unknown) {
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
  decrypt<T>(value: string): T {
    const data = Buffer.from(value, "base64"),
      iv = data.subarray(0, 12),
      tag = data.subarray(12, 28),
      body = data.subarray(28),
      decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"),
    ) as T;
  }
  mask(value: string) {
    return value.length < 5
      ? "••••"
      : `${"•".repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`;
  }
}
export function verifyHmac(raw: Buffer, signature: string, secret: string) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(raw)
    .digest("hex");
  const a = Buffer.from(expected),
    b = Buffer.from(signature || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(input: Buffer) {
  let bits = ""; for (const byte of input) bits += byte.toString(2).padStart(8, "0");
  let output = ""; for (let index = 0; index < bits.length; index += 5) output += base32Alphabet[parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  return output;
}
function base32Decode(input: string) {
  let bits = ""; for (const character of input.replace(/=+$/g, "").toUpperCase()) { const value = base32Alphabet.indexOf(character); if (value < 0) throw new Error("Invalid base32 secret"); bits += value.toString(2).padStart(5, "0"); }
  const bytes: number[] = []; for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}
export function verifyTotp(secret: string, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return false;
  for (let offset = -1; offset <= 1; offset++) {
    if (generateTotpCode(secret, now + offset * 30_000) === code) return true;
  }
  return false;
}
export function generateTotpCode(secret: string, now = Date.now()) {
  const counter = Math.floor(now / 30_000), buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest(), index = digest[digest.length - 1]! & 15;
  const value = ((digest[index]! & 0x7f) << 24) | ((digest[index + 1]! & 0xff) << 16) | ((digest[index + 2]! & 0xff) << 8) | (digest[index + 3]! & 0xff);
  return String(value % 1_000_000).padStart(6, "0");
}
