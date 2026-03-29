// Social Media Monitor — YouTube, X (Twitter), Threads, Instagram
// Monitors disaster/emergency/fire related content across social platforms
// Focused on Korean disaster intelligence but also captures global signals
//
// YouTube: YouTube Data API v3 (free quota: 10,000 units/day)
// X (Twitter): Via Nitter RSS proxies (no API key needed) or X API v2
// Threads: Via public web scraping proxy
// Instagram: Via public hashtag RSS proxies
//
// API keys: YOUTUBE_API_KEY (optional), X_BEARER_TOKEN (optional)

import { safeFetch } from '../utils/fetch.mjs';
import '../utils/env.mjs';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// === YouTube Data API v3 ===
async function fetchYouTube() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    // Fallback: use YouTube RSS feeds for specific channels
    return fetchYouTubeRSS();
  }

  const queries = [
    '한국 재난 속보',
    '산불 화재 속보',
    '한국 지진',
    'Korea disaster emergency',
  ];

  const allVideos = [];

  for (const q of queries) {
    try {
      const params = new URLSearchParams({
        part: 'snippet',
        q,
        type: 'video',
        order: 'date',
        maxResults: '10',
        publishedAfter: hoursAgo(24),
        relevanceLanguage: 'ko',
        key,
      });

      const res = await safeFetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { timeout: 10000 });
      const items = res?.items || [];

      for (const item of items) {
        const snippet = item.snippet;
        allVideos.push({
          platform: 'youtube',
          title: snippet?.title?.slice(0, 120),
          channel: snippet?.channelTitle,
          date: snippet?.publishedAt,
          videoId: item.id?.videoId,
          thumbnail: snippet?.thumbnails?.medium?.url,
          description: snippet?.description?.slice(0, 200),
        });
      }
      await delay(500);
    } catch (e) {
      // Continue with next query
    }
  }

  return {
    platform: 'YouTube',
    status: 'ok',
    videos: dedup(allVideos, v => v.videoId).slice(0, 25),
  };
}

// YouTube RSS fallback (no API key needed)
async function fetchYouTubeRSS() {
  // Key Korean news channels
  const channels = [
    { id: 'UCMXqEEGYl045qMOBVpNKJPQ', name: 'YTN' },
    { id: 'UCKMRsq1KhpiH1q5dnaSGbOA', name: 'MBC News' },
    { id: 'UCcQTRi69dsVYHN3exePtZ1A', name: 'SBS News' },
    { id: 'UCIG4p3Cvlhp8_bMAt7-H3Mw', name: 'KBS News' },
    { id: 'UCLm52oSf6QuRwSSwsN__2GQ', name: 'Arirang' },
  ];

  const allVideos = [];

  for (const ch of channels) {
    try {
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`;
      const res = await safeFetch(url, { timeout: 8000 });

      if (res?.rawText) {
        const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
        let match;
        while ((match = entryRegex.exec(res.rawText)) !== null) {
          const block = match[1];
          const title = block.match(/<title>(.*?)<\/title>/)?.[1] || '';
          const published = block.match(/<published>(.*?)<\/published>/)?.[1] || '';
          const videoId = block.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1] || '';

          // Filter for disaster/emergency related content
          if (isDisasterRelated(title)) {
            allVideos.push({
              platform: 'youtube',
              title: title.slice(0, 120),
              channel: ch.name,
              date: published,
              videoId,
            });
          }
        }
      }
    } catch {
      // Continue with next channel
    }
    await delay(1000);
  }

  return {
    platform: 'YouTube',
    status: 'rss_fallback',
    videos: allVideos.slice(0, 20),
  };
}

// === X (Twitter) ===
async function fetchX() {
  const bearer = process.env.X_BEARER_TOKEN;
  if (bearer) {
    return fetchXAPI(bearer);
  }
  // Fallback: RSS proxy via Nitter instances
  return fetchXRSS();
}

// X API v2 (requires bearer token)
async function fetchXAPI(bearer) {
  const queries = [
    '한국 재난 -is:retweet',
    '산불 OR 화재 OR 지진 lang:ko -is:retweet',
    'Korea disaster OR fire OR earthquake -is:retweet',
  ];

  const allPosts = [];

  for (const q of queries) {
    try {
      const params = new URLSearchParams({
        query: q,
        max_results: '15',
        'tweet.fields': 'created_at,public_metrics,author_id,geo',
        sort_order: 'recency',
      });

      const res = await safeFetch(`https://api.twitter.com/2/tweets/search/recent?${params}`, {
        timeout: 10000,
        headers: { 'Authorization': `Bearer ${bearer}` },
      });

      const tweets = res?.data || [];
      for (const tweet of tweets) {
        allPosts.push({
          platform: 'x',
          text: tweet.text?.slice(0, 200),
          date: tweet.created_at,
          id: tweet.id,
          metrics: tweet.public_metrics,
        });
      }
      await delay(1000);
    } catch {
      // Continue
    }
  }

  return {
    platform: 'X',
    status: 'ok',
    posts: dedup(allPosts, p => p.id).slice(0, 30),
  };
}

// X RSS fallback via Nitter
async function fetchXRSS() {
  // Key accounts for Korea disaster info
  const accounts = [
    { handle: 'KMA_KOREA', name: '기상청' },
    { handle: 'maboroshipapa', name: '행안부' },
    { handle: 'forestfire_kr', name: '산림청' },
    { handle: 'yaborim', name: '산불감시' },
  ];

  const nitterInstances = [
    'https://nitter.privacydev.net',
    'https://nitter.poast.org',
  ];

  const allPosts = [];

  for (const account of accounts) {
    for (const nitter of nitterInstances) {
      try {
        const url = `${nitter}/${account.handle}/rss`;
        const res = await safeFetch(url, { timeout: 8000 });

        if (res?.rawText) {
          const itemRegex = /<item>([\s\S]*?)<\/item>/g;
          let match;
          let count = 0;
          while ((match = itemRegex.exec(res.rawText)) !== null && count < 5) {
            const block = match[1];
            const title = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || '';
            const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';

            if (isDisasterRelated(title)) {
              allPosts.push({
                platform: 'x',
                text: title.slice(0, 200),
                author: account.name,
                handle: account.handle,
                date: pubDate,
              });
            }
            count++;
          }
          break; // Got data from this nitter instance, no need to try others
        }
      } catch {
        // Try next nitter instance
      }
    }
    await delay(500);
  }

  return {
    platform: 'X',
    status: 'rss_fallback',
    posts: allPosts.slice(0, 20),
  };
}

// === Threads (Meta) ===
async function fetchThreads() {
  // Threads doesn't have a public API yet.
  // Use keyword search via available web proxies or the Threads API (if token provided)
  const token = process.env.THREADS_ACCESS_TOKEN;

  if (token) {
    try {
      const res = await safeFetch(
        `https://graph.threads.net/v1.0/me/threads?fields=id,text,timestamp,media_type&access_token=${token}`,
        { timeout: 10000 }
      );
      const posts = (res?.data || []).filter(p => isDisasterRelated(p.text));
      return {
        platform: 'Threads',
        status: 'ok',
        posts: posts.map(p => ({
          platform: 'threads',
          text: p.text?.slice(0, 200),
          date: p.timestamp,
          id: p.id,
        })).slice(0, 15),
      };
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: search GDELT for Threads mentions about Korea disasters
  try {
    const params = new URLSearchParams({
      query: '(threads.net OR "from threads") (Korea disaster OR 재난 OR 산불 OR 화재)',
      mode: 'ArtList',
      maxrecords: '10',
      timespan: '24h',
      format: 'json',
      sort: 'DateDesc',
    });

    const res = await safeFetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, { timeout: 10000 });
    const articles = (res?.articles || []).map(a => ({
      platform: 'threads',
      text: a.title?.slice(0, 200),
      url: a.url,
      date: a.seendate,
      source: a.domain,
    }));

    return {
      platform: 'Threads',
      status: 'gdelt_proxy',
      posts: articles.slice(0, 10),
    };
  } catch {
    return { platform: 'Threads', status: 'unavailable', posts: [] };
  }
}

// === Instagram ===
async function fetchInstagram() {
  // Instagram Graph API requires business account + token
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;

  if (token) {
    try {
      const res = await safeFetch(
        `https://graph.instagram.com/me/media?fields=id,caption,timestamp,media_type,permalink&access_token=${token}`,
        { timeout: 10000 }
      );
      const posts = (res?.data || []).filter(p => isDisasterRelated(p.caption));
      return {
        platform: 'Instagram',
        status: 'ok',
        posts: posts.map(p => ({
          platform: 'instagram',
          text: p.caption?.slice(0, 200),
          date: p.timestamp,
          url: p.permalink,
          id: p.id,
        })).slice(0, 15),
      };
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: search GDELT for Instagram posts about Korea disasters
  try {
    const params = new URLSearchParams({
      query: '(instagram.com OR "instagram post") (Korea disaster OR fire OR 재난 OR 산불)',
      mode: 'ArtList',
      maxrecords: '10',
      timespan: '48h',
      format: 'json',
      sort: 'DateDesc',
    });

    const res = await safeFetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, { timeout: 10000 });
    const articles = (res?.articles || []).map(a => ({
      platform: 'instagram',
      text: a.title?.slice(0, 200),
      url: a.url,
      date: a.seendate,
      source: a.domain,
    }));

    return {
      platform: 'Instagram',
      status: 'gdelt_proxy',
      posts: articles.slice(0, 10),
    };
  } catch {
    return { platform: 'Instagram', status: 'unavailable', posts: [] };
  }
}

// === Helpers ===
function hoursAgo(h) {
  return new Date(Date.now() - h * 3600000).toISOString();
}

function isDisasterRelated(text) {
  if (!text) return false;
  const keywords = [
    // Korean
    '재난', '화재', '산불', '지진', '태풍', '홍수', '폭발', '사고', '대피',
    '경보', '특보', '긴급', '피해', '구조', '소방', '위험', '실종', '매몰',
    '호우', '폭풍', '해일', '쓰나미', '정전', '붕괴', '사상자', '응급',
    // English
    'disaster', 'fire', 'earthquake', 'typhoon', 'flood', 'explosion',
    'emergency', 'evacuate', 'rescue', 'wildfire', 'tsunami', 'collapse',
    'casualty', 'warning', 'alert', 'hazard', 'outbreak',
  ];
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

function dedup(arr, keyFn) {
  const seen = new Set();
  return arr.filter(item => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// === Master Briefing ===
export async function briefing() {
  const [youtube, x, threads, instagram] = await Promise.all([
    fetchYouTube().catch(e => ({ platform: 'YouTube', status: 'error', error: e.message, videos: [] })),
    fetchX().catch(e => ({ platform: 'X', status: 'error', error: e.message, posts: [] })),
    fetchThreads().catch(e => ({ platform: 'Threads', status: 'error', error: e.message, posts: [] })),
    fetchInstagram().catch(e => ({ platform: 'Instagram', status: 'error', error: e.message, posts: [] })),
  ]);

  // Merge all posts for unified feed
  const allPosts = [
    ...(youtube.videos || []).map(v => ({
      platform: 'youtube', text: v.title, author: v.channel, date: v.date,
      url: v.videoId ? `https://youtu.be/${v.videoId}` : undefined,
    })),
    ...(x.posts || []).map(p => ({
      platform: 'x', text: p.text, author: p.author || p.handle, date: p.date,
      metrics: p.metrics,
    })),
    ...(threads.posts || []).map(p => ({
      platform: 'threads', text: p.text, date: p.date, url: p.url,
    })),
    ...(instagram.posts || []).map(p => ({
      platform: 'instagram', text: p.text, date: p.date, url: p.url,
    })),
  ];

  // Sort by date (newest first)
  allPosts.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  // Generate signals
  const signals = [];
  const urgentPosts = allPosts.filter(p =>
    /긴급|대피|폭발|사망|emergency|explosion|critical/i.test(p.text || '')
  );

  if (urgentPosts.length > 0) {
    signals.push(`소셜미디어 긴급 신호 ${urgentPosts.length}건: ${urgentPosts.slice(0, 3).map(p => `[${p.platform}] ${p.text?.slice(0, 40)}`).join(' | ')}`);
  }

  const ytCount = youtube.videos?.length || 0;
  const xCount = x.posts?.length || 0;
  if (ytCount + xCount > 15) {
    signals.push(`소셜 미디어 활동 급증: YouTube ${ytCount}건, X ${xCount}건 — 재난 관련 컨텐츠`);
  }

  return {
    source: 'Social Media',
    timestamp: new Date().toISOString(),
    status: 'active',
    platforms: {
      youtube: { status: youtube.status, count: youtube.videos?.length || 0 },
      x: { status: x.status, count: x.posts?.length || 0 },
      threads: { status: threads.status, count: threads.posts?.length || 0 },
      instagram: { status: instagram.status, count: instagram.posts?.length || 0 },
    },
    youtube: youtube.videos || [],
    x: x.posts || [],
    threads: threads.posts || [],
    instagram: instagram.posts || [],
    unifiedFeed: allPosts.slice(0, 40),
    urgentPosts,
    signals,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('social-media.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
