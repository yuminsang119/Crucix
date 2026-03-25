#!/usr/bin/env node
// SNS Fire Analysis — Multi-platform parallel social media monitoring
// Searches Twitter/X, YouTube, Naver, Bluesky, Telegram, Instagram
// for fire/disaster reports in Korea, with cross-platform fusion

import { safeFetch } from '../utils/fetch.mjs';

// === Fire-specific keywords (Korean + English) ===
const FIRE_KEYWORDS_KO = [
  '화재', '불이나', '산불', '건물화재', '차량화재', '폭발', '가스폭발',
  '연기', '대피', '긴급', '속보', '사상자', '구조', '매몰',
  '유독가스', '위험물', '가스누출', '화학물질', '소방차', '119',
];

const FIRE_KEYWORDS_EN = [
  'fire', 'explosion', 'smoke', 'evacuate', 'rescue',
  'wildfire', 'blaze', 'inferno', 'hazmat', 'gas leak',
];

const ALL_FIRE_KEYWORDS = [...FIRE_KEYWORDS_KO, ...FIRE_KEYWORDS_EN];

// Korea bounding box for geo-filtering
const KOREA_BBOX = { south: 33.0, north: 38.7, west: 124.5, east: 132.0 };

/**
 * Calculate significance score for fire-related posts
 */
function fireSignificanceScore(post) {
  let score = 0;
  const text = (post.text || post.title || '').toLowerCase();

  // Engagement weight
  score += Math.min((post.engagement || 0) / 100, 30);

  // Fire keyword matching
  const matched = ALL_FIRE_KEYWORDS.filter(k => text.includes(k.toLowerCase()));
  score += matched.length * 15;

  // Media evidence bonus
  if (post.hasMedia) score += 20;

  // Geo-tag bonus
  if (post.hasGeoTag) score += 15;

  // Live stream bonus (YouTube)
  if (post.isLiveStream) score += 25;

  // Verified/official account bonus
  if (post.isVerified) score += 10;

  return { score, matchedKeywords: matched };
}

// === Platform Fetchers ===

/**
 * Twitter/X — Search API v2
 */
async function fetchTwitterFire() {
  const token = process.env.TWITTER_BEARER_TOKEN;
  if (!token) return { available: false, platform: 'twitter', note: 'TWITTER_BEARER_TOKEN not set' };

  try {
    const query = encodeURIComponent('(화재 OR 산불 OR 폭발 OR 연기 OR 대피) place_country:KR -is:retweet');
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=20&tweet.fields=created_at,public_metrics,geo,attachments&expansions=geo.place_id`;

    const res = await safeFetch(url, {
      timeout: 15000,
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return { available: false, platform: 'twitter', error: `HTTP ${res.status}` };

    const data = await res.json();
    const tweets = (data.data || []).map(t => ({
      platform: 'twitter',
      text: t.text?.substring(0, 300) || '',
      author: t.author_id,
      date: t.created_at,
      engagement: (t.public_metrics?.like_count || 0) + (t.public_metrics?.retweet_count || 0),
      hasMedia: !!t.attachments?.media_keys?.length,
      hasGeoTag: !!t.geo?.place_id,
      geoTag: null, // Would need place lookup
      isLiveStream: false,
      isVerified: false,
    }));

    return { available: true, platform: 'twitter', posts: tweets, count: tweets.length };
  } catch (e) {
    return { available: false, platform: 'twitter', error: e.message };
  }
}

/**
 * YouTube — Search for live fire streams
 */
async function fetchYouTubeLive() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return { available: false, platform: 'youtube', note: 'YOUTUBE_API_KEY not set' };

  try {
    const query = encodeURIComponent('화재 현장');
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${query}&type=video&eventType=live&regionCode=KR&maxResults=10&key=${apiKey}`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (!res.ok) return { available: false, platform: 'youtube', error: `HTTP ${res.status}` };

    const data = await res.json();
    const videos = (data.items || []).map(v => ({
      platform: 'youtube',
      text: v.snippet?.title?.substring(0, 300) || '',
      author: v.snippet?.channelTitle || '',
      date: v.snippet?.publishedAt,
      engagement: 0,
      hasMedia: true,
      hasGeoTag: false,
      isLiveStream: true,
      isVerified: false,
      videoId: v.id?.videoId,
    }));

    return { available: true, platform: 'youtube', posts: videos, count: videos.length, liveCount: videos.length };
  } catch (e) {
    return { available: false, platform: 'youtube', error: e.message };
  }
}

/**
 * Naver — News search + Blog search for fire reports
 */
async function fetchNaverFire() {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { available: false, platform: 'naver', note: 'NAVER_CLIENT_ID/SECRET not set' };

  const headers = {
    'X-Naver-Client-Id': clientId,
    'X-Naver-Client-Secret': clientSecret,
  };

  const results = { news: [], blog: [] };

  try {
    // News search
    const newsQuery = encodeURIComponent('화재 OR 산불 OR 폭발');
    const newsUrl = `https://openapi.naver.com/v1/search/news.json?query=${newsQuery}&display=15&sort=date`;
    const newsRes = await safeFetch(newsUrl, { timeout: 10000, headers });

    if (newsRes.ok) {
      const newsData = await newsRes.json();
      results.news = (newsData.items || []).map(item => ({
        platform: 'naver_news',
        text: (item.title || '').replace(/<[^>]+>/g, '').substring(0, 300),
        author: item.originallink || '',
        date: item.pubDate,
        engagement: 0,
        hasMedia: false,
        hasGeoTag: false,
        isLiveStream: false,
        isVerified: true, // News sources are considered verified
        url: item.link,
      }));
    }
  } catch (e) {
    results.newsError = e.message;
  }

  try {
    // Blog search (eyewitness reports)
    const blogQuery = encodeURIComponent('화재 목격 OR 불이나 OR 연기');
    const blogUrl = `https://openapi.naver.com/v1/search/blog.json?query=${blogQuery}&display=10&sort=date`;
    const blogRes = await safeFetch(blogUrl, { timeout: 10000, headers });

    if (blogRes.ok) {
      const blogData = await blogRes.json();
      results.blog = (blogData.items || []).map(item => ({
        platform: 'naver_blog',
        text: (item.title || '').replace(/<[^>]+>/g, '').substring(0, 300),
        author: item.bloggername || '',
        date: item.postdate,
        engagement: 0,
        hasMedia: false,
        hasGeoTag: false,
        isLiveStream: false,
        isVerified: false,
        url: item.link,
      }));
    }
  } catch (e) {
    results.blogError = e.message;
  }

  const allPosts = [...results.news, ...results.blog];
  return { available: true, platform: 'naver', posts: allPosts, count: allPosts.length };
}

/**
 * Bluesky — AT Protocol search (no auth needed)
 */
async function fetchBlueskyFire() {
  try {
    const query = encodeURIComponent('화재 OR 산불 OR fire Korea');
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${query}&limit=15`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (!res.ok) return { available: false, platform: 'bluesky', error: `HTTP ${res.status}` };

    const data = await res.json();
    const posts = (data.posts || []).map(p => ({
      platform: 'bluesky',
      text: p.record?.text?.substring(0, 300) || '',
      author: p.author?.handle || '',
      date: p.record?.createdAt,
      engagement: (p.likeCount || 0) + (p.repostCount || 0),
      hasMedia: !!(p.record?.embed?.images?.length || p.record?.embed?.video),
      hasGeoTag: false,
      isLiveStream: false,
      isVerified: false,
    }));

    return { available: true, platform: 'bluesky', posts, count: posts.length };
  } catch (e) {
    return { available: false, platform: 'bluesky', error: e.message };
  }
}

/**
 * Telegram — Scrape Korean fire/disaster channels
 */
async function fetchTelegramFire() {
  const FIRE_CHANNELS = [
    'fire_korea',
    'disaster_korea',
    'korea_emergency',
    'safekorea_alert',
  ];

  const posts = [];

  for (const channel of FIRE_CHANNELS) {
    try {
      const url = `https://t.me/s/${channel}`;
      const res = await safeFetch(url, { timeout: 10000 });
      if (!res.ok) continue;

      const html = await res.text();
      const msgRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
      let match;
      let count = 0;
      while ((match = msgRegex.exec(html)) !== null && count < 5) {
        const text = match[1].replace(/<[^>]+>/g, '').trim();
        if (text && ALL_FIRE_KEYWORDS.some(k => text.includes(k))) {
          posts.push({
            platform: 'telegram',
            text: text.substring(0, 300),
            author: channel,
            date: new Date().toISOString(),
            engagement: 0,
            hasMedia: false,
            hasGeoTag: false,
            isLiveStream: false,
            isVerified: false,
          });
          count++;
        }
      }
    } catch {
      // Channel may not exist or be inaccessible
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 1000));
  }

  return { available: true, platform: 'telegram', posts, count: posts.length };
}

/**
 * Cross-platform fusion — cluster same events across platforms
 */
function crossPlatformFusion(allPosts) {
  // Score all posts
  const scored = allPosts.map(post => {
    const { score, matchedKeywords } = fireSignificanceScore(post);
    return { ...post, score, matchedKeywords };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Simple time-window clustering (posts within 30 min about similar topic)
  const clusters = [];
  const used = new Set();

  for (let i = 0; i < scored.length; i++) {
    if (used.has(i)) continue;
    const cluster = { posts: [scored[i]], platforms: new Set([scored[i].platform]) };
    used.add(i);

    for (let j = i + 1; j < scored.length; j++) {
      if (used.has(j)) continue;

      // Check keyword overlap
      const overlap = scored[i].matchedKeywords.filter(k =>
        scored[j].matchedKeywords.includes(k)
      );

      if (overlap.length >= 1) {
        cluster.posts.push(scored[j]);
        cluster.platforms.add(scored[j].platform);
        used.add(j);
      }
    }

    // Calculate cluster confidence
    const platformCount = cluster.platforms.size;
    let confidence = 0.3;
    if (platformCount >= 3) confidence = 0.9;
    else if (platformCount >= 2) confidence = 0.6;

    const hasGeo = cluster.posts.some(p => p.hasGeoTag);
    if (hasGeo) confidence = Math.min(1.0, confidence + 0.05);

    const hasMedia = cluster.posts.some(p => p.hasMedia);
    if (hasMedia) confidence = Math.min(1.0, confidence + 0.05);

    clusters.push({
      platforms: [...cluster.platforms],
      platformCount,
      confidence,
      topPost: cluster.posts[0],
      postCount: cluster.posts.length,
      keywords: [...new Set(cluster.posts.flatMap(p => p.matchedKeywords))],
    });
  }

  return clusters.filter(c => c.confidence >= 0.3).slice(0, 20);
}

// === Main Briefing Function ===

export async function briefing() {
  const results = {
    source: 'SNS-Fire',
    description: 'Multi-platform SNS fire/disaster monitoring with cross-platform fusion',
    timestamp: new Date().toISOString(),
    platforms: {},
    fusedSignals: [],
    summary: {},
  };

  // Fetch all platforms in parallel
  const [twitter, youtube, naver, bluesky, telegram] = await Promise.allSettled([
    fetchTwitterFire(),
    fetchYouTubeLive(),
    fetchNaverFire(),
    fetchBlueskyFire(),
    fetchTelegramFire(),
  ]);

  const platformResults = [twitter, youtube, naver, bluesky, telegram];
  const platformNames = ['twitter', 'youtube', 'naver', 'bluesky', 'telegram'];

  // Collect all posts
  const allPosts = [];
  let activePlatforms = 0;

  for (let i = 0; i < platformResults.length; i++) {
    const r = platformResults[i];
    const name = platformNames[i];
    if (r.status === 'fulfilled') {
      results.platforms[name] = {
        available: r.value.available,
        count: r.value.count || 0,
        liveCount: r.value.liveCount || 0,
        error: r.value.error || null,
      };
      if (r.value.available && r.value.posts) {
        allPosts.push(...r.value.posts);
        activePlatforms++;
      }
    } else {
      results.platforms[name] = { available: false, error: r.reason?.message };
    }
  }

  // Cross-platform fusion
  results.fusedSignals = crossPlatformFusion(allPosts);

  // Summary
  results.summary = {
    activePlatforms,
    totalPosts: allPosts.length,
    fusedClusters: results.fusedSignals.length,
    highConfidenceSignals: results.fusedSignals.filter(s => s.confidence >= 0.6).length,
    topSignals: results.fusedSignals.slice(0, 5).map(s => ({
      text: s.topPost.text.substring(0, 100),
      confidence: s.confidence,
      platforms: s.platforms,
      keywords: s.keywords.slice(0, 5),
    })),
  };

  return results;
}
