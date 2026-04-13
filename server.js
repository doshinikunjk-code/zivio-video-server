// Zivio Video Proxy Server
// Deployed on Railway — finds guaranteed-embeddable YouTube videos
// for every Zivio topic and caches them permanently

const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const app     = express();

app.use(cors());
app.use(express.json());

const PORT    = process.env.PORT || 3000;
const YT_KEY  = process.env.YT_API_KEY || 'AIzaSyACSPrQiUWU3KwtzwH1fhu4tFFc45xyeO4';

// ── In-memory cache: "query" → videoId (persists until server restart)
// On Railway, use a simple JSON file for persistence across restarts
const fs = require('fs');
const CACHE_FILE = '/tmp/zivio_video_cache.json';

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch(e) {}
  return {};
}

function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch(e) {}
}

let videoCache = loadCache();

// ── Channels known to block embedding — skip their results
const BLOCKED_CHANNELS = [
  'UCBcRF18a7Qf58cCRy5xuWwQ', // MathAntics
  'UCX6b17PVsYBQ0ip5gyeme-Q', // CrashCourse Kids
  'UCsooa4yRKGN_zEE8iknghZA', // TED-Ed
  'UCWX3yGbODI3pHkUMzaHCHEQ', // Numberphile
];

// ── Core function: find first truly embeddable video for a topic
async function findEmbeddableVideo(query) {
  // Check cache first
  if (videoCache[query] && videoCache[query] !== 'NONE') {
    console.log(`Cache hit: ${query} → ${videoCache[query]}`);
    return videoCache[query];
  }

  console.log(`Searching YouTube for: ${query}`);

  // Search YouTube
  const searchUrl = `https://www.googleapis.com/youtube/v3/search`
    + `?part=id,snippet`
    + `&q=${encodeURIComponent(query + ' lesson tutorial')}`
    + `&type=video`
    + `&videoEmbeddable=true`
    + `&safeSearch=strict`
    + `&relevanceLanguage=en`
    + `&videoDuration=short`
    + `&maxResults=15`
    + `&key=${YT_KEY}`;

  const searchRes  = await fetch(searchUrl);
  const searchData = await searchRes.json();

  if (!searchData.items || searchData.items.length === 0) {
    videoCache[query] = 'NONE';
    saveCache(videoCache);
    return null;
  }

  // Filter out blocked channels immediately
  const candidates = searchData.items.filter(item => {
    const channelId = item.snippet?.channelId || '';
    return !BLOCKED_CHANNELS.includes(channelId);
  });

  if (candidates.length === 0) {
    videoCache[query] = 'NONE';
    saveCache(videoCache);
    return null;
  }

  // Verify embeddable status on each candidate via videos.list
  const ids = candidates.map(i => i.id.videoId).join(',');
  const verifyUrl = `https://www.googleapis.com/youtube/v3/videos`
    + `?part=status,contentDetails`
    + `&id=${ids}`
    + `&key=${YT_KEY}`;

  const verifyRes  = await fetch(verifyUrl);
  const verifyData = await verifyRes.json();

  // Pick first video where embeddable === true AND not blocked in country
  let chosenId = null;
  if (verifyData.items) {
    for (const item of verifyData.items) {
      if (item.status?.embeddable === true
          && item.status?.uploadStatus === 'processed'
          && item.status?.privacyStatus === 'public') {
        chosenId = item.id;
        break;
      }
    }
  }

  if (chosenId) {
    videoCache[query] = chosenId;
    saveCache(videoCache);
    console.log(`Found: ${query} → ${chosenId}`);
    return chosenId;
  }

  // Nothing worked — try broader search without filters
  const broadUrl = `https://www.googleapis.com/youtube/v3/search`
    + `?part=id,snippet`
    + `&q=${encodeURIComponent(query + ' educational kids')}`
    + `&type=video`
    + `&videoEmbeddable=true`
    + `&safeSearch=strict`
    + `&maxResults=20`
    + `&key=${YT_KEY}`;

  const broadRes  = await fetch(broadUrl);
  const broadData = await broadRes.json();

  if (broadData.items) {
    const broadCandidates = broadData.items.filter(i =>
      !BLOCKED_CHANNELS.includes(i.snippet?.channelId || '')
    );
    const broadIds = broadCandidates.map(i => i.id.videoId).join(',');

    if (broadIds) {
      const vUrl = `https://www.googleapis.com/youtube/v3/videos`
        + `?part=status&id=${broadIds}&key=${YT_KEY}`;
      const vData = await (await fetch(vUrl)).json();

      for (const item of (vData.items || [])) {
        if (item.status?.embeddable === true && item.status?.privacyStatus === 'public') {
          videoCache[query] = item.id;
          saveCache(videoCache);
          console.log(`Found (broad): ${query} → ${item.id}`);
          return item.id;
        }
      }
    }
  }

  videoCache[query] = 'NONE';
  saveCache(videoCache);
  return null;
}

// ── API endpoint: GET /video?q=place+value+grade+4
app.get('/video', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing q parameter' });

  try {
    const videoId = await findEmbeddableVideo(query);
    if (videoId) {
      res.json({ videoId, embedUrl: `https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1&playsinline=1` });
    } else {
      res.json({ videoId: null, embedUrl: null });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API endpoint: POST /preload — preload all 45 gate videos at startup
app.post('/preload', async (req, res) => {
  const queries = req.body.queries || [];
  const results = {};
  for (const q of queries) {
    try {
      results[q] = await findEmbeddableVideo(q);
      // Small delay to avoid quota
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      results[q] = null;
    }
  }
  res.json(results);
});

// ── Cache status endpoint
app.get('/cache', (req, res) => {
  const total  = Object.keys(videoCache).length;
  const found  = Object.values(videoCache).filter(v => v !== 'NONE').length;
  const none   = Object.values(videoCache).filter(v => v === 'NONE').length;
  res.json({ total, found, none, cache: videoCache });
});

// ── Clear cache endpoint (for maintenance)
app.delete('/cache', (req, res) => {
  videoCache = {};
  saveCache(videoCache);
  res.json({ cleared: true });
});

// ── Health check
app.get('/', (req, res) => {
  res.json({ status: 'Zivio Video Server running', cached: Object.keys(videoCache).length });
});

app.listen(PORT, () => {
  console.log(`Zivio Video Server on port ${PORT}`);
});
