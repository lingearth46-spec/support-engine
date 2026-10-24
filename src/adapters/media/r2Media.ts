// Customer media on R2 — WhatsApp photos and return-request evidence.
//
// Why move at all: these files are read out of storage over a Supabase egress
// allowance the *database* also spends, and the weekly backup re-reads every one
// of them. R2 charges nothing for egress ever, so once media lives here the
// backup can go back to nightly without buying anything — which is the RPO the
// project gave up on 23 Aug 2026 to save that same allowance.
//
// One bucket, two prefixes, rather than two buckets. The prefixes are spelled
// exactly like the Supabase buckets they replace (`wa-media`, `return-photos`),
// which is what lets the fallback below take the same string as a bucket name
// and makes an object's old and new locations legible as the same thing.
//
// **Nothing in the database changes.** wa_messages.media_path and
// orders.return_request.photo_paths have always stored a bucket-relative object
// path rather than a URL — see supabase-migration-wa-media.sql, which chose that
// deliberately so a stored link could never expire. That decision is why this
// migration touches no rows at all.

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { r2, mediaBucket } from "@adapters/media/r2";

/**
 * Where new media is written.
 *
 * A code constant, so flipping it is reviewable in a diff — same reasoning as
 * PREPAID_OFFER_ENABLED and the rest.
 *
 * Flipped true on 1 Sep 2026, once scripts/copy-media-to-r2.ts confirmed all
 * 224 existing objects (155 WhatsApp media, 69 return photos) were mirrored in
 * R2 — "All objects present in R2", zero failures. Reads ignore this flag
 * entirely regardless: they try R2 and fall back to Supabase either way, which
 * is what made the flip safe even before that copy finished.
 */
export const MEDIA_ON_R2 = true;

/** Doubles as the Supabase bucket name for the fallback path. */
export const WA_MEDIA = "wa-media";
export const RETURN_PHOTOS = "return-photos";
export type MediaPrefix = typeof WA_MEDIA | typeof RETURN_PHOTOS;

const SIGNED_TTL_SECONDS = 3600;
/** Re-sign once a link has less than five minutes left, so nothing handed to
 *  the panel expires while it is still on screen. */
const REFRESH_BEFORE_MS = 5 * 60_000;

/**
 * Signed links, cached until they are close to expiring.
 *
 * Lifted wholesale from app/api/admin/support/[phone]/route.ts, because the
 * problem it was written for is not a Supabase problem — it is a signing
 * problem, and R2 has it identically. A SigV4 URL carries a timestamp, so
 * signing on every request produces a different `src` every time; the admin
 * panel redraws its thread every ten seconds, the browser saw a URL it had
 * never seen, missed its cache, and re-downloaded every photo in the thread six
 * times a minute. Egress, paid for, for bytes the browser already had.
 *
 * In memory only, and the cached link still dies on its original schedule —
 * nothing long-lived pointing at a customer's photo is ever written down.
 */
const signedUrls = new Map<string, { url: string; expiresAt: number }>();

const key = (prefix: MediaPrefix, path: string) => `${prefix}/${path}`;

/**
 * A short-lived URL the BROWSER can PUT one object to, straight into R2.
 *
 * WHY UPLOADS BYPASS OUR OWN SERVER
 *
 * A Vercel function rejects a request body over ~4.5 MB before the handler
 * runs, with a plain-text FUNCTION_PAYLOAD_TOO_LARGE (measured 2026-09-13: a
 * 4 MB photo arrived, a 5 MB photo did not). A phone capture is 5-12 MB, so
 * return evidence could not be uploaded from a phone at all — and the customer
 * was told to check their connection.
 *
 * Nothing we can do to a request body moves that limit. Going straight to R2
 * removes the function from the upload path entirely, so the ceiling stops
 * existing rather than being worked around. Egress is free here too, which is
 * why the media already lives in this bucket.
 *
 * THE BYTES ARE NOT TRUSTED. A presigned PUT accepts whatever the browser
 * sends, so nothing here validates content — the caller mints one only after
 * proving the order is theirs, picks the key itself (never from the client),
 * and the bytes are sniffed and re-encoded server-side afterwards, reading from
 * R2 instead of from a request body. See normaliseReturnPhotos in
 * app/api/returns/submit.
 */
export async function presignMediaPut(
  prefix: MediaPrefix,
  path: string,
  contentType: string,
  ttlSeconds = 300,
): Promise<string> {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: mediaBucket(), Key: key(prefix, path), ContentType: contentType }),
    { expiresIn: ttlSeconds },
  );
}

/** Remove one object. Best effort: a leftover costs storage, never correctness. */
export async function deleteMedia(prefix: MediaPrefix, path: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: mediaBucket(), Key: key(prefix, path) }));
}

/** The raw bytes of one stored object, or null when it is not there. */
export async function mediaBytes(prefix: MediaPrefix, path: string): Promise<Buffer | null> {
  try {
    const res = await r2().send(new GetObjectCommand({ Bucket: mediaBucket(), Key: key(prefix, path) }));
    const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) return null;
    return Buffer.from(await body.transformToByteArray());
  } catch {
    return null;
  }
}

/**
 * Store one file. Returns false on failure rather than throwing, because every
 * caller here would rather lose the file than the message or the return it
 * arrived with — see storeMedia in lib/waSupport.ts for the original statement
 * of that trade.
 */
export async function putMedia(
  prefix: MediaPrefix,
  path: string,
  bytes: Buffer,
  contentType: string,
): Promise<boolean> {
  try {
    await r2().send(
      new PutObjectCommand({
        Bucket: mediaBucket(),
        Key: key(prefix, path),
        Body: bytes,
        ContentType: contentType,
      }),
    );
    return true;
  } catch (err) {
    console.error(`[r2Media] upload failed for ${key(prefix, path)}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Whether R2 holds this object. Cheap, and the only honest way to know whether
 *  to sign against R2 or fall back — presigning never checks existence, so an
 *  unconditional R2 link for an object still only in Supabase would be a URL
 *  that returns 404 to an admin looking at a damage claim. */
async function existsInR2(prefix: MediaPrefix, path: string): Promise<boolean> {
  try {
    await r2().send(new HeadObjectCommand({ Bucket: mediaBucket(), Key: key(prefix, path) }));
    return true;
  } catch {
    return false;
  }
}

/**
 * A short-lived link to one private object, from R2 if it is there and Supabase
 * if it is not.
 *
 * The fallback is what makes the cutover survivable without a flag day: objects
 * copied to R2 are served from R2, anything not yet copied keeps working from
 * where it already is, and no admin ever sees a broken image while the copy is
 * in progress. It comes out once the Supabase buckets are deleted.
 */
export async function signedMediaUrl(
  db: SupabaseClient,
  prefix: MediaPrefix,
  path: string,
): Promise<string | null> {
  const cacheKey = key(prefix, path);
  const hit = signedUrls.get(cacheKey);
  if (hit && hit.expiresAt - Date.now() > REFRESH_BEFORE_MS) return hit.url;

  let url: string | null = null;

  if (await existsInR2(prefix, path)) {
    url = await getSignedUrl(
      r2(),
      new GetObjectCommand({ Bucket: mediaBucket(), Key: cacheKey }),
      { expiresIn: SIGNED_TTL_SECONDS },
    );
  } else {
    const { data } = await db.storage.from(prefix).createSignedUrl(path, SIGNED_TTL_SECONDS);
    url = data?.signedUrl ?? null;
  }

  if (url) signedUrls.set(cacheKey, { url, expiresAt: Date.now() + SIGNED_TTL_SECONDS * 1000 });
  return url;
}

/** The batch form, for the returns panel drawing several photos at once.
 *  Sequential rather than parallel is not worth it here — four photos is the
 *  documented ceiling on a return (MAX_PHOTOS), and the cache absorbs redraws. */
export async function signedMediaUrls(
  db: SupabaseClient,
  prefix: MediaPrefix,
  paths: string[],
): Promise<(string | null)[]> {
  return Promise.all(paths.map((p) => signedMediaUrl(db, prefix, p)));
}
