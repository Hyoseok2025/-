# Vercel + GitHub + Google Cloud Workload Identity Federation 배포 가이드

## 개요
이 프로젝트는 **서비스 계정 키 없이** Google Cloud의 Gemini API를 안전하게 호출하기 위해 **Workload Identity Federation**을 사용합니다.

### 배포 환경
- **코드 저장소**: GitHub
- **호스팅**: Vercel (서버리스 함수)
- **인증**: GitHub Actions OIDC → Google Cloud Workload Identity Federation
- **API**: Google Gemini (Generative AI)

---

## 1단계: Google Cloud 설정

### 1.1 프로젝트 및 API 활성화
```bash
# 프로젝트 ID 설정
export PROJECT_ID="your-project-id"
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")

# Gemini API 활성화
gcloud services enable aiplatform.googleapis.com --project=$PROJECT_ID
gcloud services enable iamcredentials.googleapis.com --project=$PROJECT_ID
gcloud services enable sts.googleapis.com --project=$PROJECT_ID
```

### 1.2 서비스 계정 생성
```bash
# Gemini 호출용 서비스 계정 생성
gcloud iam service-accounts create gemini-caller \
  --display-name="Gemini API Caller" \
  --project=$PROJECT_ID

# 서비스 계정에 필요한 역할 부여
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:gemini-caller@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

### 1.3 Workload Identity Pool 생성
```bash
# 워크로드 아이덴티티 풀 생성
gcloud iam workload-identity-pools create github-pool \
  --project=$PROJECT_ID \
  --location="global" \
  --display-name="GitHub Actions Pool"

# 풀의 전체 이름 확인
gcloud iam workload-identity-pools describe github-pool \
  --project=$PROJECT_ID \
  --location="global" \
  --format="value(name)"
```

### 1.4 GitHub OIDC Provider 등록
```bash
# GitHub Actions를 OIDC 공급업체로 등록
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --project=$PROJECT_ID \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub Actions Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --issuer-uri="https://token.actions.githubusercontent.com"
```

### 1.5 서비스 계정에 Workload Identity User 역할 부여
```bash
# GitHub 저장소의 특정 브랜치만 허용하는 예시
export GITHUB_REPO="Hyoseok2025/-"  # owner/repo 형식

gcloud iam service-accounts add-iam-policy-binding \
  gemini-caller@${PROJECT_ID}.iam.gserviceaccount.com \
  --project=$PROJECT_ID \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GITHUB_REPO}"
```

**보안 강화**: 특정 브랜치만 허용하려면:
```bash
# main 브랜치만 허용
--member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/subject/repo:${GITHUB_REPO}:ref:refs/heads/main"
```

---

## 2단계: GitHub Actions 워크플로 설정

### 2.1 `.github/workflows/deploy-vercel.yml` 생성

```yaml
name: Deploy to Vercel with Workload Identity

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

# GitHub OIDC 토큰 발급을 위한 권한 설정 (중요!)
permissions:
  id-token: write   # OIDC 토큰 발급
  contents: read    # 코드 체크아웃

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Authenticate to Google Cloud (Workload Identity Federation)
        id: auth
        uses: google-github-actions/auth@v2
        with:
          # Workload Identity Provider 전체 경로
          workload_identity_provider: 'projects/${{ secrets.GCP_PROJECT_NUMBER }}/locations/global/workloadIdentityPools/github-pool/providers/github-provider'
          # 서비스 계정 이메일
          service_account: 'gemini-caller@${{ secrets.GCP_PROJECT_ID }}.iam.gserviceaccount.com'
          # 토큰 형식 (access_token 필요)
          token_format: 'access_token'
          # 액세스 토큰 유효시간 (초)
          access_token_lifetime: '3600s'

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Get Access Token for Gemini
        id: get-token
        run: |
          # Workload Identity로 받은 토큰 확인
          TOKEN=$(gcloud auth print-access-token)
          echo "::add-mask::$TOKEN"
          echo "GEMINI_ACCESS_TOKEN=$TOKEN" >> $GITHUB_ENV

      - name: Deploy to Vercel
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          # Gemini API 설정
          GEMINI_API_URL: "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent"
          # 빌드 시 액세스 토큰을 환경변수로 전달 (주의: 민감정보)
          # Vercel 환경변수는 별도로 설정하거나, 런타임에 토큰 재생성 필요
        run: |
          npm install -g vercel
          # Vercel에 환경변수 설정 (production)
          vercel env add GEMINI_API_URL production <<< "$GEMINI_API_URL"
          # 배포 (production)
          vercel --prod --token=$VERCEL_TOKEN
```

### 2.2 GitHub Secrets 설정

GitHub 저장소 → Settings → Secrets and variables → Actions에서 다음 시크릿 추가:

- `GCP_PROJECT_ID`: Google Cloud 프로젝트 ID (예: `my-project-123`)
- `GCP_PROJECT_NUMBER`: 프로젝트 번호 (숫자, 예: `123456789012`)
- `VERCEL_ORG_ID`: Vercel 조직 ID
- `VERCEL_PROJECT_ID`: Vercel 프로젝트 ID
- `VERCEL_TOKEN`: Vercel 배포 토큰

---

## 3단계: Vercel 서버리스 함수 업데이트

### 3.1 Vercel 환경 설정

Vercel 프로젝트에서 런타임에 토큰을 동적으로 생성하는 방식이 가장 안전합니다. 하지만 **Vercel 서버리스 함수는 stateless**이므로, 두 가지 옵션이 있습니다:

#### 옵션 A: GitHub Actions에서 토큰을 Vercel 환경변수로 주입 (단기 토큰, 1시간)
- 장점: 간단함
- 단점: 토큰이 1시간마다 만료되므로 재배포 필요

#### 옵션 B: Vercel 함수에서 직접 Workload Identity Federation 토큰 교환 (권장)
- Vercel 함수가 호출될 때마다 Google STS에 토큰 교환 요청
- GitHub Actions에서 생성한 OIDC 토큰을 Vercel 환경변수로 저장하지 않고, **서비스 계정 가장(impersonation)** 사용

### 3.2 `server.js` → Vercel Serverless Function 변환

Vercel은 `api/` 폴더의 파일을 자동으로 서버리스 함수로 인식합니다.

**`/api/chat.js`** 수정 (Vercel 서버리스 함수 형식):

```javascript
// Vercel Serverless Function for /api/chat
const fetch = require('node-fetch');

// 환경변수에서 설정 로드
const GEMINI_API_URL = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';
const GEMINI_ACCESS_TOKEN = process.env.GEMINI_ACCESS_TOKEN; // GitHub Actions에서 주입됨

module.exports = async (req, res) => {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
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

    // 메시지 포맷팅 (Gemini 형식)
    const prompt = messages.map(m => `[${m.role}] ${m.content}`).join('\n');

    // Gemini API 호출 (Bearer 토큰 인증)
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GEMINI_ACCESS_TOKEN}`
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
      console.error('Gemini API error:', data);
      // 폴백 응답
      return res.status(200).json({
        choices: [{ message: { content: `[데모 응답] 현재 API를 사용할 수 없습니다. (${character})` } }],
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
    return res.status(500).json({ error: { message: error.message } });
  }
};
```

---

## 4단계: 배포 및 테스트

### 4.1 GitHub에 코드 푸시
```bash
git add .
git commit -m "Add Vercel deployment with Workload Identity Federation"
git push origin main
```

### 4.2 GitHub Actions 실행 확인
- GitHub 저장소 → Actions 탭에서 워크플로 실행 확인
- `Authenticate to Google Cloud` 스텝에서 OIDC 토큰 교환 성공 확인

### 4.3 Vercel 배포 확인
- Vercel 대시보드에서 배포 상태 확인
- 환경변수 설정 확인 (`GEMINI_API_URL`, `GEMINI_ACCESS_TOKEN`)

### 4.4 프론트엔드 테스트
```bash
# 로컬에서 Vercel CLI로 테스트
npm install -g vercel
vercel dev
```

브라우저에서 `http://localhost:3000` 접속 후 채팅 기능 테스트

---

## 5단계: 보안 강화 (선택사항)

### 5.1 속성 조건 추가 (특정 브랜치만 허용)
```bash
# Workload Identity Pool Provider에 속성 조건 추가
gcloud iam workload-identity-pools providers update-oidc github-provider \
  --project=$PROJECT_ID \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --attribute-condition="assertion.repository=='Hyoseok2025/-' && assertion.ref=='refs/heads/main'"
```

### 5.2 토큰 유효 시간 단축
GitHub Actions에서 `access_token_lifetime: '1800s'` (30분)로 설정

### 5.3 Vercel 환경변수 암호화
Vercel 대시보드에서 환경변수를 암호화하여 저장 (자동 처리됨)

---

## 문제 해결

### 오류: "Permission denied" (Workload Identity)
- 서비스 계정에 `roles/iam.workloadIdentityUser` 역할이 부여되었는지 확인
- `principalSet` 또는 `principal`의 repository 경로가 정확한지 확인
- GitHub Actions 워크플로에 `permissions: id-token: write` 설정 확인

### 오류: "Token expired"
- GitHub Actions에서 `access_token_lifetime` 연장
- Vercel 함수가 호출될 때마다 토큰 재생성하도록 수정 (옵션 B)

### Gemini API 400 오류
- 요청 바디 형식 확인 (`contents` 필드)
- 공식 Gemini API 문서와 비교: https://ai.google.dev/api/rest/v1beta/models/generateContent

---

## 참고 자료
- [Google Cloud Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation)
- [GitHub Actions OIDC with GCP](https://cloud.google.com/iam/docs/workload-identity-federation-with-github)
- [Vercel Environment Variables](https://vercel.com/docs/concepts/projects/environment-variables)
- [Gemini API Reference](https://ai.google.dev/api)
# Deployment test
