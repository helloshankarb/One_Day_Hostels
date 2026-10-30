import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config.ts';
import { HttpError } from './http.ts';

export const photoDir = path.join(config.uploadsDir, 'photos');
export const docDir = path.join(config.uploadsDir, 'private');
fs.mkdirSync(photoDir, { recursive: true });
fs.mkdirSync(docDir, { recursive: true });

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

function storage(dir: string) {
  return multer.diskStorage({
    destination: dir,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXT[file.mimetype]),
  });
}

export const photoUpload = multer({
  storage: storage(photoDir),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, 'Photos must be JPG, PNG or WebP'));
  },
});

export const docUpload = multer({
  storage: storage(docDir),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, 'Documents must be PDF, JPG or PNG'));
  },
});

/** Checks magic bytes so a renamed file cannot masquerade as an image/PDF. Removes the file when invalid. */
export function assertFileSignature(filePath: string, mime: string) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  const ok =
    (mime === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8) ||
    (mime === 'image/png' && buf.subarray(0, 4).toString('hex') === '89504e47') ||
    (mime === 'image/webp' && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') ||
    (mime === 'application/pdf' && buf.subarray(0, 4).toString() === '%PDF');
  if (!ok) {
    fs.rmSync(filePath, { force: true });
    throw new HttpError(400, 'The uploaded file is not a valid image or PDF');
  }
}

export function removeUpload(url: string) {
  if (!url.startsWith('/uploads/photos/')) return;
  fs.rmSync(path.join(photoDir, path.basename(url)), { force: true });
}
