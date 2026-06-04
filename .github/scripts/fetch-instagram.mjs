// Fetch Melodi's Instagram posts via the Instagram Graph API, download each
// post's display image into media/ (so URLs never expire), and write feed.json
// in the shape the site's renderer expects.
//
// No IG_TOKEN? -> no-op exit 0 (the site falls back to Behold's free 6 posts).
// Token lapses later? The already-committed images + feed.json keep serving;
// the feed just stops updating until the token is refreshed. Nothing breaks.

import { writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const TOKEN = process.env.IG_TOKEN;
if (!TOKEN) {
  console.log("IG_TOKEN not set — skipping. Site uses the Behold fallback (6 posts).");
  process.exit(0);
}

const LIMIT = 50; // plenty; raise + paginate later if she ever needs more
const FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_url}";
const MEDIA_DIR = "media";

async function fetchMedia() {
  const url = `https://graph.instagram.com/me/media?fields=${FIELDS}&limit=${LIMIT}&access_token=${TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Instagram API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).data || [];
}

// --- dependency-free image dimension readers (JPEG + PNG) --------------------
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }                       // padding
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; } // standalone
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
function pngSize(buf) {
  if (buf.length > 24 && buf.toString("ascii", 12, 16) === "IHDR")
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  return null;
}
function imageSize(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf);
  if (buf[0] === 0x89 && buf[1] === 0x50) return pngSize(buf);
  return null;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// --- main --------------------------------------------------------------------
const media = await fetchMedia();
await mkdir(MEDIA_DIR, { recursive: true });

const posts = [];
const keep = new Set();

for (const m of media) {
  const isVideo = m.media_type === "VIDEO";
  const srcUrl = isVideo
    ? (m.thumbnail_url || m.media_url)
    : (m.media_url || m.children?.data?.[0]?.media_url);
  if (!srcUrl) { console.warn(`skip ${m.id}: no image url`); continue; }

  const file = `${m.id}.jpg`;
  let dims = null;
  try {
    const buf = await download(srcUrl);
    dims = imageSize(buf);
    await writeFile(path.join(MEDIA_DIR, file), buf);
    keep.add(file);
  } catch (e) {
    console.warn(`skip ${m.id}: ${e.message}`);
    continue;
  }

  posts.push({
    image: `${MEDIA_DIR}/${file}`,
    permalink: m.permalink || null,
    caption: (m.caption || "").replace(/\s+/g, " ").trim().slice(0, 140),
    isVideo,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
  });
}

if (!posts.length) {
  console.log("No usable posts returned — leaving the existing feed untouched.");
  process.exit(0);
}

// prune images for posts that dropped out of the latest set
for (const f of await readdir(MEDIA_DIR)) {
  if (!keep.has(f)) await rm(path.join(MEDIA_DIR, f));
}

await writeFile("feed.json", JSON.stringify(posts) + "\n");
console.log(`Wrote feed.json with ${posts.length} posts; ${keep.size} images in ${MEDIA_DIR}/.`);
