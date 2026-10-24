// One S3 client for Cloudflare R2, shared by everything that stores an object.
//
// R2 speaks the S3 API, so this is the AWS SDK pointed somewhere else: `region`
// is the literal string "auto" because R2 has no regions to choose between —
// placement is a bucket-creation hint (both our buckets are APAC) and never a
// request parameter — and the endpoint carries the account id.
//
// Why R2 at all, when Supabase Storage already worked: egress. Supabase bills
// every byte read out of a shared allowance that the *database* also draws on,
// and on 27 Aug 2026 the project sat at 4.63 GB of a 5 GB month. R2 charges
// nothing for egress at any volume, which takes media growth off a metered
// line permanently rather than buying headroom that fills up again.
//
// Built lazily rather than at import time, and this is deliberate. Reaching for
// env vars at module scope is what makes lib/waSupport.ts untestable — anything
// importing it pays for Supabase and Sanity whether it needs them or not — and
// a module that throws on a missing variable at import throws during the build,
// where the message lands in a deploy log rather than in front of anyone.

import { S3Client } from "@aws-sdk/client-s3";

let client: S3Client | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not configured`);
  return value;
}

/** The shared client. Cached, so Fluid Compute's reused instances pay for the
 *  credential setup once rather than per invocation. */
export function r2(): S3Client {
  if (client) return client;

  client = new S3Client({
    region: "auto",
    endpoint: `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
  });

  return client;
}

/** Encrypted database + storage snapshots. Private, and never served to anyone. */
export const backupBucket = (): string => required("R2_BACKUP_BUCKET");

/** Customer media — WhatsApp images and return photos. Private; the admin panel
 *  mints a short-lived signed URL to show one, exactly as the Supabase buckets
 *  did. See supabase-migration-wa-media.sql for why a path is stored and not a URL. */
export const mediaBucket = (): string => required("R2_MEDIA_BUCKET");
