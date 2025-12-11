// Vercel Serverless Function for /api/chat
// Handles chat requests with Google Gemini API using Workload Identity Federation

// 캐릭터별 데모 응답
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
    "데모 응답: 서버가 현재 데모 모드입니다. 잠시 후 재시도하거나 나중에 다시 와주세요."
  ]
};

let responseIndexes = {};

function getCannedResponse(characterKey) {
  const key = (characterKey && cannedResponses[characterKey]) ? characterKey : 'generic';
  const arr = cannedResponses[key] || cannedResponses['generic'];
  if (!arr || arr.length === 0) return '데모 응답: 현재 응답을 생성할 수 없습니다.';
  
  const idx = responseIndexes[key] || 0;
  const next = arr[idx % arr.length];
  responseIndexes[key] = (idx + 1) % arr.length;
  return next;
}

module.exports = async (req, res) => {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  try {
    const { messages, character } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'Invalid messages array' } });
    }

    // 환경변수에서 Google AI Studio 설정 로드
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Google AI Studio API 키
    const FORCE_DEMO = process.env.FORCE_DEMO === 'true';

    // 디버그: API 키 존재 여부 확인
    console.log('[DEBUG] API Key exists:', !!GEMINI_API_KEY);
    console.log('[DEBUG] API Key prefix:', GEMINI_API_KEY?.substring(0, 10) + '...');

    // Google AI Studio 엔드포인트 (v1beta with gemini-pro)
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

    // 데모 모드이거나 API 키가 없으면 canned response 반환
    if (FORCE_DEMO || !GEMINI_API_KEY) {
      const canned = getCannedResponse(character);
      return res.status(200).json({
        choices: [{ message: { content: canned } }],
        note: FORCE_DEMO ? 'FORCE_DEMO enabled' : 'Missing API key',
        debug: { hasKey: !!GEMINI_API_KEY, keyPrefix: GEMINI_API_KEY?.substring(0, 10) }
      });
    }

    // 메시지 포맷팅 (Gemini 형식)
    const prompt = messages.map(m => {
      const role = m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant';
      return `[${role}] ${m.content}`;
    }).join('\n');

    // Google AI Studio API 호출
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0.7
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Google AI Studio error:', response.status, data);
      // 폴백 응답
      const canned = getCannedResponse(character);
      return res.status(200).json({
        choices: [{ message: { content: canned } }],
        original_error: data
      });
    }

    // 응답 정규화 (OpenAI 형식으로)
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '응답 없음';
    
    return res.status(200).json({
      choices: [{ message: { content } }]
    });

  } catch (error) {
    console.error('Server error:', error);
    // 에러 발생 시에도 canned response 반환
    const charKey = req.body?.character;
    const canned = getCannedResponse(charKey);
    return res.status(200).json({
      choices: [{ message: { content: canned } }],
      error_message: error.message
    });
  }
};
