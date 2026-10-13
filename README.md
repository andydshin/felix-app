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

## 한국 관세청

- 환경변수 `CUSTOMS_SERVICE_KEY`: 공공데이터포털 마이페이지의 일반 인증키 중 **Decoding** 키 (Encoding 키를 넣어도 서버가 풀어서 씁니다).
- `GET /api/kr-probe`: 품목별 국가별 수출입실적 API가 국가 지정·HS 자릿수에 따라 어떻게 응답하는지 6가지 사례로 확인하는 진단 주소. 키는 응답·로그에 넣지 않습니다.
- `GET /api/kr-trade`: 한국 품목별 수입 통관 단가(달러/t). 철강 9종(imp1~9)과 비철 1차 금속 6종(nf1~6: 7601.10, 7403.11, 7901.11, 7801.10, 8001.10, 7502.10). 국가를 생략해 전 국가 합계를 내고, 중국산·일본산 단가와 상위 수입국을 함께 돌려줍니다. 최근 4개월을 한 번에 받아 최신 월과 전월을 계산합니다(‘총계’ 행은 기간 합계라 쓰지 않음). 캐시 12시간.

## 관세청 관세환율

- `GET /api/fx`: 관세청 관세환율정보(GW)의 수입 과세환율(주간, 원화 기준). 최신 주·전주(USD, CNY, JPY100)와 최근 3개월 월평균. 인증키는 `CUSTOMS_SERVICE_KEY` 공용. 이용허락범위 제한 없음, 개발·운영 자동승인.
- `GET /api/fx-probe`: 요청 형식별 응답 진단.
- `/api/jp-trade`는 이 월평균으로 엔/t를 달러/t(`unitPriceUsd`)로 환산합니다. 환율을 못 받으면 엔화만 돌려줍니다.
- `/api/kr-trade`에 원료 2종(raw3 철광석 2601, raw4 역청탄 2701.12)과 수급 sd1(중국산 72류 철강재 수입량, 7201~7205 제외)을 추가했습니다.

## KOSIS 생산자물가지수

- 환경변수 `KOSIS_API_KEY` (KOSIS 공유서비스 OpenAPI 인증키).
- `GET /api/kr-ppi`: 한국은행 생산자물가지수(2020=100) 철강 8종. 표는 '생산자물가지수' 검색 결과에서 기본분류 표(DT_404Y014)를 고르고, 없는 품목은 품목별 표(DT_404Y016)에서 찾습니다. 품목 코드는 이름으로 찾습니다(찾은 이름 matchedName을 함께 반환). 캐시 12시간.
- `GET /api/kr-ppi-probe`: 고른 표·후보 표·찾은 품목·샘플 값 진단.
- 출처 표시: 한국은행, 「생산자물가조사」, KOSIS.

## 한국수출입은행 환율

- 환경변수 `KOREAEXIM_API_KEY` (수출입은행 사이트에서 발급, 공공데이터포털 키와 별개).
- `GET /api/fx-daily`: 최근 영업일·전 영업일 매매기준율(USD, CNH, JPY100). 주말은 건너뛰고, 오늘 값이 없으면(오전 11시 이전·공휴일) 이전 날짜로 물러납니다. 앱 환율 탭은 이 값을 우선 표시하고, 없으면 관세청 과세환율을 보여 줍니다.
- `GET /api/fx-daily-probe`: 최근 5일 응답 진단(결과 코드, 연결 실패 원인).
- `vercel.json`의 `regions: ["icn1"]`로 함수를 서울 리전에서 실행합니다.

## 미국 BLS 생산자물가지수

- 환경변수 `BLS_API_KEY` (BLS Public Data API v2 등록키, 이메일 활성화 필요). 퍼블릭 도메인.
- `GET /api/us-ppi`: 미국 방향 3종 — 철강재 전체(WPU1017), 냉연(WPU101707), 철스크랩(WPU1012) + 국가 비교 표용 gl4 열연 봉·판·형강(WPU101704), gl5 강관(WPU101706). BLS가 REQUEST_FAILED를 주면 두 번 더 시도(마지막은 catalog 없이). 최신·전월, 예비치(P) 표시. 캐시 12시간.
- `GET /api/us-ppi-probe`: 후보 시리즈의 공식 제목과 최신값 진단.

## Vercel 함수 구조 (Hobby 플랜 12개 제한 대응)

- 모든 `/api/*` 요청은 `api/router.js` 함수 하나가 받습니다(`vercel.json`의 rewrites). 경로별 처리는 `lib/routes.js`.
- 예전 개별 함수 파일(api/us-ppi.js 등)이 저장소에 남아 있으면 `.vercelignore`가 배포에서 뺍니다.

## 중국 국가통계국 유통가격

- 키 없음. `GET /api/cn-prices`: 국가통계국 최신 발표 목록(sj/zxfb)에서 「流通领域重要生产资料市场价格变动情况」 최신 글을 찾아 표를 읽습니다. 철강 6종·焦煤·焦炭(cn1~cn8)과 비철 4종(铜·铝·铅·锌). 캐시 6시간.
- `GET /api/cn-prices-probe`: 목록에서 찾은 링크와 파싱 결과 진단.
- 페이지 구조가 바뀌면 읽기에 실패할 수 있습니다. 실패하면 앱은 기존(수기) 값을 그대로 보여 줍니다.

## 세계은행 원자재 월평균 (Pink Sheet)

- 키 없음, CC BY 4.0. `GET /api/world-prices`: 세계은행 Commodity Markets 안내 페이지에서 CMO-Historical-Data-Monthly.xlsx 링크를 찾아(못 찾으면 마지막 확인 주소 또는 `WB_XLSX_URL`) 'Monthly Prices' 시트를 읽습니다. 철광석, 호주산 석탄, 알루미늄·구리·납·주석·니켈·아연. 캐시 12시간.
- xlsx는 의존성 없이 `lib/xlsx-lite.js`로 읽습니다.
- `GET /api/world-prices-probe`: 파일 주소·크기·파싱 결과 진단.

## 인도 WPI

- 키 없음. `GET /api/in-wpi-probe`: eaindustry.nic.in/download_data_2223.asp에서 최신 `wpi_monthly_index_YYYYMM.xlsx`를 찾아 첫 시트의 머리글·품목 후보(철강·원료·비철)를 보여 줍니다. `/api/in-wpi`는 국가 비교 표 인도 열에 연결됩니다. 철강은 코드 131401(기본 철강), 비철은 131402(비철 기본금속) 범위 안에서만 품목을 찾습니다.
