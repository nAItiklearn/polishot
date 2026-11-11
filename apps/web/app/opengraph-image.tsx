import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import { APP_NAME, palette } from '@polishot/brand';
import { LOCKUP_PATHS, LOCKUP_TRANSFORM, LOCKUP_VIEWBOX } from '@/components/brand/paths.generated';
import { TAGLINE } from '@/lib/site';

export const alt = `${APP_NAME}: ${TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const FONT_DIR = path.join(process.cwd(), 'node_modules', '@fontsource', 'instrument-serif', 'files');

/** Original typographic card: near-black with an ember glow, a hairline capture frame, the headline set large. No stock imagery. */
export default async function OpenGraphImage() {
  const [regular, italic] = await Promise.all([
    readFile(path.join(FONT_DIR, 'instrument-serif-latin-400-normal.woff')),
    readFile(path.join(FONT_DIR, 'instrument-serif-latin-400-italic.woff')),
  ]);

  const { bg, border, text, text2, accentText, accent } = palette.dark;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          background: bg,
          fontFamily: 'Instrument Serif',
          padding: 36,
        }}
      >
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            backgroundColor: bg,
            backgroundImage:
              'radial-gradient(ellipse 60% 70% at 12% 112%, rgba(200,71,29,0.55), rgba(200,71,29,0) 70%), radial-gradient(ellipse 50% 60% at 92% 118%, rgba(222,160,58,0.34), rgba(222,160,58,0) 70%)',
            border: `1px solid ${border}`,
            borderRadius: 24,
            padding: '56px 64px',
          }}
        >
          <div style={{ display: 'flex', marginLeft: -22, marginTop: -18 }}>
            {/* The brand lockup (Print P + outlined wordmark), dark / ember colours. */}
            <svg width="253" height="88" viewBox={LOCKUP_VIEWBOX}>
              <g transform={LOCKUP_TRANSFORM}>
                {LOCKUP_PATHS.map((p) => (
                  <path
                    key={p.d.slice(0, 24)}
                    d={p.d}
                    fill={p.role === 'accent' ? accent : text}
                    fillRule={p.evenodd ? 'evenodd' : undefined}
                  />
                ))}
              </g>
            </svg>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              fontSize: 112,
              lineHeight: 1,
              letterSpacing: '-0.035em',
              color: text,
            }}
          >
            <div style={{ display: 'flex' }}>
              <span>Screenshots,&nbsp;</span>
              <span style={{ fontStyle: 'italic', color: accentText }}>finished</span>
            </div>
            <div style={{ display: 'flex' }}>in about two seconds.</div>
          </div>

          <div style={{ display: 'flex', fontSize: 30, color: text2 }}>
            Free for Windows and Android. Nothing leaves your machine.
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Instrument Serif', data: regular, weight: 400, style: 'normal' },
        { name: 'Instrument Serif', data: italic, weight: 400, style: 'italic' },
      ],
    },
  );
}
