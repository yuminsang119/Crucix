#!/usr/bin/env node
// Crucix Fire Control Room — Server
// Serves the dashboard, runs sweep cycle, processes 119 calls, pushes live updates via SSE

import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import config from './crucix.config.mjs';
import { getLocale, currentLanguage, getSupportedLocales } from './lib/i18n.mjs';
import { fullBriefing } from './apis/briefing.mjs';
import { synthesize, generateIdeas } from './dashboard/inject.mjs';
import { MemoryManager } from './lib/delta/index.mjs';
import { createLLMProvider } from './lib/llm/index.mjs';
import { generateLLMIdeas } from './lib/llm/ideas.mjs';
import { TelegramAlerter } from './lib/alerts/telegram.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';
// Fire control room modules
import { TrackManager } from './lib/ontology/tracker.mjs';
import { createSTTProvider } from './lib/stt/index.mjs';
import { extractCallInfo } from './lib/stt/extractor.mjs';
import { scoreCall } from './lib/stt/scorer.mjs';
import { geocodeAddress, isGeocoderConfigured } from './lib/geo/geocoder.mjs';
import { AddressVectorStore } from './lib/geo/vectorstore.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const RUNS_DIR = join(ROOT, 'runs');
const MEMORY_DIR = join(RUNS_DIR, 'memory');

// Ensure directories exist
for (const dir of [RUNS_DIR, MEMORY_DIR, join(MEMORY_DIR, 'cold')]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// === State ===
let currentData = null;    // Current synthesized dashboard data
let lastSweepTime = null;  // Timestamp of last sweep
let sweepStartedAt = null; // Timestamp when current/last sweep started
let sweepInProgress = false;
const startTime = Date.now();
const sseClients = new Set();

// === Delta/Memory ===
const memory = new MemoryManager(RUNS_DIR);

// === LLM + STT + Telegram + Discord + Ontology ===
const llmProvider = createLLMProvider(config.llm);
const sttProvider = createSTTProvider(config.stt);
const telegramAlerter = new TelegramAlerter(config.telegram);
const discordAlerter = new DiscordAlerter(config.discord || {});
const trackManager = new TrackManager(config.ontology || {});
const addressStore = new AddressVectorStore();
let processedCalls = []; // 119 calls processed in current session

if (llmProvider) console.log(`[Crucix] LLM enabled: ${llmProvider.name} (${llmProvider.model})`);
if (sttProvider?.isConfigured) console.log(`[Crucix] STT enabled: ${sttProvider.name}`);
if (isGeocoderConfigured(config.geo)) console.log('[Crucix] Geocoding enabled');
console.log(`[Crucix] Track Manager: auto-escalate ${config.ontology?.autoEscalateMinutes || 10}min, max track age ${config.ontology?.maxTrackAgeMinutes || 480}min`);
if (telegramAlerter.isConfigured) {
  console.log('[Crucix] Telegram alerts enabled');

  // ─── Two-Way Bot Commands ───────────────────────────────────────────────

  telegramAlerter.onCommand('/status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `🖥️ *CRUCIX STATUS*`,
      ``,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: http://localhost:${config.port}`,
    ].join('\n');
  });

  telegramAlerter.onCommand('/sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    // Fire and forget — don't block the bot response
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  telegramAlerter.onCommand('/brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const weather = currentData.weather || {};
    const fireRisk = currentData.fireRisk || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);
    const incidents = trackManager.getActiveTracks();

    const sections = [
      `🚒 *소방 상황 브리핑*`,
      `_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_`,
      ``,
    ];

    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '✅', 'risk-on': '🔴', 'mixed': '🟡' }[delta.summary.direction] || '🟡';
      sections.push(`${dirEmoji} 상황: *${delta.summary.direction.toUpperCase()}* | ${delta.summary.totalChanges} 변화, ${delta.summary.criticalChanges} 위험`);
      sections.push('');
    }

    if (weather.temperature !== null || weather.windSpeed !== null) {
      sections.push(`🌡 기상: ${weather.temperature ?? '--'}°C | 습도 ${weather.humidity ?? '--'}% | 풍속 ${weather.windSpeed ?? '--'}m/s`);
      if (weather.fireWeatherRiskLabel) sections.push(`   화재기상: ${weather.fireWeatherRiskLabel}`);
      sections.push('');
    }

    if (incidents.length > 0) {
      sections.push(`🔥 활성 사건: ${incidents.length}건`);
      for (const inc of incidents.slice(0, 3)) {
        sections.push(`  • ${inc.id} [${inc.props.state}]`);
      }
      sections.push('');
    }

    if (ideas.length > 0) {
      sections.push(`🚒 *대응 전략:*`);
      for (const idea of ideas) {
        const icon = { DISPATCH: '🚒', EVACUATE: '🚪', REINFORCE: '📢', MONITOR: '👁️' }[idea.type] || '📋';
        sections.push(`  ${icon} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  telegramAlerter.onCommand('/portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
  });

  // Start polling for bot commands
  telegramAlerter.startPolling(config.telegram.botPollingInterval);
}

// === Discord Bot ===
if (discordAlerter.isConfigured) {
  console.log('[Crucix] Discord bot enabled');

  // Reuse the same command handlers as Telegram (DRY)
  discordAlerter.onCommand('status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `**🖥️ CRUCIX STATUS**\n`,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: http://localhost:${config.port}`,
    ].join('\n');
  });

  discordAlerter.onCommand('sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  discordAlerter.onCommand('brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const weather = currentData.weather || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);
    const incidents = trackManager.getActiveTracks();

    const sections = [`**🚒 소방 상황 브리핑**\n_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_\n`];

    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '✅', 'risk-on': '🔴', 'mixed': '🟡' }[delta.summary.direction] || '🟡';
      sections.push(`${dirEmoji} 상황: **${delta.summary.direction.toUpperCase()}** | ${delta.summary.totalChanges} 변화, ${delta.summary.criticalChanges} 위험\n`);
    }

    if (weather.temperature !== null || weather.windSpeed !== null) {
      sections.push(`🌡 기상: ${weather.temperature ?? '--'}°C | 습도 ${weather.humidity ?? '--'}% | 풍속 ${weather.windSpeed ?? '--'}m/s`);
      if (weather.fireWeatherRiskLabel) sections.push(`   화재기상: ${weather.fireWeatherRiskLabel}`);
      sections.push('');
    }

    if (incidents.length > 0) {
      sections.push(`🔥 활성 사건: ${incidents.length}건`);
      for (const inc of incidents.slice(0, 3)) {
        sections.push(`  • ${inc.id} [${inc.props.state}]`);
      }
      sections.push('');
    }

    if (ideas.length > 0) {
      sections.push(`**🚒 대응 전략:**`);
      for (const idea of ideas) {
        const icon = { DISPATCH: '🚒', EVACUATE: '🚪', REINFORCE: '📢', MONITOR: '👁️' }[idea.type] || '📋';
        sections.push(`  ${icon} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  discordAlerter.onCommand('portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
  });

  // Start the Discord bot (non-blocking — connection happens async)
  discordAlerter.start().catch(err => {
    console.error('[Crucix] Discord bot startup failed (non-fatal):', err.message);
  });
}

// === Express Server ===
const app = express();
app.use(express.static(join(ROOT, 'dashboard/public')));

// Serve loading page until first sweep completes, then the dashboard with injected locale
app.get('/', (req, res) => {
  if (!currentData) {
    res.sendFile(join(ROOT, 'dashboard/public/loading.html'));
  } else {
    const htmlPath = join(ROOT, 'dashboard/public/jarvis.html');
    let html = readFileSync(htmlPath, 'utf-8');
    
    // Inject locale data into the HTML
    const locale = getLocale();
    const localeScript = `<script>window.__CRUCIX_LOCALE__ = ${JSON.stringify(locale).replace(/<\/script>/gi, '<\\/script>')};</script>`;
    html = html.replace('</head>', `${localeScript}\n</head>`);
    
    res.type('html').send(html);
  }
});

// API: current data
app.get('/api/data', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData);
});

// API: health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastSweep: lastSweepTime,
    nextSweep: lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toISOString()
      : null,
    sweepInProgress,
    sweepStartedAt,
    sourcesOk: currentData?.meta?.sourcesOk || 0,
    sourcesFailed: currentData?.meta?.sourcesFailed || 0,
    llmEnabled: !!config.llm.provider,
    llmProvider: config.llm.provider,
    sttEnabled: !!sttProvider?.isConfigured,
    sttProvider: config.stt?.provider || null,
    geocoderEnabled: isGeocoderConfigured(config.geo),
    telegramEnabled: !!(config.telegram.botToken && config.telegram.chatId),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    language: currentLanguage,
    // Fire control room status
    activeIncidents: trackManager.getActiveTracks().length,
    totalTracks: trackManager.getAllTracks().length,
    processedCalls: processedCalls.length,
    addressStoreSize: addressStore.stats.totalLocations,
  });
});

// API: available locales
app.get('/api/locales', (req, res) => {
  res.json({
    current: currentLanguage,
    supported: getSupportedLocales(),
  });
});

// SSE: live updates
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// === 119 Emergency Call Processing Pipeline ===

// POST /api/119/transcript — process text transcript from 119 call
app.use(express.json({ limit: '1mb' }));
app.post('/api/119/transcript', async (req, res) => {
  try {
    const { transcript, metadata } = req.body;
    if (!transcript) return res.status(400).json({ error: 'transcript is required' });

    const result = await process119Transcript(transcript, metadata);
    res.json(result);
  } catch (err) {
    console.error('[119] Transcript processing failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/119/call — process audio file from 119 call
app.post('/api/119/call', async (req, res) => {
  if (!sttProvider?.isConfigured) {
    return res.status(503).json({ error: 'STT not configured — set STT_PROVIDER in .env' });
  }

  try {
    // Collect raw body as buffer
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length === 0) {
      return res.status(400).json({ error: 'No audio data received' });
    }

    // 1. STT: audio → text
    console.log(`[119] Processing audio call (${(audioBuffer.length / 1024).toFixed(1)}KB)...`);
    const sttResult = await sttProvider.transcribe(audioBuffer, {
      language: 'ko',
      format: req.headers['content-type']?.includes('wav') ? 'wav' : 'mp3',
    });

    if (!sttResult?.text) {
      return res.status(422).json({ error: 'STT returned empty transcript' });
    }

    console.log(`[119] STT complete: "${sttResult.text.substring(0, 80)}..." (${sttResult.duration}s)`);

    // 2. Run the rest of the pipeline with the transcript
    const result = await process119Transcript(sttResult.text, {
      ...req.body,
      sttDuration: sttResult.duration,
      sttSegments: sttResult.segments,
    });

    res.json(result);
  } catch (err) {
    console.error('[119] Audio call processing failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/119/calls — list processed 119 calls
app.get('/api/119/calls', (req, res) => {
  res.json({
    total: processedCalls.length,
    calls: processedCalls.slice(-50).reverse(), // Latest 50
  });
});

// GET /api/incidents — list all tracked incidents
app.get('/api/incidents', (req, res) => {
  res.json(trackManager.toJSON());
});

// GET /api/incident/:id — get specific incident
app.get('/api/incident/:id', (req, res) => {
  const track = trackManager.getTrack(req.params.id);
  if (!track) return res.status(404).json({ error: 'Incident not found' });
  res.json(track.toJSON());
});

/**
 * Core 119 transcript processing pipeline
 * STT (optional) → NLP extraction → geocoding → vector matching → scoring → tracking
 */
async function process119Transcript(transcript, metadata = {}) {
  const startMs = Date.now();

  // 1. NLP: extract address, incident type, severity from transcript
  const extracted = await extractCallInfo(transcript, llmProvider);
  console.log(`[119] Extracted: type=${extracted.incidentType}, addr="${extracted.address || 'N/A'}", severity=[${extracted.severityIndicators.join(',')}]`);

  // 2. Geocode: address → coordinates
  let geocodeResult = null;
  if (extracted.address && isGeocoderConfigured(config.geo)) {
    geocodeResult = await geocodeAddress(extracted.address, config.geo);
    if (geocodeResult) {
      console.log(`[119] Geocoded: ${geocodeResult.lat}, ${geocodeResult.lon} (${geocodeResult.provider}, conf=${geocodeResult.confidence})`);
    }
  }

  // 3. Vector matching: fuzzy match against known locations
  let vectorMatches = [];
  if (extracted.address && addressStore.loaded) {
    vectorMatches = addressStore.findNearest(extracted.address, 3, 0.3);
    if (vectorMatches.length > 0) {
      console.log(`[119] Vector match: "${vectorMatches[0].name}" (sim=${vectorMatches[0].similarity.toFixed(2)})`);
      // If no geocode result, use vector match coordinates
      if (!geocodeResult && vectorMatches[0].lat) {
        geocodeResult = {
          lat: vectorMatches[0].lat,
          lon: vectorMatches[0].lon,
          confidence: vectorMatches[0].similarity * 0.7, // Lower confidence for fuzzy match
          provider: 'vector-match',
        };
      }
    }
  }

  // 4. Score: calculate priority based on all available context
  const scoreResult = scoreCall(extracted, {
    geocodeResult,
    weather: currentData?.weather || null,
    hazmatFacilities: currentData?.hazmatFacilities || [],
    vulnerableFacilities: currentData?.vulnerableFacilities || [],
    callerCount: metadata.callerCount || 1,
  });

  console.log(`[119] Score: ${scoreResult.score}/100 → ${scoreResult.priority}`);

  // 5. Create/update incident track
  let incident = null;
  if (geocodeResult?.lat) {
    const trackResult = trackManager.processSignals([{
      centroid: { lat: geocodeResult.lat, lon: geocodeResult.lon },
      confidence: geocodeResult.confidence || 0.5,
      sourceCount: 1,
      sources: ['119-STT'],
      signalCount: 1,
      signals: [{
        source: '119',
        location: { lat: geocodeResult.lat, lon: geocodeResult.lon },
        timestamp: Date.now(),
        hasGeoTag: true,
        data: { transcript, extracted, scoreResult },
      }],
      latestTimestamp: Date.now(),
    }]);

    incident = trackResult.created[0] || trackResult.updated[0] || null;
    if (incident) {
      incident.props.callerCount = (incident.props.callerCount || 0) + 1;
      incident.addTimelineEvent(`119 신고 접수 (${scoreResult.priority})`, {
        transcript: transcript.substring(0, 200),
        score: scoreResult.score,
        priority: scoreResult.priority,
        address: extracted.address,
      });
    }
  }

  // 6. Build result
  const result = {
    callId: `CALL-${Date.now()}`,
    incidentId: incident?.id || null,
    timestamp: new Date().toISOString(),
    processingMs: Date.now() - startMs,
    transcript,
    extracted,
    geocodeResult,
    vectorMatches,
    score: scoreResult,
    incidentState: incident?.props?.state || null,
    metadata,
  };

  // Save to processed calls list
  processedCalls.push(result);
  if (processedCalls.length > 500) processedCalls = processedCalls.slice(-500);

  // 7. Broadcast to dashboard via SSE
  broadcast({
    type: '119-call',
    data: result,
    incidents: trackManager.toJSON(),
  });

  // 8. Alert via Telegram/Discord for high-priority calls
  if (scoreResult.score >= 60 && (telegramAlerter.isConfigured || discordAlerter.isConfigured)) {
    const alertMsg = `🚨 *119 신고* [${scoreResult.priority}]\n점수: ${scoreResult.score}/100\n유형: ${extracted.incidentType}\n주소: ${extracted.address || '미확인'}\n${incident ? `사건ID: ${incident.id}` : ''}`;
    if (telegramAlerter.isConfigured) {
      telegramAlerter.sendMessage(alertMsg).catch(e => console.error('[119 Alert] Telegram:', e.message));
    }
  }

  return result;
}

// === Sweep Cycle ===
async function runSweepCycle() {
  if (sweepInProgress) {
    console.log('[Crucix] Sweep already in progress, skipping');
    return;
  }

  sweepInProgress = true;
  sweepStartedAt = new Date().toISOString();
  broadcast({ type: 'sweep_start', timestamp: sweepStartedAt });
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Crucix] Starting sweep at ${new Date().toLocaleTimeString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // 1. Run the full briefing sweep
    const rawData = await fullBriefing();

    // 2. Save to runs/latest.json
    writeFileSync(join(RUNS_DIR, 'latest.json'), JSON.stringify(rawData, null, 2));
    lastSweepTime = new Date().toISOString();

    // 3. Synthesize into dashboard format
    console.log('[Crucix] Synthesizing dashboard data...');
    const synthesized = await synthesize(rawData);

    // 4. Delta computation + memory
    const delta = memory.addRun(synthesized);
    synthesized.delta = delta;

    // 5. LLM-powered response strategies — isolated so failures don't kill sweep
    if (llmProvider?.isConfigured) {
      try {
        console.log('[Crucix] Generating LLM response strategies...');
        const previousIdeas = memory.getLastRun()?.ideas || [];
        const llmIdeas = await generateLLMIdeas(llmProvider, synthesized, delta, previousIdeas);
        if (llmIdeas) {
          synthesized.ideas = llmIdeas;
          synthesized.ideasSource = 'llm';
          console.log(`[Crucix] LLM generated ${llmIdeas.length} strategies`);
        } else {
          synthesized.ideas = [];
          synthesized.ideasSource = 'llm-failed';
        }
      } catch (llmErr) {
        console.error('[Crucix] LLM strategies failed (non-fatal):', llmErr.message);
        synthesized.ideas = [];
        synthesized.ideasSource = 'llm-failed';
      }
    } else {
      synthesized.ideas = [];
      synthesized.ideasSource = 'disabled';
    }

    // 6. Alert evaluation — Telegram + Discord (LLM with rule-based fallback, multi-tier, semantic dedup)
    if (delta?.summary?.totalChanges > 0) {
      if (telegramAlerter.isConfigured) {
        telegramAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Telegram alert error:', err.message);
        });
      }
      if (discordAlerter.isConfigured) {
        discordAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Discord alert error:', err.message);
        });
      }
    }

    // Prune old alerted signals
    memory.pruneAlertedSignals();

    // 7. Update address vector store with known locations from sweep
    try {
      const locations = [];
      const e119 = rawData.sources?.Emergency119;
      if (e119?.hazmatFacilities?.facilities) {
        for (const f of e119.hazmatFacilities.facilities) {
          if (f.lat && f.lon) locations.push({ name: f.name, address: f.address, lat: f.lat, lon: f.lon, type: 'hazmat' });
        }
      }
      if (e119?.hospitals?.hospitals) {
        for (const h of e119.hospitals.hospitals) {
          if (h.lat && h.lon) locations.push({ name: h.name, address: h.address, lat: h.lat, lon: h.lon, type: 'hospital' });
        }
      }
      if (e119?.waterSupply?.hydrants) {
        for (const h of e119.waterSupply.hydrants) {
          if (h.lat && h.lon) locations.push({ name: h.type, address: h.address, lat: h.lat, lon: h.lon, type: 'hydrant' });
        }
      }
      if (locations.length > 0) {
        const loaded = addressStore.load(locations);
        console.log(`[Crucix] Address vector store: ${loaded} locations indexed`);
      }
    } catch (e) {
      console.error('[Crucix] Address store update failed (non-fatal):', e.message);
    }

    // 8. Track manager: check escalations + cleanup
    const escalated = trackManager.checkEscalations();
    if (escalated.length > 0) {
      console.log(`[Crucix] Auto-escalated ${escalated.length} incidents`);
      for (const track of escalated) {
        broadcast({ type: 'incident-escalated', data: track.toJSON() });
      }
    }
    trackManager.cleanupOldTracks();

    // Attach incident tracker data to synthesized output
    synthesized.incidents = trackManager.toJSON();
    synthesized.processedCalls = processedCalls.slice(-20);

    currentData = synthesized;

    // 9. Push to all connected browsers
    broadcast({ type: 'update', data: currentData });

    console.log(`[Crucix] Sweep complete — ${currentData.meta.sourcesOk}/${currentData.meta.sourcesQueried} sources OK`);
    console.log(`[Crucix] ${currentData.ideas.length} ideas (${synthesized.ideasSource}) | ${currentData.news.length} news | ${currentData.newsFeed.length} feed items`);
    if (delta?.summary) console.log(`[Crucix] Delta: ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical, direction: ${delta.summary.direction}`);
    console.log(`[Crucix] Next sweep at ${new Date(Date.now() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()}`);

  } catch (err) {
    console.error('[Crucix] Sweep failed:', err.message);
    broadcast({ type: 'sweep_error', error: err.message });
  } finally {
    sweepInProgress = false;
  }
}

// === Startup ===
async function start() {
  const port = config.port;

  console.log(`
  ╔══════════════════════════════════════════════╗
  ║         CRUCIX FIRE CONTROL ROOM             ║
  ║       Ontology + Fusion · 16 Sources         ║
  ╠══════════════════════════════════════════════╣
  ║  Dashboard:  http://localhost:${port}${' '.repeat(14 - String(port).length)}║
  ║  Health:     http://localhost:${port}/api/health${' '.repeat(4 - String(port).length)}║
  ║  119 Call:   POST /api/119/call              ║
  ║  119 Text:   POST /api/119/transcript        ║
  ║  Incidents:  GET /api/incidents              ║
  ║  Refresh:    Every ${config.refreshIntervalMinutes} min${' '.repeat(20 - String(config.refreshIntervalMinutes).length)}║
  ║  LLM:        ${(config.llm.provider || 'disabled').padEnd(31)}║
  ║  STT:        ${(config.stt?.provider || 'disabled').padEnd(31)}║
  ║  Geocoder:   ${(isGeocoderConfigured(config.geo) ? 'enabled' : 'disabled').padEnd(31)}║
  ╚══════════════════════════════════════════════╝
  `);

  const server = app.listen(port);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Crucix] FATAL: Port ${port} is already in use!`);
      console.error(`[Crucix] A previous Crucix instance may still be running.`);
      console.error(`[Crucix] Fix:  taskkill /F /IM node.exe   (Windows)`);
      console.error(`[Crucix]       kill $(lsof -ti:${port})   (macOS/Linux)`);
      console.error(`[Crucix] Or change PORT in .env\n`);
    } else {
      console.error(`[Crucix] Server error:`, err.stack || err.message);
    }
    process.exit(1);
  });

  server.on('listening', async () => {
    console.log(`[Crucix] Server running on http://localhost:${port}`);

    // Auto-open browser
    // NOTE: On Windows, `start` in PowerShell is an alias for Start-Service, not cmd's start.
    // We must use `cmd /c start ""` to ensure it works in both cmd.exe and PowerShell.
    const openCmd = process.platform === 'win32' ? 'cmd /c start ""' :
                    process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCmd} "http://localhost:${port}"`, (err) => {
      if (err) console.log('[Crucix] Could not auto-open browser:', err.message);
    });

    // Try to load existing data first for instant display (await so dashboard shows immediately)
    try {
      const existing = JSON.parse(readFileSync(join(RUNS_DIR, 'latest.json'), 'utf8'));
      const data = await synthesize(existing);
      currentData = data;
      console.log('[Crucix] Loaded existing data from runs/latest.json — dashboard ready instantly');
      broadcast({ type: 'update', data: currentData });
    } catch {
      console.log('[Crucix] No existing data found — first sweep required');
    }

    // Run first sweep (refreshes data in background)
    console.log('[Crucix] Running initial sweep...');
    runSweepCycle().catch(err => {
      console.error('[Crucix] Initial sweep failed:', err.message || err);
    });

    // Schedule recurring sweeps
    setInterval(runSweepCycle, config.refreshIntervalMinutes * 60 * 1000);
  });
}

// Graceful error handling — log full stack traces for diagnosis
process.on('unhandledRejection', (err) => {
  console.error('[Crucix] Unhandled rejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[Crucix] Uncaught exception:', err?.stack || err?.message || err);
});

start().catch(err => {
  console.error('[Crucix] FATAL — Server failed to start:', err?.stack || err?.message || err);
  process.exit(1);
});
