// Fetch Melodi's Instagram posts via the Instagram API, download each post's
// display image into media/ (so URLs never expire), compute its dimensions +
// average colour, and write feed.json (the site reads it).
//
// - Paginates to pull her whole archive (up to MAX_POSTS).
// - Average colour lets the renderer auto-hide near-black auto-cover frames.
// - No IG_TOKEN? -> no-op exit 0 (site falls back to Behold's free 6 posts).

import { writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const TOKEN = process.env.IG_TOKEN;
if (!TOKEN) {
  console.log("IG_TOKEN not set — skipping. Site uses the Behold fallback (6 posts).");
  process.exit(0);
}

const MAX_POSTS = 250; // safety cap so the repo can't balloon
const FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_url}";
const MEDIA_DIR = "media";

async function fetchAll() {
  let url = `https://graph.instagram.com/me/media?fields=${FIELDS}&limit=50&access_token=${TOKEN}`;
  const all = [];
  while (url && all.length < MAX_POSTS) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Instagram API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    all.push(...(json.data || []));
    url = json.paging?.next || null;
  }
  return all.slice(0, MAX_POSTS);
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const media = await fetchAll();
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
  let width = null, height = null, color = null;
  try {
    const buf = await download(srcUrl);
    const img = sharp(buf);
    const meta = await img.metadata();
    width = meta.width || null;
    height = meta.height || null;
    const ch = (await img.stats()).channels;
    if (ch?.length >= 3) color = `${Math.round(ch[0].mean)},${Math.round(ch[1].mean)},${Math.round(ch[2].mean)}`;
    else if (ch?.length >= 1) { const v = Math.round(ch[0].mean); color = `${v},${v},${v}`; }
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
    width,
    height,
    color,
  });
}

if (!posts.length) {
  console.log("No usable posts returned — leaving the existing feed untouched.");
  process.exit(0);
}

// prune images for posts that dropped out of the set
for (const f of await readdir(MEDIA_DIR)) {
  if (!keep.has(f)) await rm(path.join(MEDIA_DIR, f));
}

await writeFile("feed.json", JSON.stringify(posts) + "\n");
console.log(`Wrote feed.json with ${posts.length} posts; ${keep.size} images. Near-black covers auto-hidden by the renderer.`);
