import crypto from "node:crypto";
import path from "node:path";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { AppError } from "./errors.js";
import type { StorefrontConfig } from "./storefront-config.js";

export const brandingFields = { logo: "logoUrl", footer: "footerLogoUrl", favicon: "faviconUrl" } as const;
export type BrandingKind = keyof typeof brandingFields;
const ownedName = /^brand-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i;

export function brandingFileName(url: string, publicBaseUrl: string) {
  try {
    const base = new URL(`${publicBaseUrl.replace(/\/$/, "")}/`);
    const candidate = new URL(url, base.origin);
    if (candidate.origin !== base.origin || !candidate.pathname.startsWith(base.pathname)) return null;
    const name = decodeURIComponent(candidate.pathname.slice(base.pathname.length));
    return ownedName.test(name) ? name : null;
  } catch { return null; }
}

export async function removeBrandingAsset(url: string, directory: string, base: string) {
  const name = brandingFileName(url, base);
  if (!name) return false;
  try { await unlink(path.join(path.resolve(directory), name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return true;
}
export async function assertBrandingAssetsExist(settings: StorefrontConfig, directory: string, base: string) {
  for (const field of Object.values(brandingFields)) {
    const name = brandingFileName(settings[field], base);
    if (!name) continue;
    try { await stat(path.join(path.resolve(directory), name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new AppError(409, "BRANDING_ASSET_REPLACED", "An uploaded logo has already been replaced. Reload settings before publishing");
      throw error;
    }
  }
}

export function unusedBrandingAssets(previous: StorefrontConfig[], current: StorefrontConfig[], base: string) {
  const names = (settings: StorefrontConfig[]) => settings.flatMap(value =>
    Object.values(brandingFields).map(field => value[field]).filter(Boolean));
  const retained = new Set(names(current).map(url => brandingFileName(url, base)).filter(Boolean));
  return [...new Set(names(previous))].filter(url => {
    const name = brandingFileName(url, base);
    return name && !retained.has(name);
  });
}

export async function convertBrandingAsset(buffer: Buffer, kind: BrandingKind, directory: string, base: string) {
  const name = `brand-${crypto.randomUUID()}.png`;
  const file = path.join(path.resolve(directory), name);
  try {
    const image = sharp(buffer, { limitInputPixels: 40_000_000, failOn: "warning" }).rotate();
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || !["jpeg", "png", "webp", "avif", "heif"].includes(metadata.format || ""))
      throw new AppError(415, "IMAGE_CONTENT_INVALID", "Choose a supported logo image");
    const size = kind === "favicon" ? 256 : 1024;
    const output = await image.resize({ width: size, height: size,
      fit: kind === "favicon" ? "contain" : "inside", withoutEnlargement: kind !== "favicon",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    }).png({ compressionLevel: 9 }).toBuffer();
    await mkdir(directory, { recursive: true });
    await writeFile(file, output, { flag: "wx" });
    return `${base.replace(/\/$/, "")}/${name}`;
  } catch (error) {
    await unlink(file).catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(422, "IMAGE_PROCESSING_FAILED", "The logo could not be processed. Try a PNG, JPEG or WebP image");
  }
}
