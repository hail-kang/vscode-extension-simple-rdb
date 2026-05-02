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
