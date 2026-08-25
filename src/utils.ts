export function formatDateTime(value: any): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(
      value.getMonth() + 1,
    )}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(
      value.getMinutes(),
    )}:${pad(value.getSeconds())}`;
  }
  return String(value);
}

/**
 * 셀 값을 웹뷰 표시용으로 변환한다. Buffer(BLOB/BINARY)는 hex 문자열로, JSON 등 객체는
 * JSON 문자열로 바꿔 '[object Object]' 표시와 편집 시 데이터 훼손을 방지한다.
 * null/원시값은 그대로 둔다(웹뷰가 NULL/숫자 등을 구분해 렌더링).
 */
export function toDisplayValue(value: any): any {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Date) {
    return formatDateTime(value);
  }
  if (Buffer.isBuffer(value)) {
    return '0x' + value.toString('hex');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}
