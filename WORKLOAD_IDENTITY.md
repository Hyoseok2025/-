워크로드 아이덴티티 제휴(Workload Identity Federation) 안내

개요
- 워크로드 아이덴티티 제휴는 Google Cloud 외부(온프레미스, AWS, Azure, CI/CD 등)에 있는 애플리케이션이 서비스 계정 키(JSON)를 사용하지 않고도 Google Cloud 리소스에 안전하게 접근하도록 해줍니다.
- 외부 ID 공급자(IdP)에서 발급한 토큰을 Google의 보안 토큰 서비스(STS)에 교환하면 짧은 수명의 Google OAuth2 액세스 토큰을 얻습니다.
- 주요 장점: 키 관리 부담 제거, 권한 분리, 보안 향상.

주요 개념
- 워크로드 아이덴티티 풀(Workload Identity Pool): 외부 ID를 관리하는 컨테이너
- 워크로드 아이덴티티 공급자(Provider): 풀에 연결된 각 외부 IdP(AWS, OIDC, SAML 등)
- 제휴 토큰(Token exchange): 외부 토큰 → Google STS → Google 액세스 토큰
- 속성 매핑(Attribute mapping): 외부 IdP 클레임을 google.subject 또는 attribute.*로 매핑
- 서비스 계정 가장(Service Account Impersonation): 외부 주체에게 서비스 계정 역할을 위임하는 패턴(roles/iam.serviceAccountTokenCreator 필요)

언제 사용하나?
- 애플리케이션이 GCP 외부에서 실행되며 JSON 키를 발행/관리하기 어렵거나 허용되지 않을 때
- CI/CD(예: GitHub Actions), 멀티클라우드(AWS/Azure), 온프레미스에서 안전하게 GCP 리소스에 접근해야 할 때

설정 요약(예시: OIDC / GitHub 또는 AWS)
1) 워크로드 아이덴티티 풀 생성
```bash
gcloud iam workload-identity-pools create POOL_ID \
  --project=PROJECT_ID --location="global" \
  --display-name="my-pool"
```

2) 공급자(Provider) 생성 (예: OIDC)
```bash
gcloud iam workload-identity-pools providers create-oidc PROVIDER_ID \
  --project=PROJECT_ID --location="global" \
  --workload-identity-pool=POOL_ID \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --allowed-audiences="YOUR_AUDIENCE" \
  --display-name="github-actions-provider"
```
- AWS의 경우 `create-aws` 형식 사용. GitHub Actions/Cloud Build 등 각 IdP 설명서 참조.

3) 속성 매핑 구성(예시)
- `google.subject=assertion.sub` 또는
- `google.subject='github::' + assertion.repository + '::' + assertion.actor`
- 여러 커스텀 속성은 `attribute.NAME=...`으로 설정 가능

4) IAM 바인딩: 주체(Principal) 또는 principalSet에 역할 부여
- 직접 접근(Direct resource access): 외부 주체에 프로젝트/리소스 역할을 직접 부여
- 서비스 계정 가장(Impersonation): 서비스 계정에 `roles/iam.workloadIdentityUser` 부여하여 외부 ID가 해당 SA로 작업

예시: 서비스 계정 가장 권한 부여
```bash
gcloud iam service-accounts add-iam-policy-binding sa@PROJECT_ID.iam.gserviceaccount.com \
  --member="principal://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/subject/SUBJECT_VALUE" \
  --role="roles/iam.serviceAccountTokenCreator"
```

로컬/배포환경에서의 인증 흐름 (권장 순서)
- Cloud Run / GKE (Workload Identity) 배포: 애플리케이션은 ADC(Application Default Credentials)를 통해 자동으로 자격증명을 가져옵니다.
- 외부(예: 온프레/CI): 워크로드 아이덴티티 제휴를 사용하여 STS 토큰을 교환하고 ADC로 사용.
- 임포스네이션: 관리자가 임포스네이션 권한을 부여하면, 운용 주체(사람이나 CI)가 서비스 계정을 가장하여 토큰을 얻을 수 있습니다.

Cloud Run 배포(간단 예)
1) 빌드 및 푸시
```bash
gcloud builds submit --tag gcr.io/PROJECT_ID/your-app
```
2) Cloud Run에 배포 (서비스 계정 연결)
```bash
gcloud run deploy your-app --image gcr.io/PROJECT_ID/your-app --platform managed \
  --region=REGION --service-account=sa@PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars GEMINI_API_URL=https://generativelanguage.googleapis.com
```
- Cloud Run에 서비스 계정을 직접 할당하면 워크로드는 ADC를 통해 자격증명을 사용합니다.

GKE + Workload Identity (요약)
1) GKE 클러스터에서 Workload Identity 활성화
2) GCP 서비스 계정 생성 및 역할 부여
3) Kubernetes 서비스어카운트 생성 후 주석(annotation)으로 GCP 서비스 계정과 연결
4) 파드에서 ADC를 통해 자동으로 GCP 자격증명을 사용

테스트 및 디버깅
- ADC 확인(로컬):
```bash
# 로컬에서 ADC 로그인
gcloud auth application-default login
# 확인
python -c "from google.auth import default; creds, proj = default(); print(type(creds))"
```

- 임포스네이션(로컬 gcloud에서 테스트):
```bash
# 관리자에게 다음 권한이 필요: 호출 주체에게 roles/iam.serviceAccountTokenCreator
gcloud auth print-access-token --impersonate-service-account=sa@PROJECT_ID.iam.gserviceaccount.com
```
- STS 교환(워크로드 아이덴티티 풀 사용 예, 고급):
  - 외부 토큰을 받아 Google STS로 보내 교환하고 받은 액세스 토큰으로 API 호출
  - 이는 보통 제공되는 라이브러리나 Google-auth 플러그인으로 처리

서버(이 레포) 통합 권장 설정
- 로컬 개발
  - ADC 우선: `gcloud auth application-default login` 실행 후 서버 재시작
  - 또는 임시로 `IMPERSONATE_SA=sa@PROJECT_ID.iam.gserviceaccount.com`를 `.env`에 추가하여 임포스네이션 경로 테스트
- 프로덕션(권장)
  - Cloud Run: 서비스 계정 연결(ADC 자동 사용)
  - GKE: Workload Identity로 k8s 서비스어카운트와 GCP 서비스 계정 매핑
  - 외부(예: GitHub Actions): 워크로드 아이덴티티 풀 + provider 설정 후 STS 토큰 교환

보안 권고
- 서비스 계정 JSON 키 파일은 생성하지 않는 것이 안전합니다(가능하면 조직 정책으로 차단).
- 임포스네이션을 사용할 경우 최소 권한 원칙(roles/iam.serviceAccountTokenCreator)을 최소 범위로만 부여하세요.
- 속성 매핑(attribute mapping)을 사용해 허용된 IdP 토큰만 풀에 통과시키세요.

추가 자료
- 공식 문서: https://cloud.google.com/iam/docs/workload-identity-federation
- Workload Identity Pools API 참조: https://cloud.google.com/iam/docs/reference/rest/v1/projects.locations.workloadIdentityPools

---

이 문서를 바탕으로 `README.md`에 짧은 배포 섹션을 추가하거나, 제가 Cloud Run 배포 스크립트 샘플을 `deploy/` 폴더로 추가해 드릴까요? 원하는 작업을 알려주세요.
