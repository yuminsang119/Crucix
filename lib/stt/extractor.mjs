// NLP Extractor — Extract structured info from 119 call transcripts
// Uses LLM for high-quality extraction, regex for fallback (no LLM needed)

import { INCIDENT_TYPES } from '../ontology/entities.mjs';

// === Korean address regex patterns ===
const SIDO_NAMES = '서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주';
const ADDRESS_REGEX = new RegExp(`(?:${SIDO_NAMES})(?:특별시|광역시|특별자치시|도|특별자치도)?\\s*[가-힣]+(?:시|군|구)\\s*[가-힣]+(?:동|읍|면|리|로|길)[\\s\\d가-힣-]*`, 'g');
const ROAD_ADDRESS_REGEX = /[가-힣]+(?:로|길)\s*\d+(?:-\d+)?(?:\s*,?\s*\d+층)?/g;
const BUILDING_NAME_REGEX = /[가-힣A-Za-z0-9]+(?:빌딩|아파트|맨션|타워|센터|상가|마트|백화점|공장|학교|병원|교회|성당|사찰)/g;

// === Incident type keyword mapping ===
const INCIDENT_KEYWORD_MAP = {
  '화재': 'STRUCTURE_FIRE', '불이나': 'STRUCTURE_FIRE', '불났': 'STRUCTURE_FIRE',
  '건물.*불': 'STRUCTURE_FIRE', '아파트.*불': 'STRUCTURE_FIRE',
  '산불': 'WILDFIRE', '산에.*불': 'WILDFIRE',
  '차.*불': 'VEHICLE_FIRE', '차량화재': 'VEHICLE_FIRE', '자동차.*불': 'VEHICLE_FIRE',
  '폭발': 'EXPLOSION', '터졌': 'EXPLOSION',
  '가스.*누출': 'GAS_LEAK', '가스.*냄새': 'GAS_LEAK', '가스.*새': 'GAS_LEAK',
  '위험물': 'HAZMAT', '화학.*물질': 'HAZMAT', '유독': 'HAZMAT',
  '구조': 'RESCUE', '갇혔': 'RESCUE', '끼었': 'RESCUE', '매몰': 'RESCUE',
  '구급': 'EMS', '다쳤': 'EMS', '쓰러졌': 'EMS', '의식.*없': 'EMS',
};

// === Severity indicator keywords ===
const SEVERITY_KEYWORDS = [
  '사상자', '사망', '죽었', '매몰', '위험물', '폭발', '다수',
  '대형', '번지고', '확산', '어린이', '노인', '장애인', '임산부',
  '병원', '학교', '유치원', '양로원', '어린이집', '지하',
];

// === LLM-based extraction (primary path) ===

const EXTRACTION_PROMPT = `당신은 119 신고 전화 녹취록 분석 전문가입니다.
주어진 녹취록에서 다음 정보를 JSON으로 추출하세요.

출력 형식 (JSON만 출력, 다른 텍스트 없음):
{
  "address": "전체 주소 문자열 (최대한 구체적으로)",
  "addressParts": {
    "sido": "시도 (서울, 경기 등)",
    "sigungu": "시군구",
    "dong": "동/읍/면",
    "road": "도로명",
    "detail": "상세주소 (번지, 호수, 층)",
    "landmark": "랜드마크나 건물명"
  },
  "incidentType": "STRUCTURE_FIRE|WILDFIRE|VEHICLE_FIRE|HAZMAT|GAS_LEAK|EXPLOSION|RESCUE|EMS|OTHER",
  "severityIndicators": ["매칭된 심각도 키워드 목록"],
  "callerInfo": {
    "name": "신고자 이름 (없으면 null)",
    "relation": "관계 (목격자, 거주자, 건물관계자, 행인 등)",
    "isOnScene": true/false
  },
  "additionalDetails": "추가 정보 (층수, 연소물질, 갇힌 인원 수 등)",
  "estimatedFloor": null,
  "trappedPersons": 0,
  "fireSpreadDirection": null
}

정보가 없으면 null 또는 빈 배열로 표기하세요. 추측하지 마세요.`;

/**
 * Extract call info using LLM (primary path)
 * @param {string} transcript - Korean 119 call transcript
 * @param {object} llmProvider - LLM provider instance from lib/llm/
 * @returns {Promise<object>} extracted info
 */
export async function extractCallInfo(transcript, llmProvider) {
  if (!llmProvider?.isConfigured) {
    return extractCallInfoRegex(transcript);
  }

  try {
    const result = await llmProvider.complete(EXTRACTION_PROMPT, transcript, {
      timeout: 30000,
    });

    if (!result?.text) {
      return extractCallInfoRegex(transcript);
    }

    // Parse JSON from LLM response
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return extractCallInfoRegex(transcript);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate and normalize
    return {
      address: parsed.address || null,
      addressParts: parsed.addressParts || {},
      incidentType: INCIDENT_TYPES[parsed.incidentType] ? parsed.incidentType : 'OTHER',
      severityIndicators: Array.isArray(parsed.severityIndicators) ? parsed.severityIndicators : [],
      callerInfo: parsed.callerInfo || {},
      additionalDetails: parsed.additionalDetails || '',
      estimatedFloor: parsed.estimatedFloor || null,
      trappedPersons: parseInt(parsed.trappedPersons) || 0,
      fireSpreadDirection: parsed.fireSpreadDirection || null,
      extractionMethod: 'llm',
      confidence: 0.9,
    };
  } catch (e) {
    console.error('[STT Extractor] LLM extraction failed, falling back to regex:', e.message);
    return extractCallInfoRegex(transcript);
  }
}

/**
 * Extract call info using regex (fallback, no LLM needed)
 * @param {string} transcript
 * @returns {object}
 */
export function extractCallInfoRegex(transcript) {
  const text = transcript || '';

  // Extract address
  const addresses = text.match(ADDRESS_REGEX) || [];
  const roadAddresses = text.match(ROAD_ADDRESS_REGEX) || [];
  const buildings = text.match(BUILDING_NAME_REGEX) || [];
  const bestAddress = addresses[0] || roadAddresses[0] || buildings[0] || null;

  // Extract incident type
  let incidentType = 'OTHER';
  for (const [pattern, type] of Object.entries(INCIDENT_KEYWORD_MAP)) {
    if (new RegExp(pattern).test(text)) {
      incidentType = type;
      break;
    }
  }

  // Extract severity indicators
  const severityIndicators = SEVERITY_KEYWORDS.filter(k => text.includes(k));

  // Extract trapped persons count
  const trappedMatch = text.match(/(\d+)\s*명?\s*(?:갇|매몰|끼)/);
  const trappedPersons = trappedMatch ? parseInt(trappedMatch[1]) : 0;

  // Extract floor
  const floorMatch = text.match(/(\d+)\s*층/);
  const estimatedFloor = floorMatch ? parseInt(floorMatch[1]) : null;

  // Parse address parts
  const addressParts = {};
  if (bestAddress) {
    const sidoMatch = bestAddress.match(new RegExp(`(${SIDO_NAMES})`));
    if (sidoMatch) addressParts.sido = sidoMatch[1];

    const guMatch = bestAddress.match(/([가-힣]+(?:시|군|구))/);
    if (guMatch) addressParts.sigungu = guMatch[1];

    const dongMatch = bestAddress.match(/([가-힣]+(?:동|읍|면|리))/);
    if (dongMatch) addressParts.dong = dongMatch[1];
  }
  if (buildings[0]) addressParts.landmark = buildings[0];

  return {
    address: bestAddress,
    addressParts,
    incidentType,
    severityIndicators,
    callerInfo: {},
    additionalDetails: '',
    estimatedFloor,
    trappedPersons,
    fireSpreadDirection: null,
    extractionMethod: 'regex',
    confidence: bestAddress ? 0.5 : 0.2,
  };
}
