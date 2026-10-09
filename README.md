# 만렙사장 지원공고

정부24 공공서비스 API에서 소상공인 관련 지원사업만 골라 → Claude로 쉬운 말 요약·분류 → 정적 사이트로 만드는 파이프라인.

```
정부24 API ──collect──▶ data/items.json ──summarize──▶ (AI 게이트 → AI 요약) ──build──▶ site/
```

- collect: 전체 1만여 건 → 규칙 필터로 800건쯤 (사용자구분 "소상공인" 태그 / 직격 키워드 / 사업체 대상 + 사업 키워드)
- summarize 1단계 게이트: Haiku 로 "사장님한테 해당되는 공고인가?" 만 전부 판정 (전체 돌려도 몇백 원)
- summarize 2단계 요약: 게이트 통과한 것만 Opus 로 요약·체크리스트·분류

## 처음 한 번

```bash
npm install
copy .env.example .env      # 키 두 개 넣기 (GOV24_API_KEY 는 "디코딩" 키)
```

## 매번

```bash
npm run collect       # 1. 수집 (신규 추가 / 변경 감지 / 사라진 공고 숨김 / 마감 판정)
npm run summarize     # 2. AI 게이트 + 요약 (없거나 원문 바뀐 것만 — 비용 아낌)
npm run links         # 3. 링크 점검 (신청 페이지·정부24 원문이 실제로 열리는지, 7일마다)
npm run build         # 4. site/ 생성
npm run serve         # 미리보기 http://localhost:4173
```
더블클릭용: `1_수집.bat` (수집+사이트) / `2_요약.bat` (AI 5건만 테스트, `2_요약.bat all` 이면 전부) / `run-all.bat` (1~3 전부)

키 없이 모양만 보려면: `npm run all:sample`

## 자주 쓰는 옵션

```bash
node src/collect.js --sample           # 샘플 데이터
node src/collect.js --raw              # API 안 부르고 data/raw 스냅샷으로 필터·파싱만 다시 (필터 조정할 때)
node src/summarize.js --dry-run        # 프롬프트만 출력 (호출 X)
node src/summarize.js --limit 5        # 각 단계 5건만 (모델 비교할 때)
node src/summarize.js --gate-only      # 게이트만
node src/summarize.js --model claude-sonnet-5-5
node src/summarize.js --id B55307700011   # 이 공고 하나만 다시 (회원 지적 받았을 때)
node src/summarize.js --force          # 전부 다시
```

## 생성되는 파일

| 파일 | 내용 |
|---|---|
| `data/items.json` | DB. 공고별 원문(src) + 상태 + AI 요약(ai). **git에 커밋** (요약 비용 보존) |
| `data/field-report.md` | API에 실제로 어떤 필드/값이 오는지 — 처음 수집 후 꼭 한 번 보기 |
| `data/review.md` | 검수 리스트: 요약 속 숫자가 원문과 안 맞거나, AI 확신도 낮거나, 관련없음 판정 + 게이트에서 제외된 목록 |
| `data/raw/` | API 원본 스냅샷 (git 제외) |
| `site/` | 배포용 정적 사이트 (git 제외, Actions가 만듦) |

## 공지사항 올리기
저장소 루트의 `notice.md` 가 첫 화면(카페 배너 아래) 공지예요. 관리자 페이지는 따로 없고 이 파일을 직접 고칩니다.

1. https://github.com/woojae32610-ops/manrep-subsidy/edit/main/notice.md 열기 (북마크 추천)
2. 주석(`<!-- -->`) 아래에 글 쓰기 — 첫 줄 `# 제목`, 빈 줄로 문단, `[글자](주소)` 는 링크
3. 오른쪽 위 **Commit changes** → 2~3분 뒤 사이트에 반영 (Actions 의 `notice` 워크플로가 자동 실행)
4. 공지를 내리려면 내용을 지우고 저장

## 자동화 (GitHub Pages)

1. 이 폴더를 GitHub 저장소로 push
2. Settings → Secrets → `GOV24_API_KEY`, `ANTHROPIC_API_KEY`
3. Settings → Pages → Source: GitHub Actions
4. 매일 06:00 KST 자동 실행 (`.github/workflows/daily.yml`), 수동 실행은 Actions 탭

## 정확도 설계

- 금액·기한·기관·전화 같은 **하드 데이터는 API 원본 필드를 그대로** 씀. AI는 요약·체크리스트·분류만.
- AI 출력은 **JSON 스키마로 강제** → 필드 누락·형식 이탈 없음, 분류는 enum.
- 요약 속 **모든 숫자를 코드로 원문과 대조** → 불일치는 `review.md`로. 그것만 사람이 보면 됨.
- 게이트(Haiku)가 "사장님 대상 아님"으로 판정한 공고는 요약 비용도 안 쓰고 자동 숨김. 제외 목록은 review.md 에서 확인.

## 1년 운용 체크리스트

- 매달: `data/review.md` 한 번 훑기 (숫자 불일치·게이트 제외 목록)
- 회원 지적 오면: 원문 확인 → `node src/summarize.js --id <서비스ID>` 로 그 건만 다시 → `npm run build`
- "링크가 안 열려요" 제보: `npm run links -- --all` 돌리면 죽은 링크는 자동으로 숨겨지고 안내 문구가 뜸
- Actions 실패 메일 오면: 대부분 키 문제. `.env`/Secrets 의 키 확인 → 수동 실행
- 사이트 상단에 "수집이 N일 전" 띠가 보이면: 자동 실행이 멈춘 것. Actions 탭 확인
- 모델 이름 바뀌면: `config.js` 의 `llm.model` / `llm.gateModel` 한 줄
- 정부24 응답이 이상하면: `node src/collect.js` 후 `data/field-report.md` 로 필드 변화 확인

## 구조

```
config.js              설정 전부 (사이트 문구, 필터 키워드, 분류 체계, 모델)
src/collect.js         1단계 수집
src/summarize.js       2단계 AI 요약
src/build.js           3단계 사이트 생성
src/lib/gov24.js       API 클라이언트
src/lib/dates.js       신청기한 파싱 → 마감 판정
src/lib/classify.js    규칙 분류 (AI 없을 때 fallback)
src/lib/prompt.js      프롬프트 + 출력 스키마
src/lib/verify.js      숫자 대조 검증
src/site/              style.css, app.js (사이트 프론트)
data/sample/           키 없이 돌릴 샘플
```
