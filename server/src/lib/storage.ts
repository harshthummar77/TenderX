import { v2 as cloudinary } from 'cloudinary';
import { env, isTest } from '../config/env.js';
import { sha256 } from './crypto.js';
import { logger } from './logger.js';

/**
 * Object storage (plan 14 §A1).
 *
 * **Not local disk.** Multer writing to `./uploads` works locally and is wiped
 * on every Render redeploy — a vendor's GST certificate would disappear the
 * first time anyone pushes a fix. Object storage is not optional.
 *
 * Cloudinary over S3/R2 because it needs no AWS SDK, no bucket CORS policy and
 * no presign dance: the API receives the bytes and forwards them. The trade-off
 * is that file bytes pass through the API, which is irrelevant at a 10 MB limit.
 *
 * Two adapters behind one interface. The in-memory one is used automatically
 * when Cloudinary is not configured and always under test, so **the test suite
 * needs no network and no credentials** — a suite that silently uploads to a
 * real bucket is a suite nobody can run offline.
 */

export interface StoredObject {
  /** Cloudinary `public_id`, or the in-memory key. */
  storageKey: string;
  sizeBytes: number;
  checksum: string;
}

export interface UploadInput {
  buffer: Buffer;
  /** `tenderbridge/{env}/{ownerType}/{ownerId}/{documentId}-{slug}` */
  storageKey: string;
  mimeType: string;
}

export interface StorageAdapter {
  readonly name: 'cloudinary' | 'memory';
  upload(input: UploadInput): Promise<StoredObject>;
  /** A short-lived URL. Downloads are always brokered by the API first. */
  signedUrl(storageKey: string, expiresInSeconds: number): Promise<string>;
  remove(storageKey: string): Promise<void>;
  /** Only the in-memory adapter can hand bytes back; used by tests. */
  read?(storageKey: string): Buffer | undefined;
}

/** Cloudinary wants `raw` for anything that is not an image or a video. */
const resourceTypeFor = (mimeType: string): 'image' | 'raw' =>
  mimeType.startsWith('image/') ? 'image' : 'raw';

/* -------------------------------------------------------------------------- */
/* In-memory adapter                                                          */
/* -------------------------------------------------------------------------- */

function createMemoryAdapter(): StorageAdapter {
  const files = new Map<string, Buffer>();

  return {
    name: 'memory',

    async upload({ buffer, storageKey }) {
      files.set(storageKey, buffer);
      return {
        storageKey,
        sizeBytes: buffer.byteLength,
        checksum: sha256(buffer.toString('base64')),
      };
    },

    async signedUrl(storageKey, expiresInSeconds) {
      // Shaped like the real thing, including an expiry the test can assert on.
      const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
      return `memory://${storageKey}?expires=${expiresAt}`;
    },

    async remove(storageKey) {
      files.delete(storageKey);
    },

    read(storageKey) {
      return files.get(storageKey);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Cloudinary adapter                                                         */
/* -------------------------------------------------------------------------- */

function createCloudinaryAdapter(): StorageAdapter {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });

  return {
    name: 'cloudinary',

    async upload({ buffer, storageKey, mimeType }) {
      const resourceType = resourceTypeFor(mimeType);

      const result = await new Promise<{ public_id: string; bytes: number }>(
        (resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              public_id: storageKey,
              resource_type: resourceType,
              /*
               * `authenticated` matters: the raw Cloudinary URL is then not
               * publicly guessable, so every download has to come through the
               * API and pass its permission check first (§A3).
               */
              type: 'authenticated',
              overwrite: false,
            },
            (error, uploaded) => {
              if (error || !uploaded) {
                reject(error instanceof Error ? error : new Error('Cloudinary upload failed'));
                return;
              }
              resolve({ public_id: uploaded.public_id, bytes: uploaded.bytes });
            },
          );
          stream.end(buffer);
        },
      );

      return {
        storageKey: result.public_id,
        sizeBytes: result.bytes,
        checksum: sha256(buffer.toString('base64')),
      };
    },

    async signedUrl(storageKey, expiresInSeconds) {
      return cloudinary.utils.private_download_url(storageKey, '', {
        expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
      });
    },

    async remove(storageKey) {
      await cloudinary.uploader.destroy(storageKey, { type: 'authenticated' });
    },
  };
}

/* -------------------------------------------------------------------------- */

const configured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

/**
 * The active adapter. In-memory under test regardless of configuration, so a
 * developer with real credentials in their shell cannot accidentally fill a
 * production bucket by running `npm test`.
 */
export const storage: StorageAdapter =
  isTest || !configured ? createMemoryAdapter() : createCloudinaryAdapter();

if (!isTest && !configured) {
  logger.warn(
    'Cloudinary is not configured; uploads are held in memory and lost on restart',
  );
}

/** How long a download link lives. Short on purpose (§A3). */
export const SIGNED_URL_TTL_SECONDS = 300;

/** Filesystem-safe, collision-resistant, and still recognisable to a human. */
export const slugifyFileName = (fileName: string): string =>
  fileName
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'file';

export const buildStorageKey = (input: {
  ownerType: string;
  ownerId: string;
  documentId: string;
  fileName: string;
}): string =>
  [
    'tenderbridge',
    env.NODE_ENV,
    input.ownerType.toLowerCase(),
    input.ownerId,
    `${input.documentId}-${slugifyFileName(input.fileName)}`,
  ].join('/');
