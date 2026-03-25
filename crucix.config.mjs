// Crucix Configuration — all settings with env var overrides

import "./apis/utils/env.mjs"; // Load .env first

export default {
  port: parseInt(process.env.PORT) || 3117,
  refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES) || 15,

  llm: {
    provider: process.env.LLM_PROVIDER || null, // anthropic | openai | gemini | codex | openrouter | minimax | mistral | ollama
    apiKey: process.env.LLM_API_KEY || null,
    model: process.env.LLM_MODEL || null,
    baseUrl: process.env.OLLAMA_BASE_URL || null,
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
    botPollingInterval: parseInt(process.env.TELEGRAM_POLL_INTERVAL) || 5000,
    channels: process.env.TELEGRAM_CHANNELS || null, // Comma-separated extra channel IDs
  },

  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || null,
    channelId: process.env.DISCORD_CHANNEL_ID || null,
    guildId: process.env.DISCORD_GUILD_ID || null, // Server ID (for instant slash command registration)
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || null, // Fallback: webhook-only alerts (no bot needed)
  },

  // STT (Speech-to-Text) for 119 call processing
  stt: {
    provider: process.env.STT_PROVIDER || null, // openai | ollama
    apiKey: process.env.STT_API_KEY || process.env.LLM_API_KEY || null,
    model: process.env.STT_MODEL || null, // default: whisper-1 (openai), whisper:large-v3 (ollama)
    baseUrl: process.env.OLLAMA_BASE_URL || null,
  },

  // Geocoding for address → coordinates
  geo: {
    kakaoApiKey: process.env.KAKAO_REST_API_KEY || null,
    vworldApiKey: process.env.VWORLD_API_KEY || null,
    naverMapClientId: process.env.NAVER_MAP_CLIENT_ID || null,
    naverMapClientSecret: process.env.NAVER_MAP_CLIENT_SECRET || null,
  },

  // Ontology engine settings (Palantir/Anduril pattern)
  ontology: {
    autoEscalateMinutes: parseInt(process.env.AUTO_ESCALATE_MINUTES) || 10,
    fusionConfidenceThreshold: parseFloat(process.env.FUSION_CONFIDENCE_THRESHOLD) || 0.6,
    maxTrackAgeMinutes: parseInt(process.env.MAX_TRACK_AGE_MINUTES) || 480,
    spreadPredictionEnabled: process.env.SPREAD_PREDICTION !== 'false',
  },

  // Delta engine thresholds — fire control room specific
  delta: {
    thresholds: {
      numeric: {
        wind_speed: 10,        // 풍속 10m/s 변화 시 알림
        humidity: -15,          // 습도 15% 하락 시 알림
        temperature: 5,         // 기온 5°C 상승 시 알림
        fire_risk_index: 20,    // 산불위험지수 20점 변화
      },
      count: {
        active_fires: 1,        // 새 화재 1건 → 즉시 알림
        thermal_total: 50,      // 열점 50개 이상 변화
        dispatched_units: 3,    // 출동 차량 3대 이상 변화
        available_beds: -5,     // 가용 병상 5석 이상 감소
        sns_high_confidence: 1, // 고신뢰 SNS 신호 1건 → 즉시 알림
      },
    },
  },
};
