const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

const FORCE_DEMO = (process.env.FORCE_DEMO === 'true' || process.env.FORCE_DEMO === '1');

// Mask a secret for safe logging (do not print full key)
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return `${k.slice(0,4)}...${k.slice(-4)}`;
}

// Detect available API keys (Gemini preferred; otherwise accept a custom provider via MY_API_KEY/MY_API_URL)
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = process.env.GEMINI_API_URL;

const STARTUP_KEY_SOURCE = (GEMINI_KEY && !GEMINI_KEY.includes('REPLACE'))
  ? 'GEMINI_API_KEY'
  : (process.env.MY_API_KEY && !process.env.MY_API_KEY.includes('REPLACE'))
    ? 'MY_API_KEY'
    : 'none';

const STARTUP_KEY_PREVIEW = STARTUP_KEY_SOURCE === 'GEMINI_API_KEY' ? maskKey(GEMINI_KEY)
  : (STARTUP_KEY_SOURCE === 'MY_API_KEY' ? maskKey(process.env.MY_API_KEY) : null);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ========== Rate Limiting & Security ==========
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_MINUTE = 30;

function isRateLimited(ip) {
  const now = Date.now();
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, []);
  }
  
  const times = requestCounts.get(ip);
  const recentRequests = times.filter(t => now - t < RATE_LIMIT_WINDOW);
  
  if (recentRequests.length >= MAX_REQUESTS_PER_MINUTE) {
    return true;
  }
  
  recentRequests.push(now);
  requestCounts.set(ip, recentRequests);
  return false;
}

// ========== Diagnostics & Canned Responses ==========
let lastOpenAIStatus = { status: null, timestamp: null, body: null };

// Expanded canned responses: multiple options per character with rotation
const cannedResponses = {
  horn: [
    "하하하! 전장 경험으로 말하자면, 네가 다음 수를 내기 전에 내게 묻거라. 강하게, 그러나 신중하게.",
    "전투는 예측과 타이밍이다. 다음 움직임을 준비하되, 상대의 허를 찌르는 걸 잊지 마라.",
    "내 갑옷이 닳을 때까지 싸우는 것은 용기지만, 이길 줄 아는 자가 진정한 승리자다."
  ],
  hwarin: [
    "검은 마음을 다스리고 몸을 바로잡아라. 자세가 흔들리면 기술도 흔들린다.",
    "호흡을 맞추고 중심을 잡아라. 한 번의 성공이 천 번의 연습을 대신하진 않는다.",
    "너의 검은 너 자신을 비추는 거울이다. 정확하게, 그리고 단호하게 베어라."
  ],
  kai: [
    "어이 챔피언, 부품은 여기서 구해. 싸게 해줄게. 다음엔 더 강한 삽질로 돌려줄게~",
    "장비가 최고라고? 기술이 먼저다. 그래도 좋은 장비면 일이 쉬워지지.",
    "내가 고쳐주지 못하는 건 거의 없지. 다음엔 더 강한 업그레이드를 준비해 둬라."
  ],
  d: [
    "안녕, 난 D야. 언제든지 이야기해줘 — 조용히 듣고 바로 답해줄게.",
    "D: 새로운 아이디어가 떠오르면 메모해. 나중에 함께 다듬자.",
    "D가 왔다! 오늘 기분은 어때? 작은 것부터 같이 해결해보자."
  ],
  generic: [
    "죄송합니다 — 현재 실시간 응답을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    "데모 응답: 서버가 현재 데모 모드입니다. 잠시 후 재시도하거나 나중에 다시 와주세요.",
    "현재 OpenAI 사용량이 초과되어 실시간 응답을 제공할 수 없습니다. 곧 복구됩니다."
  ]
};

// Keep a rotation index per character for round-robin selection
const responseIndexes = new Map();

function getCannedResponse(characterKey) {
  const key = (characterKey && cannedResponses[characterKey]) ? characterKey : 'generic';
  const arr = cannedResponses[key] || cannedResponses['generic'];
  if (!arr || arr.length === 0) return '데모 응답: 현재 응답을 생성할 수 없습니다.';

  // Round-robin index
  const idx = responseIndexes.get(key) || 0;
  const next = arr[idx % arr.length];
  responseIndexes.set(key, (idx + 1) % arr.length);
  return next;
}

// small LRU-like cache for demo responses (keyed by character)
const demoCache = new Map();
function cacheDemoResponse(characterKey, response) {
  demoCache.set(characterKey, { response, ts: Date.now() });
  // keep cache small
  if (demoCache.size > 10) {
    const firstKey = demoCache.keys().next().value;
    demoCache.delete(firstKey);
  }
}


// ========== Middleware ==========
app.use((req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('X-XSS-Protection', '1; mode=block');
  next();
});

// Serve static site (index.html and assets)
app.use(express.static(path.join(__dirname), { 
  index: 'index.html',
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.html')) {
      res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Fallback to index.html for SPA routing
// (SPA fallback moved below after API routes)

// ========== API: Chat Completions Proxy ==========
app.post('/api/chat', async (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  
  // Rate limiting
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ 
      error: { message: 'Too many requests. Please try again later.' } 
    });
  }

  // Select provider and API key (Gemini preferred; otherwise use custom provider via MY_API_KEY)
  const GEMINI_KEY_RUNTIME = process.env.GEMINI_API_KEY;
  const GEMINI_URL_RUNTIME = process.env.GEMINI_API_URL;
  let provider = 'none';
  let apiKey = null;
  let endpoint = null;
  if (GEMINI_KEY_RUNTIME) {
    provider = 'gemini';
    apiKey = GEMINI_KEY_RUNTIME;
    endpoint = GEMINI_URL_RUNTIME || null; // require URL for Gemini
  } else if (process.env.MY_API_KEY) {
    provider = 'custom';
    apiKey = process.env.MY_API_KEY;
    endpoint = process.env.MY_API_URL || null; // custom provider should set URL
  }

  // If force-demo is enabled, or no provider/key/endpoint is set, return demo response
  if (FORCE_DEMO || provider === 'none' || !apiKey || apiKey.includes('REPLACE') || !endpoint) {
    const charKey = req.body.character;
    const canned = getCannedResponse(charKey);
    let note = undefined;
    if (provider === 'gemini' && !endpoint) note = 'GEMINI_API_URL가 설정되지 않았습니다. .env에 GEMINI_API_URL을 추가하세요.';
    if (provider === 'custom' && !endpoint) note = 'MY_API_URL가 설정되지 않았습니다. .env에 MY_API_URL을 추가하세요.';
    return res.status(200).json({
      choices: [{
        message: {
          content: canned
        }
      }],
      note
    });
  }

  try {
    const { model, messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ 
        error: { message: 'Invalid request: missing or invalid messages array.' } 
      });
    }

    // Forward to provider endpoint with conservative token limits to avoid quota spikes
    const modelToUse = model || 'gemini-pro';
    const requestedMax = parseInt(req.body.max_tokens || '128', 10) || 128;
    const maxTokens = Math.min(Math.max(requestedMax, 16), 1024); // clamp (Gemini may allow larger)

    // Build request URL and headers. For Gemini with service account we will use Authorization: Bearer <token>
    let requestUrl = endpoint;
    const headers = { 'Content-Type': 'application/json' };

    // If using service account credentials, obtain OAuth2 access token
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS && provider === 'gemini') {
      const auth = new GoogleAuth({ keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
      const client = await auth.getClient();
      const tokenRes = await client.getAccessToken();
      const token = (tokenRes && tokenRes.token) ? tokenRes.token : (typeof tokenRes === 'string' ? tokenRes : null);
      if (!token) throw new Error('Failed to obtain access token from service account');
      headers['Authorization'] = `Bearer ${token}`;
    } else if (provider === 'gemini') {
      // If not using service account, use API key in URL (already validated earlier)
      if (apiKey) {
        if (requestUrl.includes('YOUR_API_KEY')) {
          requestUrl = requestUrl.replace(/YOUR_API_KEY/g, encodeURIComponent(apiKey));
        } else if (/[?&]key=[^&]*/.test(requestUrl)) {
          requestUrl = requestUrl.replace(/([?&]key=)[^&]*/, `$1${encodeURIComponent(apiKey)}`);
        } else {
          requestUrl += (requestUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(apiKey);
        }
      }
    } else {
      // custom provider using MY_API_KEY/MY_API_URL
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Ensure requestUrl is absolute
    if (requestUrl && !/^https?:\/\//i.test(requestUrl)) {
      requestUrl = 'https://' + requestUrl;
    }

    // Map OpenAI-style messages -> single prompt text for Gemini generateContent/generateText
    const combined = (messages || []).map(m => {
      return (m.role ? (`[${m.role}] `) : '') + (m.content || '');
    }).join('\n');

    // Construct Gemini-style body (best-effort): use 'input' with text field and maxOutputTokens
    const body = {
      model: modelToUse,
      // 'input' or 'prompt' may vary by endpoint; using a generic 'input' wrapper
      input: { text: combined },
      temperature: 0.7,
      maxOutputTokens: maxTokens
    };

    const resp = await fetch(requestUrl, { method: 'POST', headers, body: JSON.stringify(body) });
    const bodyText = await resp.text();
    let parsed = null;
    try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch (e) { parsed = { raw: bodyText }; }
    lastOpenAIStatus = { provider, status: resp.status, timestamp: new Date().toISOString(), body: (parsed && parsed.error && parsed.error.message) ? parsed.error.message : (typeof bodyText === 'string' ? bodyText.slice(0, 500) : null) };

    if (resp.status === 429) {
      console.warn(`${provider} returned 429; returning canned/demo response instead.`);
      const charKey = req.body.character;
      const canned = getCannedResponse(charKey);
      cacheDemoResponse(charKey || 'generic', canned);
      return res.status(200).json({ choices: [{ message: { content: canned } }], original_error: parsed });
    }

    if (!resp.ok) {
      // On error, fallback to demo response
      const charKey = req.body.character;
      const cached = demoCache.get(charKey);
      if (cached) return res.status(200).json({ choices: [{ message: { content: cached.response } }], note: 'served from demo cache' });
      const canned = getCannedResponse(charKey);
      cacheDemoResponse(charKey || 'generic', canned);
      return res.status(200).json({ choices: [{ message: { content: canned } }], original_error: parsed });
    }

    // Normalize Gemini response into OpenAI-like shape
    // Try several possible fields
    let textOut = null;
    if (parsed) {
      if (parsed.output_text) textOut = parsed.output_text;
      else if (parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content) textOut = parsed.candidates[0].content;
      else if (parsed.output && parsed.output[0] && parsed.output[0].content && parsed.output[0].content[0]) textOut = parsed.output[0].content[0].text || parsed.output[0].content[0].textRaw || null;
    }
    if (textOut) return res.json({ choices: [{ message: { content: textOut } }], raw: parsed });

    return res.json(parsed);

  } catch (err) {
    console.error('Error processing request:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ========== Health Check ==========
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), lastOpenAIStatus });
});

// Diagnostics endpoint: show last OpenAI status, FORCE_DEMO, key source and basic rate info
app.get('/api/diagnostics', (req, res) => {
  const rateInfo = {
    trackedClients: requestCounts.size,
    windowMs: RATE_LIMIT_WINDOW,
    maxRequestsPerMinute: MAX_REQUESTS_PER_MINUTE
  };
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    lastOpenAIStatus,
    FORCE_DEMO,
    key_source: STARTUP_KEY_SOURCE,
    key_preview: STARTUP_KEY_PREVIEW,
    gemini_url: GEMINI_URL || null,
    rateInfo
  });
});

// Fallback to index.html for SPA routing (non-API routes)
app.get(/^(?!\/api)(?!.*\.(js|css|json|jpg|png|gif|svg|ico|woff|woff2)$).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ========== Start Server ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
  console.log(`📝 API Endpoint: POST http://localhost:${PORT}/api/chat`);
  console.log(`💊 Health Check: GET http://localhost:${PORT}/api/health`);
  if (FORCE_DEMO) {
    console.log(`⚠️  FORCE_DEMO is enabled — server will return demo responses.`);
  }

  // Log which environment variable will be used for the API key (masked)
  if (STARTUP_KEY_SOURCE === 'GEMINI_API_KEY') {
    console.log(`🔑 Using Gemini key from GEMINI_API_KEY (masked): ${STARTUP_KEY_PREVIEW}`);
    console.log(`🔗 Gemini URL: ${GEMINI_URL || '(not set)'} `);
    console.log('   Tip: Set GEMINI_API_URL in .env to point to your Gemini endpoint.');
  } else if (STARTUP_KEY_SOURCE === 'OPENAI_API_KEY') {
    console.log(`🔑 Using API key from OPENAI_API_KEY (masked): ${STARTUP_KEY_PREVIEW}`);
  } else if (STARTUP_KEY_SOURCE === 'MY_API_KEY') {
    console.log(`🔑 Using API key from MY_API_KEY (masked): ${STARTUP_KEY_PREVIEW}`);
    console.log('   Tip: You can rename to OPENAI_API_KEY to prefer that variable.');
  } else {
    console.log(`⚠️  No API key found in environment. Server will return demo responses.`);
    console.log(`   Set OPENAI_API_KEY, MY_API_KEY, or GEMINI_API_KEY (and GEMINI_API_URL) in .env to enable real API calls.`);
  }
});
