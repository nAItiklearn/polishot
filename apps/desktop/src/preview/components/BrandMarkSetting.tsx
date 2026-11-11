import { useEffect, useId, useRef, useState } from 'react';
import { Choices, SettingGroup, SettingRow, type Choice } from './controls';
import { useApp } from '../context';
import { BRAND_MARK_MAX_TEXT, BRAND_IMAGE_TYPES, MAX_BRAND_IMAGE_BYTES, checkBrandImage, readAsDataUrl } from '../lib/brand';

type Mode = 'none' | 'text' | 'image';

const MODES: readonly Choice<Mode>[] = [
  { value: 'none', label: 'None' },
  { value: 'text', label: 'Text' },
  { value: 'image', label: 'Logo' },
];

/**
 * Pro: your own text or logo in the corner of exports instead of the Polishot watermark. The same control is in
 * the Style tab's Brand mark section (the shared Inspector); this is the home for it in Settings. Free sees
 * nothing here: the Inspector's locked row is the one place that explains it. The editor itself refuses to
 * draw a brand mark unless it is licensed, so this is a convenience, not the enforcement.
 */
export function BrandMarkSetting() {
  const { ent, brandMark, setBrandMark, notify } = useApp();
  const [mode, setMode] = useState<Mode>(brandMark?.type ?? 'none');
  const [text, setText] = useState(brandMark?.type === 'text' ? brandMark.text : '');
  const fileRef = useRef<HTMLInputElement>(null);
  const textId = useId();

  useEffect(() => {
    if (brandMark?.type === 'text') setText(brandMark.text);
    if (brandMark) setMode(brandMark.type);
  }, [brandMark]);

  const save = (next: Parameters<typeof setBrandMark>[0]): boolean => {
    const ok = setBrandMark(next);
    if (!ok) notify({ message: 'That brand mark could not be saved. Try something shorter or smaller.', tone: 'error' });
    return ok;
  };

  const pickMode = (m: Mode) => {
    setMode(m);
    if (m === 'none') save(null);
    else if (m === 'text' && text.trim()) save({ type: 'text', text });
    // "image" waits for a file; "text" waits for typing.
  };

  const commitText = () => {
    if (mode !== 'text') return;
    if (!text.trim()) save(null);
    else save({ type: 'text', text });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const problem = checkBrandImage(file);
    if (problem) {
      notify({ message: problem, tone: 'error' });
      return;
    }
    try {
      save({ type: 'image', src: await readAsDataUrl(file) });
    } catch {
      notify({ message: 'That image could not be read. Choose another file.', tone: 'error' });
    }
  };

  if (!ent.pro) return null;

  return (
    <SettingGroup title="Brand mark">
      <SettingRow title="In the corner of exports" description="Instead of the Polishot watermark. None gives a clean export.">
        <Choices label="Brand mark" value={mode} options={MODES} onChange={pickMode} />
      </SettingRow>
      {mode === 'text' ? (
        <SettingRow title="Text" htmlFor={textId}>
          <input
            id={textId}
            className="pe-input pv-brand-input"
            value={text}
            maxLength={BRAND_MARK_MAX_TEXT}
            placeholder="maya.dev"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => e.key === 'Enter' && commitText()}
          />
        </SettingRow>
      ) : null}
      {mode === 'image' ? (
        <SettingRow title="Logo" description={`PNG, JPEG or WebP, up to ${Math.round(MAX_BRAND_IMAGE_BYTES / 1024)} KB.`}>
          <div className="pv-folder">
            {brandMark?.type === 'image' ? <img className="pv-brand-logo" src={brandMark.src} alt="Your logo" /> : null}
            <button type="button" className="pe-btn" onClick={() => fileRef.current?.click()}>
              {brandMark?.type === 'image' ? 'Replace' : 'Choose image'}
            </button>
            <input
              ref={fileRef}
              type="file"
              className="pv-visually-hidden"
              accept={BRAND_IMAGE_TYPES.join(',')}
              tabIndex={-1}
              aria-label="Choose a logo image"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                void onFile(f);
              }}
            />
          </div>
        </SettingRow>
      ) : null}
    </SettingGroup>
  );
}
