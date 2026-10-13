# Felix 앱 + Census 프록시

정적 앱(public/index.html)과 미국 인구조사국(Census) 주별 수입 통계 프록시를 한 서버에서 제공합니다.
브라우저는 `/api/us-state-imports`만 호출하고, Census API 키는 서버 환경변수에만 있습니다.

## 구조

```
브라우저 (public/index.html)
   │  GET /api/us-state-imports?state=TX      ← 키 없음
   ▼
서버 (server.js 또는 api/us-state-imports.js)
   │  CENSUS_API_KEY 를 붙여 Census 호출, 단가 계산, 캐시
   ▼
api.census.gov/data/timeseries/intltrade/imports/statehs
```

## 실행 (Node 18 이상, 의존성 없음)

```
export CENSUS_API_KEY=...   # 셸 기록에 남지 않게 하려면 호스팅 대시보드나 비밀 관리 도구 사용
node server.js              # http://localhost:8787
```

## 환경변수 설정 위치

| 배포 방식 | 설정 위치 |
| --- | --- |
| 일반 Node 서버 (Render, Railway, Fly.io, VM) | 서비스의 Environment / Secrets 설정에 `CENSUS_API_KEY` |
| Vercel | Project → Settings → Environment Variables 에 `CENSUS_API_KEY` (public/ 은 정적 파일, api/ 는 함수로 자동 배포) |
| 로컬 개발 | 셸 환경변수. `.env` 파일을 쓸 경우 `.gitignore`에 포함돼 있어 커밋되지 않음 |

`.env.example`에는 변수 이름만 있고 값은 비어 있습니다. 실제 키를 넣지 마세요.

## Vercel 배포 순서

1. GitHub에서 새 저장소(Private 권장)를 만들고, 이 폴더 안의 파일과 폴더(api, lib, public, test, server.js, package.json, vercel.json, README.md)를 저장소 최상단에 올립니다.
2. Vercel → Add New → Project → 위 저장소 Import.
3. Framework Preset은 Other, Root Directory는 그대로(./) 둡니다. Build Command와 Output Directory는 비워 둡니다.
4. Environment Variables에 이름 `CENSUS_API_KEY`, 값에 발급받은 키를 넣습니다. (Production, Preview 모두 체크)
5. Deploy. 끝나면 `https://<프로젝트>.vercel.app/` 에서 앱이, `/api/us-state-imports?state=TX` 에서 데이터가 나옵니다.

- `public/`은 정적 파일로, `api/us-state-imports.js`는 서버리스 함수로 배포됩니다.
- `vercel.json`이 함수 실행 시간을 60초로 늘립니다. 주 하나를 처음 조회할 때 Census를 30여 번 호출하기 때문입니다.
- 함수 응답은 Vercel CDN에 1시간 캐시됩니다(`s-maxage=3600`). 키를 바꾸거나 새로 넣은 뒤에는 Redeploy 해야 반영됩니다.

## API

`GET /api/us-state-imports?state=TX` (TX, CA, LA, IL, OH, MI, PA, AL)

- 단가(달러/t) = (VES_VAL_MO + AIR_VAL_MO) / (VES_WGT_MO + AIR_WGT_MO) × 1000. GEN_VAL_MO는 쓰지 않습니다.
- 중량이 0이거나 응답이 없으면 `status: "nodata"`.
- 최신 월: 지난달부터 최대 8개월 거꾸로 조회해 데이터가 있는 첫 달. 없는 달의 값은 만들지 않습니다.
- 전월 단가를 함께 조회해 전월 대비 변동을 계산합니다.
- 캐시: 주별 결과 12시간, 최신 월 6시간 (서버 메모리). 동시에 들어온 같은 요청은 한 번만 조회합니다.
- 오류: 키 없음 503, Census 오류 502, 지원하지 않는 주 400. 로그와 응답에 키나 키가 포함된 URL을 남기지 않습니다.

## 테스트

```
node --test test/census.test.js
```

통합 테스트용 가짜 Census 서버: `MOCK_EXPECT_KEY=테스트키 node test/mock-census.js` 후
`CENSUS_API_KEY=테스트키 CENSUS_API_BASE=http://127.0.0.1:8799 node server.js`.
`CENSUS_API_BASE`는 테스트 전용이며 운영에서는 설정하지 않습니다.

## 필수 출처 고지

This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.

## 일본 e-Stat

- 환경변수 `ESTAT_APP_ID` (Vercel → Settings → Environments → Production → Environment Variables).
- `GET /api/jp-probe`: 재무성 무역통계 品別国別表 표 목록과 최신 수출·수입 표의 구조(차원, 코드 예시, 열연 코일 샘플 값)를 보여주는 진단용 주소. 결과는 1시간 캐시. 앱 ID는 응답·로그에 넣지 않습니다.
- `GET /api/jp-trade`: 일본 품목별 수출·수입 단가(엔/t). 최신 연도 品別国別表(수출·수입)를 자동으로 찾아, 표 이름의 마지막 월과 전월을 계산합니다.
  - 단가 = 금액(千円) × 1,000 ÷ 수량(t). 수량 단위가 MT·KG가 아닌 세부 품목은 제외. 100t 미만은 lowVolume.
  - 철강 제품·스크랩·정련동은 수출, 원료·나머지 비철은 수입. 수입 최신 월은 9자리 속보일 수 있음(preliminary).
  - 캐시: 표 구조 6시간, 데이터 12시간. e-Stat 동시 호출 3개.
- 서비스에 표시할 크레딧: このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。

## 한국 관세청 (진행 중)

- 환경변수 `CUSTOMS_SERVICE_KEY`: 공공데이터포털 마이페이지의 일반 인증키 중 **Decoding** 키 (Encoding 키를 넣어도 서버가 풀어서 씁니다).
- `GET /api/kr-probe`: 품목별 국가별 수출입실적 API가 국가 지정·HS 자릿수에 따라 어떻게 응답하는지 6가지 사례로 확인하는 진단 주소. 키는 응답·로그에 넣지 않습니다.
