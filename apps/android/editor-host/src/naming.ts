import { APP_SLUG } from '@polishot/brand';
import { EXTENSION, type ExportFormat } from './payload';

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `polishot-20260101-120000.png`; Android sanitises it again and makes sure the extension matches the type. */
export function exportFileName(format: ExportFormat, suffix = '', now: Date = new Date()): string {
  return `${APP_SLUG}-${stamp(now)}${suffix}.${EXTENSION[format]}`;
}
