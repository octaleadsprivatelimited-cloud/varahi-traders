import crypto from "node:crypto";
import path from "node:path";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import multer from "multer";
import sharp, { type Metadata, type Sharp } from "sharp";
import type express from "express";
import { AppError } from "./errors.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const PRODUCT_IMAGE_MAX_EDGE = 1_600;
const PRODUCT_THUMBNAIL_EDGE = 480;
const acceptedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
]);
const acceptedFormats = new Set(["jpeg", "png", "webp", "avif", "heif"]);
const generatedImagePattern =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.webp$/i;

const parser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    fields: 5,
    parts: 6,
  },
  fileFilter: (_req, file, done) =>
    acceptedMimeTypes.has(file.mimetype)
      ? done(null, true)
      : done(
          new AppError(
            415,
            "IMAGE_TYPE_NOT_SUPPORTED",
            "Upload a JPEG, PNG, WebP, AVIF or HEIC image",
          ),
        ),
}).single("image");

export const productImageUpload: express.RequestHandler = (req, res, next) =>
  parser(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError)
      return next(
        new AppError(
          error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
          error.code === "LIMIT_FILE_SIZE"
            ? "IMAGE_TOO_LARGE"
            : "UPLOAD_INVALID",
          error.code === "LIMIT_FILE_SIZE"
            ? "Image must be 10 MB or smaller"
            : "The image upload is invalid",
        ),
      );
    return next(error);
  });

async function readMetadata(image: Sharp): Promise<Metadata> {
  try {
    return await image.metadata();
  } catch {
    throw new AppError(
      415,
      "IMAGE_CONTENT_INVALID",
      "The uploaded file is not a supported image",
    );
  }
}

export async function convertProductImage(
  buffer: Buffer,
  uploadDirectory: string,
  publicBaseUrl: string,
) {
  const id = crypto.randomUUID();
  const directory = path.resolve(uploadDirectory);
  const mainName = `${id}.webp`;
  const thumbName = `${id}-thumb.webp`;
  const mainPath = path.join(directory, mainName);
  const thumbPath = path.join(directory, thumbName);
  const mainTemp = `${mainPath}.tmp`;
  const thumbTemp = `${thumbPath}.tmp`;

  await mkdir(directory, { recursive: true });
  try {
    const image = sharp(buffer, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "warning",
      sequentialRead: true,
    }).rotate();
    const metadata = await readMetadata(image);
    if (
      !metadata.width ||
      !metadata.height ||
      !metadata.format ||
      !acceptedFormats.has(metadata.format)
    )
      throw new AppError(
        415,
        "IMAGE_CONTENT_INVALID",
        "The uploaded file is not a supported image",
      );

    // Sharp strips EXIF/IPTC metadata by default. Capping the long edge and using
    // a picture-tuned WebP encoding keeps catalog images small without upscaling.
    const main = await image
      .clone()
      .resize({
        width: PRODUCT_IMAGE_MAX_EDGE,
        height: PRODUCT_IMAGE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({
        quality: 78,
        alphaQuality: 80,
        effort: 5,
        smartSubsample: true,
        preset: "picture",
      })
      .toBuffer({ resolveWithObject: true });
    const thumbnail = await image
      .clone()
      .resize({
        width: PRODUCT_THUMBNAIL_EDGE,
        height: PRODUCT_THUMBNAIL_EDGE,
        fit: "cover",
        position: "attention",
        withoutEnlargement: true,
      })
      .webp({
        quality: 72,
        alphaQuality: 76,
        effort: 5,
        smartSubsample: true,
        preset: "picture",
      })
      .toBuffer({ resolveWithObject: true });

    await Promise.all([
      writeFile(mainTemp, main.data, { flag: "wx" }),
      writeFile(thumbTemp, thumbnail.data, { flag: "wx" }),
    ]);
    await Promise.all([
      rename(mainTemp, mainPath),
      rename(thumbTemp, thumbPath),
    ]);

    const base = publicBaseUrl.replace(/\/$/, "");
    return {
      url: `${base}/${mainName}`,
      thumbnailUrl: `${base}/${thumbName}`,
      width: main.info.width,
      height: main.info.height,
      bytes: main.info.size,
      format: "webp" as const,
      thumbnail: {
        width: thumbnail.info.width,
        height: thumbnail.info.height,
        bytes: thumbnail.info.size,
      },
      original: {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        bytes: buffer.length,
      },
    };
  } catch (error) {
    await Promise.allSettled([
      unlink(mainTemp),
      unlink(thumbTemp),
      unlink(mainPath),
      unlink(thumbPath),
    ]);
    if (error instanceof AppError) throw error;
    throw new AppError(
      422,
      "IMAGE_PROCESSING_FAILED",
      "The image could not be processed. Try exporting it again or upload another file",
    );
  }
}

function localGeneratedImageNames(url: string, publicBaseUrl: string) {
  try {
    const base = new URL(
      publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`,
    );
    const candidate = new URL(url);
    if (candidate.origin !== base.origin) return [];
    if (!candidate.pathname.startsWith(base.pathname)) return [];
    const relativeName = decodeURIComponent(
      candidate.pathname.slice(base.pathname.length),
    );
    const match = generatedImagePattern.exec(relativeName);
    if (!match) return [];
    return [`${match[1]}.webp`, `${match[1]}-thumb.webp`];
  } catch {
    return [];
  }
}

/** Remove only UUID-named files produced by convertProductImage. */
export async function removeConvertedProductImage(
  url: string,
  uploadDirectory: string,
  publicBaseUrl: string,
) {
  const directory = path.resolve(uploadDirectory);
  const names = localGeneratedImageNames(url, publicBaseUrl);
  if (!names.length) return false;
  await Promise.all(
    names.map(async (name) => {
      try {
        await unlink(path.join(directory, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }),
  );
  return true;
}
