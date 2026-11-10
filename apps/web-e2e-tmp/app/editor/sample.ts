import { toLoadedImage, type LoadedImage } from './image';

/**
 * A made-up billing screen, drawn on a canvas so the editor has something to work on without any upload.
 * It carries a fake email, card number and IP address so "Find sensitive data" has something to find,
 * and deliberately uneven solid margins so auto-balance has something to trim. All of it is invented.
 */
export const SAMPLE_NAME = 'sample-billing.png';

const FONT = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const W = 1280;
const H = 800;
/** Drawn at 2x so text is crisp when exported. */
const SCALE = 2;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawSample(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  ctx.scale(SCALE, SCALE);

  const text = (str: string, x: number, baseline: number, o: { size?: number; weight?: number; color?: string } = {}) => {
    ctx.font = `${o.weight ?? 400} ${o.size ?? 14}px ${FONT}`;
    ctx.fillStyle = o.color ?? '#1b1a17';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(str, x, baseline);
  };

  // Capture margin: solid and uneven.
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
  ['Overview', 'Projects', 'Billing', 'Team', 'Settings'].forEach((label, i) => {
    const y = wy + 96 + i * 44;
    const active = label === 'Billing';
    if (active) {
      ctx.fillStyle = '#38352e';
      roundRect(ctx, wx + 12, y - 22, sw - 24, 36, 8);
      ctx.fill();
    }
    ctx.fillStyle = active ? '#f4f2ee' : '#8f8b80';
    roundRect(ctx, wx + 28, y - 11, 14, 14, 4);
    ctx.fill();
    text(label, wx + 54, y + 1, { size: 14, weight: active ? 600 : 400, color: active ? '#f4f2ee' : '#b9b5ab' });
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

  // Title.
  text('Billing', mx + 32, wy + 112, { size: 28, weight: 600 });
  text('Manage your plan, payment method and invoices.', mx + 32, wy + 140, { size: 15, color: '#6b6a63' });

  // Account card.
  const cx0 = mx + 32;
  const cw = ww - sw - 64;
  const cy0 = wy + 172;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, cx0, cy0, cw, 196, 12);
  ctx.fill();
  ctx.strokeStyle = '#e6e5e1';
  ctx.lineWidth = 1;
  ctx.stroke();
  text('Account', cx0 + 24, cy0 + 36, { size: 16, weight: 600 });
  const rows: [string, string][] = [
    ['Billing email', 'maya.chen@northwind-labs.com'],
    ['Payment method', 'Visa 4111 1111 1111 1111  exp 08/29'],
    ['Last sign-in', '203.0.113.42  from Berlin, DE'],
  ];
  rows.forEach(([label, value], i) => {
    const y = cy0 + 82 + i * 42;
    ctx.fillStyle = '#efede8';
    ctx.fillRect(cx0 + 24, y - 28, cw - 48, 1);
    text(label, cx0 + 24, y, { size: 14, color: '#6b6a63' });
    text(value, cx0 + 210, y, { size: 16, color: '#1b1a17' });
  });

  // Invoices.
  const iy = cy0 + 244;
  text('Invoices', cx0, iy + 4, { size: 16, weight: 600 });
  ctx.fillStyle = '#2f6f5e';
  roundRect(ctx, cx0 + cw - 236, iy - 18, 236, 36, 8);
  ctx.fill();
  text('Update payment method', cx0 + cw - 218, iy + 5, { size: 14, weight: 600, color: '#ffffff' });

  const invoices: [string, string, string, string][] = [
    ['Oct 1, 2026', 'Team plan, 6 seats', '$114.00', 'Paid'],
    ['Sep 1, 2026', 'Team plan, 6 seats', '$114.00', 'Paid'],
    ['Aug 1, 2026', 'Team plan, 5 seats', '$95.00', 'Paid'],
  ];
  ctx.fillStyle = '#f6f5f2';
  ctx.fillRect(cx0, iy + 34, cw, 30);
  [
    ['Date', 16],
    ['Description', 180],
    ['Amount', 520],
    ['Status', 680],
  ].forEach(([label, dx]) => text(label as string, cx0 + (dx as number), iy + 54, { size: 13, weight: 600, color: '#6b6a63' }));
  invoices.forEach(([date, desc, amount, status], i) => {
    const y = iy + 94 + i * 34;
    ctx.fillStyle = '#efede8';
    ctx.fillRect(cx0, y + 12, cw, 1);
    text(date, cx0 + 16, y, { size: 14 });
    text(desc, cx0 + 180, y, { size: 14 });
    text(amount, cx0 + 520, y, { size: 14 });
    ctx.fillStyle = '#e3efe9';
    roundRect(ctx, cx0 + 676, y - 15, 58, 22, 11);
    ctx.fill();
    text(status, cx0 + 689, y, { size: 13, weight: 600, color: '#2f6f5e' });
  });

  return canvas;
}

export function loadSample(): Promise<LoadedImage> {
  return toLoadedImage(drawSample(), SAMPLE_NAME, 'sample');
}
