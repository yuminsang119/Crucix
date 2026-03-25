#!/usr/bin/env node

// Crucix Fire Control Room — Master Orchestrator
// Runs all fire/disaster intelligence sources in parallel
// Outputs structured JSON for ontology engine to process into incident-centric data

import './utils/env.mjs'; // Load API keys from .env
import { pathToFileURL } from 'node:url';

// === Tier 1: Fire Detection & Monitoring ===
import { briefing as firms } from './sources/firms.mjs';           // NASA satellite thermal detection
import { briefing as kma } from './sources/kma.mjs';               // Korea Meteorological Administration
import { briefing as fireRisk } from './sources/fire-risk.mjs';     // Forest fire risk + disaster alerts
import { briefing as emergency119 } from './sources/emergency119.mjs'; // 119 dispatch + infrastructure

// === Tier 2: Building & Infrastructure ===
import { briefing as buildingInfo } from './sources/building-info.mjs'; // Building registry
import { briefing as elevatorInfo } from './sources/elevator-info.mjs'; // Elevator safety data

// === Tier 3: SNS & Social Intelligence ===
import { briefing as snsFire } from './sources/sns-fire.mjs';       // Multi-platform SNS fire monitoring
import { briefing as telegram } from './sources/telegram.mjs';      // Telegram OSINT channels

// === Tier 4: Environment & Health ===
import { briefing as noaa } from './sources/noaa.mjs';              // Weather alerts (US, global)
import { briefing as safecast } from './sources/safecast.mjs';      // Radiation monitoring
import { briefing as epa } from './sources/epa.mjs';                // Environmental monitoring
import { briefing as who } from './sources/who.mjs';                // Health emergencies
import { briefing as reliefweb } from './sources/reliefweb.mjs';    // UN humanitarian data

// === Tier 5: News & OSINT ===
import { briefing as gdelt } from './sources/gdelt.mjs';            // Global news events

// === Tier 6: Cyber & Infrastructure ===
import { briefing as cisaKev } from './sources/cisa-kev.mjs';       // Known vulnerabilities
import { briefing as cloudflareRadar } from './sources/cloudflare-radar.mjs'; // Internet outages

const SOURCE_TIMEOUT_MS = 30_000; // 30s max per individual source
const TOTAL_SOURCES = 16;

export async function runSource(name, fn, ...args) {
  const start = Date.now();
  let timer;
  try {
    const dataPromise = fn(...args);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Source ${name} timed out after ${SOURCE_TIMEOUT_MS / 1000}s`)), SOURCE_TIMEOUT_MS);
    });
    const data = await Promise.race([dataPromise, timeoutPromise]);
    return { name, status: 'ok', durationMs: Date.now() - start, data };
  } catch (e) {
    return { name, status: 'error', durationMs: Date.now() - start, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function fullBriefing() {
  console.error(`[Crucix] Starting fire control room sweep — ${TOTAL_SOURCES} sources...`);
  const start = Date.now();

  const allPromises = [
    // Tier 1: Fire Detection & Monitoring
    runSource('FIRMS', firms),
    runSource('KMA', kma),
    runSource('FireRisk', fireRisk),
    runSource('Emergency119', emergency119),

    // Tier 2: Building & Infrastructure
    runSource('BuildingInfo', buildingInfo),
    runSource('ElevatorInfo', elevatorInfo),

    // Tier 3: SNS & Social Intelligence
    runSource('SNS-Fire', snsFire),
    runSource('Telegram', telegram),

    // Tier 4: Environment & Health
    runSource('NOAA', noaa),
    runSource('Safecast', safecast),
    runSource('EPA', epa),
    runSource('WHO', who),
    runSource('ReliefWeb', reliefweb),

    // Tier 5: News & OSINT
    runSource('GDELT', gdelt),

    // Tier 6: Cyber & Infrastructure
    runSource('CISA-KEV', cisaKev),
    runSource('Cloudflare-Radar', cloudflareRadar),
  ];

  const results = await Promise.allSettled(allPromises);

  const sources = results.map(r => r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason?.message });
  const totalMs = Date.now() - start;

  const output = {
    crucix: {
      version: '3.0.0-fire',
      mode: 'fire-control-room',
      timestamp: new Date().toISOString(),
      totalDurationMs: totalMs,
      sourcesQueried: sources.length,
      sourcesOk: sources.filter(s => s.status === 'ok').length,
      sourcesFailed: sources.filter(s => s.status !== 'ok').length,
    },
    sources: Object.fromEntries(
      sources.filter(s => s.status === 'ok').map(s => [s.name, s.data])
    ),
    errors: sources.filter(s => s.status !== 'ok').map(s => ({ name: s.name, error: s.error })),
    timing: Object.fromEntries(
      sources.map(s => [s.name, { status: s.status, ms: s.durationMs }])
    ),
  };

  console.error(`[Crucix] Fire sweep complete in ${totalMs}ms — ${output.crucix.sourcesOk}/${sources.length} sources returned data`);
  return output;
}

// Run and output when executed directly
const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryHref && import.meta.url === entryHref) {
  const data = await fullBriefing();
  console.log(JSON.stringify(data, null, 2));
}
