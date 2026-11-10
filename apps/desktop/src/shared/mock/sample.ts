import type { OcrWord } from '@polishot/redact';

/**
 * Dev-only sample for the mock backend (a copy of the editor playground's sample, so the preview does not
 * depend on a playground file). Draws a believable fake app screenshot (a billing page) onto a canvas and returns OCR words that match
 * the drawn text exactly. The page contains a fake email, card number, IP address and API token so the
 * redaction flow can be tried end to end. Everything here is invented sample data.
 */

export interface Sample {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  words: OcrWord[];
}

const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

export const SAMPLE_TEXT = {
  email: 'maya.chen@northwind-labs.com',
  card: '4111 1111 1111 1111',
  ip: '203.0.113.42',
  token: 'ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5',
} as const;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function makeSample(scale = 1): Sample {
  const W = 1280;
  const H = 800;
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  const words: OcrWord[] = [];
  const lines = new Map<number, number>();
  const lineOf = (y: number) => {
    const key = Math.round(y / 6);
    if (!lines.has(key)) lines.set(key, lines.size);
    return lines.get(key)!;
  };

  /** Draws text word by word, recording an OCR word (in canvas pixels) for each. */
  const text = (
    str: string,
    x: number,
    baseline: number,
    o: { size?: number; weight?: number; color?: string } = {},
  ) => {
    const size = o.size ?? 14;
    ctx.font = `${o.weight ?? 400} ${size}px ${FONT}`;
    ctx.fillStyle = o.color ?? '#1b1a17';
    ctx.textBaseline = 'alphabetic';
    const space = ctx.measureText(' ').width;
    let cx = x;
    for (const w of str.split(' ')) {
      const width = ctx.measureText(w).width;
      ctx.fillText(w, cx, baseline);
      words.push({
        text: w,
        line: lineOf(baseline),
        box: {
          x: cx * scale,
          y: (baseline - size * 0.84) * scale,
          w: width * scale,
          h: size * 1.12 * scale,
        },
      });
      cx += width + space;
    }
    return cx - space;
  };

  // Capture margin: solid and deliberately uneven, so auto-balance has something to trim.
  ctx.fillStyle = '#e9e7e2';
  ctx.fillRect(0, 0, W, H);

  // Window.
  const wx = 56;
  const wy = 40;
  const ww = 1200;
  const wh = 688;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(wx, wy, ww, wh);

  // Sidebar.
  const sw = 220;
  ctx.fillStyle = '#26241f';
  ctx.fillRect(wx, wy, sw, wh);
  ctx.fillStyle = '#d9663f';
  roundRect(ctx, wx + 24, wy + 24, 22, 22, 6);
  ctx.fill();
  text('Northwind', wx + 56, wy + 41, { size: 16, weight: 600, color: '#f4f2ee' });
  const nav = ['Overview', 'Projects', 'Billing', 'Team', 'Settings'];
  nav.forEach((label, i) => {
    const y = wy + 96 + i * 44;
    if (label === 'Billing') {
      ctx.fillStyle = '#38352e';
      roundRect(ctx, wx + 12, y - 22, sw - 24, 36, 8);
      ctx.fill();
    }
    ctx.fillStyle = label === 'Billing' ? '#f4f2ee' : '#8f8b80';
    roundRect(ctx, wx + 28, y - 11, 14, 14, 4);
    ctx.fill();
    text(label, wx + 54, y + 1, { size: 14, weight: label === 'Billing' ? 600 : 400, color: label === 'Billing' ? '#f4f2ee' : '#b9b5ab' });
  });
  ctx.fillStyle = '#4a463d';
  ctx.beginPath();
  ctx.arc(wx + 44, wy + wh - 44, 14, 0, Math.PI * 2);
  ctx.fill();
  text('Maya Chen', wx + 68, wy + wh - 40, { size: 13, weight: 500, color: '#d8d4c9' });

  // Header strip.
  const mx = wx + sw;
  ctx.fillStyle = '#ebe9e4';
  ctx.fillRect(mx, wy + 56, ww - sw, 1);
  text('Workspace / Billing', mx + 32, wy + 34, { size: 13, color: '#6b6a63' });
  ctx.fillStyle = '#ece9e2';
  ctx.beginPath();
  ctx.arc(wx + ww - 40, wy + 28, 14, 0, Math.PI * 2);
  ctx.fill();

  // Page title.
  text('Billing', mx + 32, wy + 112, { size: 26, weight: 600 });
  text('Manage your plan, payment method and invoices.', mx + 32, wy + 138, { size: 14, color: '#6b6a63' });

  // Account card.
  const cx0 = mx + 32;
  const cw = ww - sw - 64;
  const cy0 = wy + 168;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, cx0, cy0, cw, 232, 12);
  ctx.fill();
  ctx.strokeStyle = '#e6e5e1';
  ctx.lineWidth = 1;
  ctx.stroke();
  text('Account', cx0 + 24, cy0 + 36, { size: 15, weight: 600 });
  const rows: [string, string][] = [
    ['Billing email', SAMPLE_TEXT.email],
    ['Payment method', `Visa ${SAMPLE_TEXT.card} exp 08/29`],
    ['Last sign-in', `${SAMPLE_TEXT.ip} from Berlin, DE`],
    ['Deploy token', SAMPLE_TEXT.token],
  ];
  rows.forEach(([label, value], i) => {
    const y = cy0 + 78 + i * 38;
    ctx.fillStyle = '#efede8';
    ctx.fillRect(cx0 + 24, y - 26, cw - 48, 1);
    text(label, cx0 + 24, y, { size: 13, color: '#6b6a63' });
    text(value, cx0 + 200, y, { size: 14, color: '#1b1a17' });
  });

  // Invoices.
  const iy = cy0 + 264;
  text('Invoices', cx0, iy + 4, { size: 15, weight: 600 });
  ctx.fillStyle = '#2f6f5e';
  roundRect(ctx, cx0 + cw - 236, iy - 18, 236, 36, 8);
  ctx.fill();
  text('Update payment method', cx0 + cw - 218, iy + 5, { size: 13, weight: 600, color: '#ffffff' });

  const inv: [string, string, string, string][] = [
    ['Oct 1, 2026', 'Team plan, 6 seats', '$114.00', 'Paid'],
    ['Sep 1, 2026', 'Team plan, 6 seats', '$114.00', 'Paid'],
    ['Aug 1, 2026', 'Team plan, 5 seats', '$95.00', 'Paid'],
  ];
  ctx.fillStyle = '#f6f5f2';
  ctx.fillRect(cx0, iy + 34, cw, 30);
  text('Date', cx0 + 16, iy + 54, { size: 12, weight: 600, color: '#6b6a63' });
  text('Description', cx0 + 180, iy + 54, { size: 12, weight: 600, color: '#6b6a63' });
  text('Amount', cx0 + 520, iy + 54, { size: 12, weight: 600, color: '#6b6a63' });
  text('Status', cx0 + 680, iy + 54, { size: 12, weight: 600, color: '#6b6a63' });
  inv.forEach(([d, desc, amt, status], i) => {
    const y = iy + 94 + i * 34;
    ctx.fillStyle = '#efede8';
    ctx.fillRect(cx0, y + 12, cw, 1);
    text(d, cx0 + 16, y, { size: 13 });
    text(desc, cx0 + 180, y, { size: 13 });
    text(amt, cx0 + 520, y, { size: 13 });
    ctx.fillStyle = '#e3efe9';
    roundRect(ctx, cx0 + 676, y - 15, 54, 22, 11);
    ctx.fill();
    text(status, cx0 + 689, y, { size: 12, weight: 600, color: '#2f6f5e' });
  });

  return { canvas, width: canvas.width, height: canvas.height, words };
}
