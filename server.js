const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const fs      = require('fs');
const app     = express();

// Allow Netlify domain + localhost for testing
app.use(cors({
  origin: [
    'https://tiny-cendol-c93908.netlify.app',
    'http://localhost',
    'http://127.0.0.1',
    'null' // local file:// access
  ],
  methods: ['GET','DELETE']
}));
app.use(express.json());

const PORT   = process.env.PORT || 3000;
const YT_KEY = process.env.YT_API_KEY;

const CACHE_FILE = '/tmp/zivio_video_cache.json';
function loadCache(){ try{ if(fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')); }catch(e){} return {}; }
function saveCache(c){ try{ fs.writeFileSync(CACHE_FILE, JSON.stringify(c)); }catch(e){} }
let videoCache = loadCache();

// Channels that block embedding
const BLOCKED = [
  'UCBcRF18a7Qf58cCRy5xuWwQ', // MathAntics
  'UCX6b17PVsYBQ0ip5gyeme-Q', // CrashCourse Kids
  'UCsooa4yRKGN_zEE8iknghZA', // TED-Ed
  'UC4a-Gbdw7vOaccHmFo40b9g', // Khan Academy
];

async function findVideos(query) {
  const key = query.toLowerCase().trim();
  if (videoCache[key] && videoCache[key].length > 0) {
    console.log(`Cache hit: ${query}`);
    return videoCache[key];
  }

  console.log(`Searching: ${query}`);
  let allIds = [];

  for (const q of [query+' lesson kids', query+' tutorial elementary', query+' educational grade']) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=id,snippet&type=video&videoEmbeddable=true&safeSearch=strict&maxResults=15&q=${encodeURIComponent(q)}&key=${YT_KEY}`;
      const d = await (await fetch(url)).json();
      if (d.items) {
        d.items
          .filter(i => !BLOCKED.includes(i.snippet?.channelId||''))
          .forEach(i => { if(!allIds.includes(i.id.videoId)) allIds.push(i.id.videoId); });
      }
      if (allIds.length >= 25) break;
    } catch(e) { console.error('Search error:', e.message); }
  }

  const verified = [];
  for (let i = 0; i < allIds.length && verified.length < 8; i += 10) {
    try {
      const batch = allIds.slice(i, i+10).join(',');
      const url = `https://www.googleapis.com/youtube/v3/videos?part=status&id=${batch}&key=${YT_KEY}`;
      const d = await (await fetch(url)).json();
      for (const item of (d.items||[])) {
        if (item.status?.embeddable===true && item.status?.privacyStatus==='public') {
          verified.push(item.id);
        }
      }
    } catch(e) { console.error('Verify error:', e.message); }
  }

  console.log(`Found ${verified.length} embeddable for: ${query}`);
  videoCache[key] = verified;
  saveCache(videoCache);
  return verified;
}

app.get('/video', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing q' });
  if (!YT_KEY) return res.status(500).json({ error: 'YT_API_KEY not set' });
  try {
    const ids = await findVideos(q);
    res.json({ videoId: ids[0]||null, videoIds: ids, count: ids.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/cache', (req, res) => { videoCache={}; saveCache(videoCache); res.json({cleared:true}); });
app.get('/cache', (req, res) => { res.json({ total: Object.keys(videoCache).length, cache: videoCache }); });
app.get('/', (req, res) => { res.json({ status:'Zivio Video Server running', cached:Object.keys(videoCache).length, ytKeySet:!!YT_KEY }); });

app.listen(PORT, () => console.log(`Zivio Video Server on port ${PORT}`));
