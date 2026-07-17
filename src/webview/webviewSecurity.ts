/**
 * 웹뷰 보안 헬퍼.
 *
 * 참고: 현재 웹뷰들은 인라인 `onclick=` 핸들러를 사용하므로 nonce 기반 엄격 CSP를 쓰면
 * 버튼이 동작하지 않는다. 따라서 script/style은 `'unsafe-inline'`으로 허용하되,
 * `default-src 'none'` + `connect-src 'none'`으로 원격 유출(fetch/XHR/websocket)과
 * 외부 리소스 로드를 차단한다. nonce 기반 엄격 CSP로의 상향은 인라인 핸들러 제거
 * (웹뷰 스크립트 파일 분리) 작업과 함께 진행한다.
 */
export function contentSecurityPolicy(cspSource: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src ${cspSource} 'unsafe-inline'`,
    "connect-src 'none'",
  ].join('; ');
}

export function cspMetaTag(cspSource: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(cspSource)}">`;
}

/**
 * 값을 `<script>` 블록 안에 직접 삽입할 때 사용한다. JSON.stringify는 `<`, `/`, U+2028/2029를
 * 이스케이프하지 않아 `</script>` 조기 종료로 스크립트 주입이 가능하므로 이를 유니코드
 * 이스케이프로 치환한다. 결과는 여전히 유효한 JSON/JS 리터럴이다.
 */
export function toSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** HTML 텍스트 컨텍스트용 이스케이프. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
