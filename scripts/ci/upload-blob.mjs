#!/usr/bin/env node
// Uploads release files to a public Vercel Blob store, checks that the public URL serves exactly the
// bytes that were uploaded, and prints each file's public URL and SHA-256 (also to the job summary).
//
//   BLOB_READ_WRITE_TOKEN=... node scripts/ci/upload-blob.mjs <tag> <latest> <file>...
//
//   <tag>     release tag such as v0.1.0; files go to releases/<tag>/<file name>
//   <latest>  "true" also overwrites releases/latest/<file name> (cached for 60 s, so a stable link
//             always follows the newest release); use "false" for pre-releases
//
// The store must be created with public access (Vercel dashboard > Storage > Blob). The token is only
// ever read from the environment and is never printed.
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, openAsBlob } from 'node:fs';
import { basename, extname } from 'node:path';
import { put } from '@vercel/blob';

const [, , tag, latestArg, ...files] = process.argv;
if (
  !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag ?? '') ||
  !['true', 'false'].includes(latestArg) ||
  files.length === 0
) {
  console.error('usage: upload-blob.mjs <vX.Y.Z> <true|false> <file>...');
  process.exit(2);
}
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error('BLOB_READ_WRITE_TOKEN is not set.');
  process.exit(1);
}

const CONTENT_TYPES = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msi',
  '.apk': 'application/vnd.android.package-archive',
  '.aab': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

async function sha256OfStream(stream) {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function sha256OfUrl(url) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`GET ${url} answered ${response.status}`);
  return sha256OfStream(response.body);
}

async function upload(pathname, file, contentType, options = {}) {
  const body = await openAsBlob(file, { type: contentType });
  return put(pathname, body, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    multipart: true,
    contentType,
    token,
    ...options,
  });
}

const rows = [];
for (const file of files) {
  const name = basename(file);
  const contentType = CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
  const sha256 = await sha256OfStream(createReadStream(file));

  const versioned = await upload(`releases/${tag}/${name}`, file, contentType);
  const served = await sha256OfUrl(versioned.url);
  if (served !== sha256) {
    console.error(`${versioned.url} serves ${served}, expected ${sha256}.`);
    process.exit(1);
  }
  rows.push({ name, sha256, url: versioned.downloadUrl });

  if (latestArg === 'true') {
    const latest = await upload(`releases/latest/${name}`, file, contentType, {
      cacheControlMaxAge: 60,
    });
    rows.push({ name: `${name} (latest)`, sha256, url: latest.downloadUrl });
  }
}

const lines = rows.map((row) => `${row.sha256}  ${row.url}`);
console.log(lines.join('\n'));

if (process.env.GITHUB_STEP_SUMMARY) {
  const table = [
    `### Public downloads for ${tag}`,
    '',
    '| File | SHA-256 | URL |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.name} | \`${row.sha256}\` | ${row.url} |`),
    '',
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table.join('\n')}\n`);
}
