# Simple RDB 전체 품질 검토 및 개선 계획

- **대상**: Simple RDB VS Code 확장 v0.0.2 (`src/` 약 3,500 LOC, 의존성 `mysql2`·`ssh2`)
- **작성일**: 2026-07-17
- **방법**: 7개 관점(보안 / DB 정확성 / UI 정확성 / 데이터 무결성 / UX·프로덕트 / 아키텍처 / 빌드·배포)으로 병렬 코드 리뷰 → 중복 제거 → 각 finding을 적대적으로 재검증(반박 시도) → 완전성 점검. 원시 147건 → 중복 제거 95건 → 검증 후 확정 **75건**(반박 기각 20건). 세션 한도로 검증이 중단된 빌드/배포 항목은 리뷰어가 직접 코드에서 재확인한 것만 §7에 별도 수록.

## 심각도 분포

| 심각도 | 건수 | 성격 |
|---|---|---|
| 🔴 Critical | 2 | 데이터 손상 / 원격 코드·SQL 주입 직결 |
| 🟠 High | 15 | 핵심 기능 오동작, 자격증명 노출, 데이터 무결성 |
| 🟡 Medium | 34 | 특정 상황 오동작, 신뢰성·UX 결함 |
| ⚪ Low | 25+ | 완성도·유지보수·배포 위생 |

> **한 줄 요약**: 편집·삭제 경로에 "조용히 잘못된 행을 건드리는" 데이터 무결성 버그가 여러 개 겹쳐 있고(가장 위험), 자격증명이 평문 저장되며, 웹뷰에 CSP·이스케이프가 없어 DB에 담긴 문자열만으로 스크립트/SQL 주입이 성립합니다. 또한 **테이블 열기 기능이 현재 코드상 항상 실패**(§3-1)하고, **배포 패키지에 플랫폼 전용 네이티브 바이너리가 포함**되어 macOS 외 환경에서는 설치가 깨질 수 있습니다.

---

## 1. 🔴 Critical

### C-1. Query Result 웹뷰에 행 데이터를 `<script>`에 직접 삽입 → 스크립트/SQL 주입 체인
`src/webview/QueryResultProvider.ts:113,469`

`const rows = ${JSON.stringify(rows)}`로 DB 결과를 `<script>` 블록 안에 그대로 인라인합니다. `JSON.stringify`는 `<`·`/`를 이스케이프하지 않으므로, 셀 값에 `</script><script>…`가 들어 있으면(웹앱의 사용자 생성 콘텐츠 등) HTML 파서가 스크립트를 조기 종료시키고 주입된 스크립트가 실행됩니다. 웹뷰에 CSP도 없습니다. 주입된 스크립트는 전역 `vscode` 바인딩으로 `postMessage({type:'updateRow'|'deleteRow'})`를 보낼 수 있고, 확장 측 핸들러(49–98행)는 **확인 다이얼로그 없이** 즉시 실행합니다. 나아가 `ConnectionManager.updateRow/deleteRow`는 컬럼 키를 백틱 이스케이프 없이 식별자에 보간하므로, 키에 백틱을 넣으면 WHERE/SET 절에 임의 SQL을 주입할 수 있습니다. 악성이 아니어도 셀에 `</script>`만 있으면 결과 패널 렌더링 자체가 깨집니다.

**개선**: 데이터를 `<script type="application/json">`에 넣고 `JSON.parse`로 읽거나 `<`,`/` 등을 이스케이프. 모든 웹뷰에 CSP + nonce 도입(→ H-8). update/delete 메시지의 컬럼 키를 `information_schema` 실제 컬럼과 화이트리스트 대조하고 식별자 백틱을 이중화.

### C-2. 쿼리 결과 뷰에서 PK 셀 편집 시 변경된 PK로 WHERE절이 만들어져 다른 행을 덮어씀
`src/webview/QueryResultProvider.ts:145` (`setNull` 237, `pasteFromClipboard` 914도 동일)

`finishEdit`가 `row[col]=newVal`로 값을 **먼저 갱신한 뒤** `pks.forEach(k => pkObj[k]=row[k])`로 WHERE용 PK를 수집합니다. 편집 대상이 PK 컬럼이면 pkObj에 "변경 후" 값이 들어가, `UPDATE … WHERE pk=<새 값>`이 실행됩니다. 예) id=5 행의 id를 6으로 고치고 name도 바꾸면 실제로는 **id=6인 다른 행**의 name이 덮어써집니다(대상이 없으면 조용히 0행). PK 셀 편집을 막는 가드도 없습니다. `TableViewProvider`는 `_original`에서 PK를 읽어 이 문제가 없습니다.

**개선**: 각 행의 원본 스냅샷(`_original`)을 유지해 pkObj는 항상 원본에서 수집. `setNull`·`pasteFromClipboard`도 동일하게 통일하고, PK 컬럼 편집은 별도 경고 플로우로 처리.

---

## 2. 🟠 High

### H-1. `getTableData` 이중 구조분해로 **테이블 데이터 조회가 항상 TypeError** — Open Table 기능 상시 실패
`src/db/ConnectionManager.ts:158-159`

`query()`는 이미 `const [rows] = await pool.query(...)`로 행 배열만 반환하는데, `getTableData`가 그 반환값을 다시 `const [countRows] = await this.query(...)`로 구조분해합니다. 그 결과 `countRows`는 `{ total: N }`가 되고 `(countRows as any[])[0].total`은 `undefined.total` → TypeError. 테이블 뷰(`openTable → fetchData`)가 항상 이 경로를 타므로 핵심 기능이 동작하지 않습니다. `dist/`의 컴파일 결과에도 동일. (any 캐스트 남용이 이 크래시를 컴파일 단계에서 은폐함 → M-26)

**개선**: `const rows = await this.query(...); const total = rows[0].total;`로 수정. `query()`의 반환 계약(행 배열)을 타입/JSDoc으로 명시.

### H-2. DB·SSH 비밀번호를 암호화되지 않은 `globalState`에 평문 저장 (SecretStorage 미사용)
`src/storage/CredentialStore.ts:25,33`

클래스명은 `CredentialStore`, 상수는 `SECRET_KEY`이지만 실제 저장은 `context.secrets`(OS 키체인 암호화)가 아니라 `context.globalState`입니다. globalState는 프로필의 `state.vscdb`(SQLite)에 **평문**으로 남습니다. `StoredConnection`에는 MySQL `password`, `ssh.password`, `ssh.passphrase`가 포함되어 모든 접속 비밀번호가 디스크에 평문으로 저장됩니다. (전 소스에 `context.secrets` 사용 전무.)

**개선**: 비밀 필드는 `context.secrets.store/get`(`secret:<connectionId>` 키)으로 분리, globalState에는 비민감 메타데이터만. 기존 평문 비밀번호를 SecretStorage로 이전 후 globalState에서 제거하는 마이그레이션 추가.

### H-3. SSH 개인키 처리 결함: 키 "경로"를 `privateKey`에 그대로 저장, passphrase 미수집·편집 시 키 소실
`src/webview/ConnectionDialog.ts:91`, `src/db/ConnectionManager.ts:98`

다이얼로그의 "SSH Private Key **Path**" 값을 `conn.ssh.privateKey`에 넣지만, ssh2의 `privateKey`는 파일 경로가 아니라 키 **내용**을 요구합니다 → 키 인증 실패. passphrase 입력 필드도 없어 암호화된 키는 사용 불가(ConnectionManager는 `undefined` 전달). 편집 시 키 경로를 복원하지 않아(30–36행) 키 기반 연결을 편집하면 키 설정이 조용히 사라집니다.

**개선**: 경로는 `privateKeyPath` 필드로 저장하고 ConnectionManager에서 `fs.readFileSync`로 내용을 읽어 전달. passphrase 필드 추가·편집 시 복원. 키 내용·passphrase도 SecretStorage 보관.

### H-4. TableView 웹뷰 XSS: 컬럼명/코멘트·테이블/DB명을 이스케이프 없이 `innerHTML`·`<title>`·JS 문자열에 삽입
`src/webview/TableViewProvider.ts:555,186,1134…`

`renderHeaders`가 `information_schema`의 `col.name/dataType/comment`를 이스케이프 없이 `innerHTML` 문자열에 연결합니다. 컬럼 코멘트/이름은 테이블 정의 권한자가 설정할 수 있어 `"><img src=x onerror=…>` 코멘트면 헤더 렌더 시 실행됩니다. 서버 측 템플릿도 `this.database/this.table`을 `<title>`과 다운로드 파일명 JS 리터럴에 미이스케이프로 넣어, 백틱 식별자로 특수문자 명명한 테이블/DB면 스크립트 실행 또는 웹뷰 전체 SyntaxError가 납니다(→ M-27도 참조).

**개선**: 헤더는 `textContent`/`escapeHtml`로 조립. `this.database/table`은 서버 측 `escapeHtml`로 `<title>`에, 파일명은 sanitize 후 삽입.

### H-5. 모든 웹뷰에 Content-Security-Policy 미설정 (`enableScripts:true`, nonce 없음)
`QueryResultProvider.ts:33`, `TableViewProvider.ts:44`, `ConnectionDialog.ts:44`

세 웹뷰 모두 CSP 메타 태그·nonce가 없어, XSS(C-1/H-4)가 성립하면 인라인 스크립트 실행은 물론 원격 `fetch`/`img`로 데이터 유출·외부 스크립트 로드까지 자유롭습니다.

**개선**: `<head>`에 `default-src 'none'; script-src 'nonce-…'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:;` 추가, 모든 `<script>`에 동일 nonce 부여.

### H-6. 커밋 프로토콜에 응답 상관관계(correlation id)가 없어 부분 실패 시 UI가 "성공"으로 표시
`QueryResultProvider.ts:167,497`, `TableViewProvider.ts:515,937`

`commitChanges`가 변경 건마다 개별 `updateRow`를 fire-and-forget으로 보내고, 웹뷰는 **첫 번째** `updateSuccess` 수신 시 pending을 전부 clear합니다. 3건 중 2번째가 제약 위반으로 실패해도 UI는 전부 반영된 듯 보이고 어떤 건이 실패했는지 알 수 없습니다. TableView는 성공마다 `refreshData`를 호출해 N건이면 N번 중복 재조회합니다.

**개선**: 커밋을 단일 `commit` 메시지(변경 목록 포함)로 보내고, 확장이 순차(가능하면 트랜잭션) 실행 후 건별 결과를 한 번에 회신. 성공한 건만 pending에서 제거, 재조회는 1회.

### H-7. 다중 SQL 문장 실행 불가 + 커서 위치 기반 문장 선택 로직 부재
`src/extension.ts:210,177`

`runQuery`는 선택이 없으면 문서 전체를 단일 `query()`로 보냅니다. 문장 분리기도, 커서 위치 문장 탐지도 없고 `multipleStatements`도 꺼져 있어(mysql2 기본), 세미콜론으로 나뉜 문장이 2개 이상인 파일에서 Cmd+Enter를 누르면 항상 구문 오류가 납니다. SQL 파일에 여러 문장을 쓰는 것이 가장 흔한 패턴이라 핵심 플로우가 사실상 단일 문장에서만 동작합니다.

**개선**: 문자열/주석/백틱을 인식하는 문장 분리기를 구현해 (1) 선택 없으면 커서 위치 문장만 실행, (2) 파일 실행 시 문장별 순차 실행·보고.

### H-8. 쿼리 결과에 LIMIT 자동 적용·행 수 제한·가상 스크롤 부재 → 대용량 SELECT 시 프리즈
`src/extension.ts:220`, `QueryResultProvider.ts:113`

결과 전체를 배열로 받아 `JSON.stringify(rows)`로 HTML `<script>`에 통째로 인라인하고, 모든 행×컬럼에 `<td>`를 생성(가상 스크롤 없음)합니다. 수십만 행 SELECT 시 메모리 폭증·웹뷰 프리즈. `retainContextWhenHidden`까지 켜져 숨긴 패널도 메모리를 점유하고, 행 선택 클릭마다 전체 `renderRows()`로 재렌더합니다.

**개선**: 설정 가능한 기본 LIMIT(예 500) 자동 부가 + "더 불러오기", 데이터는 postMessage 청크 전송, 대량 행에 가상 스크롤/페이지네이션, 선택 토글은 해당 행만 갱신.

### H-9. NULL 셀을 더블클릭 후 포커스만 옮겨도 `NULL → ''` 변경이 조용히 큐잉됨
`QueryResultProvider.ts:123`, `TableViewProvider.ts:682`

NULL 값 편집 시 `input.value=''`로 표시되는데 `blur`가 무조건 `finishEdit(value.trim())`을 호출하고, 변경 판정이 `String(null)='null' !== ''`라 **항상 변경됨**으로 처리됩니다. NULL 셀을 열었다 닫기만 해도 `NULL→''` UPDATE가 쌓이고, Apply 시 DB의 NULL이 빈 문자열로 바뀝니다. 부수적으로 편집 UI로 NULL을 입력할 방법이 없고, 모든 입력에 `.trim()`이 적용돼 앞뒤 공백이 소실됩니다(→ L-17).

**개선**: 원래 값이 NULL이고 입력이 빈 문자열이면 "변경 없음" 처리. 변경 비교에서 null을 별도 분기. 무분별한 trim 제거, NULL 입력은 명시적 UI로만.

### H-10. BIGINT 정밀도 손실 — `supportBigNumbers` 미설정으로 표시값·PK 기반 UPDATE/DELETE 오염
`src/db/ConnectionManager.ts:15`

PoolOptions에 `supportBigNumbers`/`bigNumberStrings`가 없어 BIGINT가 JS `number`로 파싱됩니다. `2^53`을 넘는 값(스노우플레이크 ID 등)은 표시부터 반올림되고, 그 값이 PK WHERE 파라미터로 쓰여 UPDATE/DELETE가 대상을 못 찾거나 잘못된 행을 건드립니다. `JSON.stringify(pkObj)` 키도 정밀도 손실로 서로 다른 두 행이 같은 키로 병합될 수 있습니다.

**개선**: `supportBigNumbers: true, bigNumberStrings: true` 추가.

### H-11. PK 없는 테이블 UPDATE의 "전체 컬럼 = 매칭" 폴백 — NULL 컬럼 있으면 0행, 중복 행은 전부 갱신, LIMIT 1 없음
`src/webview/TableViewProvider.ts:761`, `ConnectionManager.ts:174`

`getPrimaryKeys`는 PK가 없으면 모든 컬럼 값을 WHERE로 씁니다. (1) 값이 NULL인 컬럼은 `col = NULL`이 되어 절대 참이 아니라 수정이 조용히 무시되고(affectedRows 미확인으로 성공 표시 → H-12), (2) 동일 내용의 중복 행이 있으면 `LIMIT 1`이 없어 한 행만 고쳤는데 중복 행 전부가 갱신됩니다. 삭제는 `hasPrimaryKey()`로 막지만 **수정은 무제한**으로 이 경로를 탑니다.

**개선**: WHERE에서 null 값은 `col IS NULL`로 분기, PK 없는 UPDATE에 `LIMIT 1`. 더 안전하게는 수정도 차단하거나 명시적 경고.

### H-12. UPDATE/DELETE의 `affectedRows`를 확인하지 않아 0행도 성공 처리 → Query Result는 재조회 없이 행을 지워 "가짜 삭제"
`src/db/ConnectionManager.ts:183,209`, `QueryResultProvider.ts:483`

`updateRow`/`deleteRow`가 `ResultSetHeader.affectedRows`를 완전히 무시합니다. BigInt 반올림·Date 직렬화 파손·전체 컬럼 매칭 NULL·타 세션 선행 수정 등으로 WHERE가 0행에 매칭돼도 성공이 전송됩니다. 특히 QueryResult는 `deleteSuccess` 시 재조회 없이 로컬 배열에서 `splice`로 행을 제거해, DB에 남은 행이 화면에서 사라져 사용자는 삭제 완료로 확신합니다.

**개선**: `affectedRows`를 받아 0이면 오류 반환("대상 행을 찾지 못했습니다"), 1 초과(의도치 않은 다중 매칭)도 감지. 삭제 성공 처리도 affectedRows 기반으로만.

### H-13. Date 값의 postMessage/JSON 왕복 파손 — `_original`이 UTC ISO 문자열이 되어 WHERE 불일치
`src/webview/TableViewProvider.ts:170`

표시값은 `formatDateTime`으로 로컬 문자열화하지만 `_original = {...row}`에는 Date 객체가 그대로 들어가고, postMessage JSON 직렬화에서 `…T…Z`(UTC ISO)로 바뀝니다. `getPrimaryKeys`가 `_original` 값으로 WHERE를 만들므로 DATETIME이 PK에 포함되거나 PK 없는 전체 컬럼 매칭에 시간 컬럼이 있으면 타임존·`Z` 차이로 0행 매칭 후 성공 보고됩니다. `formatDateTime`은 밀리초를 버려 DATETIME(3)/(6) 정밀도도 손실.

**개선**: Date를 postMessage 전에 명시적으로 `YYYY-MM-DD HH:mm:ss[.ffffff]`로 변환해 `_original`에 저장. 정밀도 보존이 필요하면 mysql2 `dateStrings: true`가 가장 안전.

### H-14. Query Result에서 DATETIME이 UTC ISO 문자열로 표시됨 — `formatDateTime`이 import만 되고 미사용
`src/webview/QueryResultProvider.ts:2,113`

runQuery 결과의 Date를 `JSON.stringify`가 `toISOString()`(UTC)으로 바꿔, 사용자는 로컬 저장 시각 대신 시간대가 밀린 ISO 문자열을 봅니다. 같은 데이터를 TableView는 로컬 `YYYY-MM-DD HH:MM:SS`로 표시해 두 뷰가 다른 시각을 보여줍니다(예: KST에서 `DATE '2024-01-15'`가 `2024-01-14T15:00:00.000Z`로 하루 어긋남). 2행의 `formatDateTime` import는 실제로 어디서도 쓰이지 않습니다.

**개선**: rows 직렬화 전에 Date를 `formatDateTime`으로 변환해 두 뷰의 표시·시간대 통일.

### H-15. 배포 패키지에 macOS arm64 전용 네이티브 바이너리(`.node`)가 포함 — 타 플랫폼에서 설치 파손 (리뷰어 직접 확인)
`.vscodeignore`, `package` 스크립트 / 근거: `vsix` 내 `.node` 2개·`node_modules` 583개 파일

`.vscodeignore`가 `node_modules`를 제외하지 않아 빌드된 vsix에 `node_modules`(627개 파일 중 583개)가 통째로 들어가며, 그 안에 로컬(macOS arm64)에서 빌드된 네이티브 바이너리 `.node` 2개(ssh2의 선택적 crypto 등)가 포함됩니다. `esbuild`가 devDependencies에 있으나 번들 스크립트로 연결되어 있지 않습니다. 이 vsix를 Windows/Linux/x64 사용자가 설치하면 네이티브 모듈 로드가 실패할 수 있습니다.

**개선**: esbuild로 `dist/extension.js` 단일 번들 생성(`external: ['vscode']`), 순수 JS 의존성은 번들에 포함. 네이티브 모듈 의존을 피하거나(ssh2 pure-JS crypto) `@vscode/vsce`의 플랫폼별 패키징을 사용. `.vscodeignore`로 소스·맵·docs 제외.

---

## 3. 🟡 Medium (34건)

### DB 연결·신뢰성
- **M-1** `connect()`가 실제 접속을 검증하지 않아 잘못된 자격증명도 "연결됨"으로 표시 — mysql2 풀은 lazy. `ConnectionManager.ts:33` → connect 끝에 `SELECT 1` 검증, 실패 시 풀·터널 정리 후 throw, `connectTo` catch에서 `disconnect()`.
- **M-2** SSH 터널 소켓/서버에 `error` 핸들러가 없어 터널 끊김 시 확장 호스트 크래시 가능, `sshServer` listen 실패 시 Promise 미settle로 무한 대기. `ConnectionManager.ts:60-90` → socket/stream/server에 error 리스너, reject 처리, null 체크 후 close.
- **M-3** SSH keepalive·`close` 감지 부재로 좀비 연결·트리 상태 불일치. `ConnectionManager.ts:93` → `keepaliveInterval`, `close`/`end`에서 activeConnections 제거·트리 갱신·재연결 제안.
- **M-4** MySQL `wait_timeout` 이후 풀의 죽은 커넥션으로 유휴 복귀 첫 쿼리 실패. `ConnectionManager.ts:15` → `enableKeepAlive`, `maxIdle`/`idleTimeout` 설정 + `PROTOCOL_CONNECTION_LOST` 1회 재시도.
- **M-5** `disconnect` 에러 경로에서 SSH 리소스 미정리·`activeConnections` 잔존(pool.end reject 시 후속 정리 미도달, 호출부 unhandled rejection). `ConnectionManager.ts:40`, `ConnectionTreeProvider.ts:63` → try/finally.
- **M-6** 연결 중복 시도 경쟁 조건: connect 진행 중 재호출로 풀·SSH 터널 누수. `ConnectionTreeProvider.ts:48` → in-flight Promise 맵, 트리에 'connecting' 상태.
- **M-7** 실행 중 쿼리 취소 수단·타임아웃 전무. `ConnectionManager.ts:105` → `withProgress(cancellable)` + `KILL QUERY`, mysql2 `{sql,timeout}`.

### 보안 (Medium)
- **M-8** SSH 터널 호스트 키 검증 부재(`hostVerifier` 미지정) → MITM 위험. `ConnectionManager.ts:93` → known_hosts 대조 + TOFU.
- **M-9** 웹뷰 postMessage 페이로드 미검증(구조·컬럼 화이트리스트 없이 update/insert/delete 실행). `TableViewProvider.ts:61`, `QueryResultProvider.ts:49` → 타입별 스키마 + 컬럼/PK 화이트리스트 검증.
- **M-10** CSV 내보내기/복사에 수식 주입(`=`,`+`,`-`,`@`) 방어 없음, `\r` 미처리. `TableViewProvider.ts:1264`, `QueryResultProvider.ts:999` → 위험 접두 셀에 `'` 프리픽스, 인용 조건에 `\r` 추가.

### 편집·데이터 무결성 (Medium)
- **M-11** `originalRows` 스냅샷과 `rows` 불일치 — 삭제 후 Cancel 시 삭제된 행 데이터(PK 포함)가 아래 행에 복원, 이후 편집 커밋 시 잘못된 행 UPDATE. `QueryResultProvider.ts:228` → 행별 `_original`, deleteSuccess 시 스냅샷도 splice, updateSuccess 시 스냅샷 갱신.
- **M-12** Buffer(BLOB/BINARY)·JSON 컬럼이 `[object Object]`로 표시되고 편집 시 그 문자열이 저장돼 데이터 훼손, BINARY PK는 행 식별 불가. `TableViewProvider.ts:601` → Buffer는 hex, JSON은 `JSON.stringify`로 전달·읽기전용/타입 인지 편집.
- **M-13** `sqlParser`가 주석·문자열 리터럴을 인식 못해 편집 가능 판정 부정확(주석으로 시작하는 SELECT를 read-only, 데이터 값의 select/union/join으로 오판). `sqlParser.ts:13` → 판정 전 주석 제거·리터럴/백틱 마스킹.
- **M-14** `sqlParser`가 콤마 조인·`STRAIGHT_JOIN`을 못 잡아 조인 결과를 편집 가능으로 오판 → 조인 행 삭제 시 원본 테이블 행 삭제. `sqlParser.ts:101` → 구분자에 콤마 추가, 콤마/STRAIGHT_JOIN/NATURAL JOIN이면 편집 불가.
- **M-15** Copy as JSON이 문자열 `'NULL'`을 실제 `null`로 바꾸고 모든 타입을 문자열화, CSV/MD도 NULL 리터럴과 실값 구분 불가. `QueryResultProvider.ts:824` → 원본 rows 값 직접 직렬화, CSV는 null을 빈 필드로.

### UI/웹뷰 동작 (Medium)
- **M-16** 웹뷰 패널이 stale `ConnectionManager`를 계속 참조 → 재연결 후에도 동작 불능(트리와 불일치). `extension.ts:91` → 패널에 `connectionId`만 넘기고 매 요청마다 현재 manager 조회.
- **M-17** 연결 편집 시작 시 무조건 disconnect하고 취소해도 재연결 안 함. `extension.ts:37` → 저장 확정 시에만 disconnect→재연결, 취소 시 복구.
- **M-18** 연결 다이얼로그를 X로 닫으면 Promise가 영원히 미해결. `ConnectionDialog.ts:66` → `panel.onDidDispose(() => resolve(undefined))`.
- **M-19** 같은 테이블을 열 때마다 새 패널 생성 — `TableViewProvider.open()`의 reveal 로직이 사장. `extension.ts:91` → `connId:db:table` 키로 인스턴스 캐시.
- **M-20** 컨텍스트 메뉴가 닫혀도 `contextRow`가 남아 Delete 키/버튼이 과거 우클릭 행을 삭제 대상으로 삼음(확인 모달에 행 정보 없음). `TableViewProvider.ts:1291`, `QueryResultProvider.ts:184` → 메뉴 close 시 초기화, 확인 모달에 PK 표기.
- **M-21** 페이지 이동 시 미커밋 insert 행이 화면에서 사라지지만 커밋 대상으로 남고, 일부 삭제 성공 시 무관한 수정·추가분까지 clear. `TableViewProvider.ts:506,515` → pending insert 재표시 또는 이동 전 확인, deleteSuccess는 대상만 정리.
- **M-22** 행 삭제 확정 시 커밋 대기 중이던 수정/삽입이 전부 소실(삭제=즉시, 편집=버퍼링 비대칭). `TableViewProvider.ts:515` → 삭제된 행 pending만 제거하거나 삭제도 pending 모델로 통일.

### UX·피드백 (Medium)
- **M-23** 쿼리 실행·연결·데이터 페치 어디에도 로딩/진행 표시 없음(`withProgress` 호출 0건). `extension.ts:219` → `withProgress(Notification)` + 웹뷰 로딩 오버레이.
- **M-24** UPDATE/INSERT/DELETE의 `affectedRows`/`insertId`를 안 보여줌(비-SELECT가 "No rows returned"으로 표시). `extension.ts:253` → ResultSetHeader면 `N row(s) affected` 표시.
- **M-25** `runSqlFile`이 SELECT 결과를 결과 패널에 안 띄우고 토스트만(같은 파일 Cmd+Enter와 불일치). `extension.ts:177` → `queryResultProvider.show(...)`로 통일.
- **M-28** 트리 노드 인자가 필요한 커맨드가 커맨드 팔레트에 노출돼 무반응/TypeError. `package.json:38` → `menus.commandPalette`에 `when:false` 또는 QuickPick 폴백.
- **M-29** `cmd+enter`/`ctrl+enter`를 모든 `.sql` 파일에 바인딩해 기본 단축키·타 확장과 충돌. `package.json:152` → context key로 관리 파일에만 한정.
- **M-30** 빈 상태 안내 부재: 연결 0개 트리 완전 공백, 0행 테이블 "Page 1 of 0". `package.json`/`TableViewProvider.ts:1093` → `viewsWelcome`, `Math.max(1,totalPages)`, 0건 SELECT도 헤더 있는 빈 그리드.
- **M-31** 연결 다이얼로그에 Test Connection 없음, SSH 활성 시 필수 필드·포트 검증 없음(`parseInt||3306`로 조용히 대체). `ConnectionDialog.ts:267,76` → Test 버튼, SSH 필수 검증.
- **M-32** 연결 편집 다이얼로그가 기존 SSH 키 경로를 복원 안 해 저장 시 조용히 유실(H-3과 연동). `ConnectionDialog.ts:30`.
- **M-33** Export/Advanced Copy가 현재 페이지 100행만 대상인데 미고지(우클릭 Advanced Copy도 선택과 무관하게 전체 페이지 복사). `TableViewProvider.ts:1120,1228` → 'Current page/All rows' 선택지, Advanced Copy는 선택 범위만.

### 아키텍처 (Medium)
- **M-26** 메시지 프로토콜·경계 전반의 `any` 남용·마법 문자열로 타입 안전성 부재(이 문화가 H-1 크래시를 은폐). `QueryResultProvider.ts:5` 외 → discriminated union 프로토콜 모듈, `manager: ConnectionManager`, 커맨드 인자 타입화.
- **M-27** 웹뷰 UI 전체가 TS 템플릿 문자열에 인라인돼 문법검사·타입체크·린트·테스트 불가, 서버 값 보간으로 SyntaxError 잠복. `QueryResultProvider.ts:267`, `TableViewProvider.ts:181` → `media/*.js|css` 분리 후 `asWebviewUri` 로드, 데이터는 postMessage.
- **M-34** `QueryResultProvider`와 `TableViewProvider` 간 약 700줄 중복(CSS·컨텍스트 메뉴·복사/내보내기·편집 파이프라인·확장 측 confirmDelete)과 이미 발생한 divergence 버그(QRP `addMenuItem`이 `danger` 인자를 무시, `.danger` CSS 미정의). `TableViewProvider.ts:180` → 공용 그리드 모듈 추출.

---

## 4. ⚪ Low (25건)

### 보안·정보 노출
- **L-1** SQL 식별자(DB/테이블/컬럼명) 백틱 이스케이프 누락 → 식별자 기반 SQL 인젝션(웹뷰 XSS와 결합 시 완전 주입). `ConnectionManager.ts:157` → `escapeId` 헬퍼·컬럼 화이트리스트.
- **L-2** 드라이버 원문 에러 메시지를 사용자·웹뷰에 그대로 노출. `extension.ts:256` → 일반화 메시지 + 상세는 OutputChannel.
- **L-3** 편집 다이얼로그가 비밀번호를 웹뷰 HTML `value` 속성에 평문 임베드. `ConnectionDialog.ts:230` → 빈 값 + placeholder, 비우면 기존 유지.

### 정확성·리소스
- **L-4** 확장 비활성화 시 활성 연결·SSH 터널 정리 없음(`deactivate` 비어 있음), `treeView` 미등록. `extension.ts:264` → `disconnectAll()` + `subscriptions.push`.
- **L-5** `runSqlFile`에서 'Connect' 선택 후 연결만 하고 실행 안 함(runQuery와 불일치). `extension.ts:164`.
- **L-6** 결과 컬럼을 `Object.keys(results[0])`로 추출해 동명 컬럼(JOIN)이 소리 없이 병합. `extension.ts:222` → fields 메타데이터 사용.
- **L-7** 테이블 데이터 조회에 ORDER BY 없어 페이지네이션 비결정적(행 중복/누락). `ConnectionManager.ts:161` → PK 순 ORDER BY.
- **L-8** ENUM 값에 콤마·이스케이프 따옴표 포함 시 드롭다운 옵션 파손 → 존재하지 않는 값으로 UPDATE. `TableViewProvider.ts:137` → `/'((?:[^']|'')*)'/g` 파서.
- **L-9** 신규 행에 Set NULL 시 INSERT에서 컬럼 누락돼 명시적 NULL 대신 DEFAULT 저장. `TableViewProvider.ts:879` → `values[col]=null`로 명시.
- **L-10** `pendingDeletes` 삭제 대기열이 어디서도 채워지지 않는 죽은 코드(관련 확인 모달·doCommit·카운트 표시 전부 도달 불가). `TableViewProvider.ts:490` → 제거 또는 pending 삭제 모델 완성.
- **L-17** 셀 편집 입력에 무조건 `trim()` — 앞뒤 공백 값은 열어보기만 해도 변경 등록, 공백 포함 값 입력 불가. `QueryResultProvider.ts:125`, `TableViewProvider.ts:687`.

### UX·완성도
- **L-11** `WebviewPanelSerializer` 미등록 → VS Code 재시작 시 패널 미복구(무조건 `retainContextWhenHidden`은 가이드상 비권장). `QueryResultProvider.ts:29`.
- **L-12** 새 쿼리 실행 시 기존 Query Result 패널 강제 dispose — 비교 불가·미커밋 편집 소실·깜빡임. `QueryResultProvider.ts:23` → html/데이터만 교체 재사용, `ViewColumn.Beside`.
- **L-13** 빈 테이블 "Page 1 of 0", Next 연타 시 범위 초과 offset. `TableViewProvider.ts:1094` → `Math.max(1,…)`, 요청 중 버튼 비활성화.
- **L-14** 컬럼 정렬·필터·결과 내 검색 전무, `th:hover`가 클릭 가능한 것처럼 오인시키는 허위 어포던스. `TableViewProvider.ts:262` → 서버측 ORDER BY 토글·WHERE 필터, 미구현 동안 hover 제거.
- **L-15** Excel 내보내기가 HTML을 `.xls`로 위장 저장 → Excel 형식 경고, README의 `.xlsx` 안내와도 불일치. `TableViewProvider.ts:1139`.
- **L-16** 페이지 크기 고정·점프 불가·매 페이지 `COUNT(*)` 재실행·삭제 후 오프셋 초과. `TableViewProvider.ts:1093` → 페이지 크기 선택·번호 입력·COUNT 캐시·offset 보정.
- **L-18** 쿼리 실행 시간·히스토리 미표시. `QueryResultProvider.ts:434` → `'N row(s) · 0.45s'`, 최근 쿼리 QuickPick.
- **L-19** `openTable`의 'Not connected.'가 액션 없이 끝나 `runSqlFile`과 UX 불일치. `extension.ts:87`.
- **L-20** 연결이 없을 때 `newSqlFile`이 빈 QuickPick을 띄움. `extension.ts:106` → 'Add one first?' 액션.

### 배포·설정·문서
- **L-21** 커맨드에 `category` 없어 팔레트에 'Connect'/'Refresh' 일반 명칭 노출. `package.json:40` → `"category":"Simple RDB"`.
- **L-22** 마켓플레이스 설명·README는 한국어, UI 문자열은 전부 영어로 혼재. `package.json:4` → l10n 또는 병기.
- **L-23** README가 실제와 다른 기능 설명(스크롤 자동 페이징, `.xlsx` 내보내기, 클립보드 복사, + 버튼 위치). `README.md:39`.
- **L-24** 사용자 설정(`contributes.configuration`) 전무(페이지 크기·기본 LIMIT·최대 삭제 100 하드코딩), `getConfiguration('simpleRdb')`은 미사용 데드 코드. `ConnectionDialog.ts:7`.
- **L-25** 경쟁 확장 대비 핵심 기능 부재: SQL 자동완성/IntelliSense, MySQL 외 DB, ERD, DDL 보기(SHOW CREATE), 쿼리 포매터, 긴 셀 상세 뷰어. `package.json:3`.

---

## 5. 빌드·배포·개발환경 (검증 중단분 — 리뷰어 직접 확인)

세션 한도로 자동 검증이 끊긴 항목 중, 코드/패키지에서 직접 재확인한 것만 수록합니다.

- **B-1** (High급) **번들링 미적용** — `.vscodeignore`가 `node_modules`를 제외하지 않아 vsix에 `node_modules` 583개 파일 포함(≈6.5MB 압축 전), 그중 플랫폼 전용 `.node` 2개(→ H-15). `esbuild`는 설치돼 있으나 미사용. → esbuild 단일 번들.
- **B-2** 테스트 코드 **전무**(0개) — 파괴적 DB 조작(update/insert/delete·WHERE 생성·sqlParser) 로직에 회귀 테스트 없음. → `@vscode/test-electron` + 순수 로직(`sqlParser`, WHERE 빌더) 단위 테스트부터.
- **B-3** ESLint **부재**(Prettier만) — 미사용 변수·`any`·`no-floating-promises` 등을 잡지 못함. → `@typescript-eslint` 도입.
- **B-4** CI/CD **부재**(`.github/workflows` 없음) — compile·format·lint·package 검증이 수동. → PR에서 compile+lint+test 실행하는 GitHub Actions.
- **B-5** `src/types.ts`가 어디서도 import되지 않는 **데드 파일**(별도 `ConnectionConfig` 정의). → 제거 또는 실제 사용처와 통합.
- **B-6** 배포 vsix에 내부 트러블슈팅 문서(`docs/`), 소스맵(`.js.map` 24개), 선언맵/`.d.ts`(12개)가 포함 — 불필요한 용량·정보. → `.vscodeignore`에 `docs`, `**/*.map`, `**/*.d.ts` 추가.
- **B-7** `media/icon.png` 1.08MB — 확장 아이콘치고 과대. → 128×128 PNG로 최적화(수십 KB).
- **B-8** `SqlFileStorage`의 SQL 파일명 검증 부재 — `createSqlFile`이 `showInputBox` 입력을 검증 없이 `path.join(dir, name)`에 사용해 `../`로 홈 디렉터리 밖 파일 생성 가능(경로 순회). `SqlFileStorage.ts:32` → 파일명에서 경로 구분자 제거·화이트리스트.
- **B-9** `CHANGELOG.md` 부재(마켓플레이스 Changelog 탭 비어 보임), `package.json`에 `keywords`·풍부한 `categories`(현재 "Other"뿐) 부재 → 검색 노출 저하. → 메타데이터 보강.
- **B-10** `SqlFileStorage`의 `create/delete/saveContent`가 `async`인데 내부는 동기 `fs`(오해 소지·이벤트 루프 블로킹). → 실제 비동기 `fs/promises`로 전환하거나 시그니처를 동기로.

---

## 6. 개선 계획 (단계별 로드맵)

우선순위 원칙: **데이터를 조용히 손상시키는 결함 → 자격증명/주입 → 기능 정상화 → 신뢰성/UX → 완성도/배포 위생**.

### Phase 0 — 데이터 안전 핫픽스 (즉시, 반나절~1일)
사용자 데이터를 조용히 잘못 건드리는 경로를 먼저 차단합니다.
- C-2 (PK 편집 WHERE 오염) — `_original` 기반 PK 수집으로 통일, PK 셀 편집 경고.
- H-12 (`affectedRows` 미확인 → 가짜 삭제) — 0행이면 오류 반환, 삭제 성공 처리도 affectedRows 기반.
- H-9 (`NULL→''` 자동 큐잉) + L-17 (무분별 trim).
- H-11 (PK 없는 UPDATE NULL/중복/LIMIT) — `IS NULL` 분기 + `LIMIT 1`.
- H-10 (BIGINT) — `supportBigNumbers`/`bigNumberStrings` 한 줄 설정.
- H-1 (`getTableData` 크래시) — 테이블 열기 정상화.

### Phase 1 — 보안 기반 (2~3일)
- H-2 (SecretStorage 이전 + 마이그레이션), L-3(비밀번호 폼 임베드), H-3(SSH 키 경로/passphrase).
- C-1 + H-4 + H-5 (웹뷰 CSP/nonce 도입 + 데이터·식별자 이스케이프), M-9(메시지 검증), L-1(`escapeId`).
- M-8(SSH host key), B-8(파일명 경로 순회).

### Phase 2 — 핵심 기능 정상화 (3~5일)
- H-7 (다중 문장/커서 문장 실행) + H-8 (LIMIT/가상 스크롤), M-25(runSqlFile 결과 표시).
- H-6 (커밋 프로토콜 correlation), M-16/M-17/M-18/M-19 (패널·연결 생명주기), M-1(connect 검증).
- H-13/H-14 (Date 왕복·표시 통일), M-12(Buffer/JSON), M-13/M-14(sqlParser).

### Phase 3 — 신뢰성·UX (1주+)
- M-2~M-7 (SSH/풀 에러 핸들링·keepalive·재시도·취소·경쟁조건·정리).
- M-20/M-21/M-22 (삭제/pending 일관성), M-11(스냅샷), M-23/M-24(진행표시·affectedRows UI).
- M-28~M-33 (팔레트/키바인딩/빈 상태/Test Connection/Export 범위), M-10(CSV 주입), M-15(복사 타입).

### Phase 4 — 아키텍처·배포 위생 (병행/지속)
- **선행 권장**: B-3(ESLint) → B-2(테스트, 특히 `sqlParser`·WHERE 빌더) → B-4(CI). 이후 리팩터링의 안전망이 됩니다.
- M-26(프로토콜 타입) → M-27(웹뷰 파일 분리) → M-34(중복 제거). 순서대로 하면 리스크가 낮습니다.
- B-1/H-15(esbuild 번들 + 크로스플랫폼) + B-6/B-7(vsix 위생) + B-9(메타데이터) + L-21~L-24(카테고리/l10n/README/설정).
- L-25(자동완성·DDL 보기·긴 셀 뷰어 등 프로덕트 기능)는 로드맵으로 별도 관리.

### 빠른 성과(quick wins) — 반나절 이내, 위험 낮음
`supportBigNumbers`(H-10) · 커맨드 `category`(L-21) · `viewsWelcome`(M-30 일부) · README 수정(L-23) · `.vscodeignore` 보강(B-6) · 데드 코드 제거(L-10, L-24, B-5) · `deactivate` 정리(L-4).

---

## 부록 — 검토 커버리지

7개 관점 병렬 리뷰 후 각 finding을 독립 에이전트가 반박 시도(critical/high는 2개 렌즈)했고, 20건은 사실관계 오류·이미 처리됨·비현실적이라는 근거로 기각했습니다. 남은 75건은 모두 코드에서 사실 확인된 것입니다. §5(빌드/배포)는 자동 검증이 세션 한도로 중단되어 리뷰어가 파일·vsix에서 직접 재확인한 항목만 실었습니다.
