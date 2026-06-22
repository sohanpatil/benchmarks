import { Storage } from '@storagesdk/core';
import { s3 } from '@storagesdk/adapters/s3';
import { r2 } from '@storagesdk/adapters/r2';
import { tigris } from '@storagesdk/adapters/tigris';
import type { StorageProviderConfig } from './types.js';

/**
 * Storage provider benchmark configurations.
 *
 * All providers use StorageSDK (https://storagesdk.dev) adapters directly
 * (no ComputeSDK API key).
 */
export const storageProviders: StorageProviderConfig[] = [
  {
    name: 'aws-s3',
    requiredEnvVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_BUCKET'],
    bucket: process.env.S3_BUCKET!,
    createStorage: () => new Storage({
      adapter: s3({
        bucket: process.env.S3_BUCKET!,
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024], // 1MB, 4MB, 10MB, 16MB
  },
  {
    name: 'cloudflare-r2',
    requiredEnvVars: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ACCOUNT_ID'],
    bucket: process.env.R2_BUCKET!,
    createStorage: () => new Storage({
      adapter: r2({
        bucket: process.env.R2_BUCKET!,
        accountId: process.env.R2_ACCOUNT_ID!,
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
  },
  {
    name: 'tigris',
    requiredEnvVars: ['TIGRIS_STORAGE_ACCESS_KEY_ID', 'TIGRIS_STORAGE_SECRET_ACCESS_KEY', 'TIGRIS_STORAGE_BUCKET'],
    bucket: process.env.TIGRIS_STORAGE_BUCKET!,
    createStorage: () => new Storage({
      adapter: tigris({
        bucket: process.env.TIGRIS_STORAGE_BUCKET!,
        accessKeyId: process.env.TIGRIS_STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY!,
        ...(process.env.TIGRIS_STORAGE_ENDPOINT ? { endpoint: process.env.TIGRIS_STORAGE_ENDPOINT } : {}),
      }),
    }),
    fileSizes: [1 * 1024 * 1024, 4 * 1024 * 1024, 10 * 1024 * 1024, 16 * 1024 * 1024],
  },
  //
  // add providers above
];
