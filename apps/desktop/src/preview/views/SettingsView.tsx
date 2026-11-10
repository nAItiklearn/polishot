import { PRESETS } from '@polishot/editor';
import { FolderOpen, X } from 'lucide-react';
import { useEffect, useId, useState, type CSSProperties } from 'react';
import { APP_NAME } from '@polishot/brand';
import { BrandMarkSetting } from '../components/BrandMarkSetting';
import { Choices, SettingGroup, SettingRow, Switch, type Choice } from '../components/controls';
import { IconButton } from '../components/IconButton';
import { ShortcutRecorder } from '../components/ShortcutRecorder';
import { ViewHeader } from '../components/ViewHeader';
import { useApp } from '../context';
import { useLooks } from '../hooks/useLooks';
import { FREE_PRESET_LIMIT } from '../lib/entitlement';
import { middleEllipsis } from '../lib/format';
import { DEFAULT_PRESET_CHOICES } from '../session';
import { native } from '../../shared/native';
import type { AfterCapture, ImageFormat, Settings, ThemeSetting } from '../../shared/ipc';

const FORMATS: readonly Choice<ImageFormat>[] = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
];
const AFTER: readonly Choice<AfterCapture>[] = [
  { value: 'preview', label: 'Open the editor' },
  { value: 'copy', label: 'Copy to clipboard' },
];
const THEMES: readonly Choice<ThemeSetting>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Quality slider that only saves when the drag ends, so settings.json is not rewritten every frame. */
function QualitySlider({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (v: number) => void }) {
  const [local, setLocal] = useState(value);
  const id = useId();
  useEffect(() => setLocal(value), [value]);
  const commit = () => {
    if (Math.abs(local - value) > 0.0001) onCommit(local);
  };
  const pct = ((local - 0.1) / 0.9) * 100;
  return (
    <div className="pv-slider">
      <input
        id={id}
        className="pe-range"
        type="range"
        min={0.1}
        max={1}
        step={0.01}
        value={local}
        disabled={disabled}
        aria-label="Quality"
        aria-valuetext={`${Math.round(local * 100)} percent`}
        style={{ '--pe-fill': `${pct}%` } as CSSProperties}
        onChange={(e) => setLocal(Number(e.currentTarget.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <output className="pe-value" htmlFor={id}>
        {Math.round(local * 100)}%
      </output>
    </div>
  );
}

export interface SettingsViewProps {
  onBack: () => void;
  onUpgrade: () => void;
}

export function SettingsView({ onBack, onUpgrade }: SettingsViewProps) {
  const { settings, updateSettings, notify, info, ent } = useApp();
  const looks = useLooks();
  const presetId = useId();

  if (!settings) {
    return (
      <div className="pv-page">
        <ViewHeader title="Settings" onBack={onBack} />
        <div className="pv-scroll">
          <div className="pv-state">
            <p>Settings are loading.</p>
          </div>
        </div>
      </div>
    );
  }

  const set = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const err = await updateSettings({ [key]: value } as Partial<Settings>);
    if (err) notify({ message: err, tone: 'error' });
  };
  const shortcut = (key: 'shortcut' | 'scrollShortcut' | 'gifShortcut') => (value: string) => updateSettings({ [key]: value });

  const conflict = info?.warnings.find((w) => /shortcut|already in use/i.test(w)) ?? null;

  const pickFolder = async () => {
    try {
      const dir = await native.pickFolder(settings.saveFolder);
      if (dir) await set('saveFolder', dir);
    } catch {
      notify({ message: 'The folder chooser could not be opened. Try again.', tone: 'error' });
    }
  };

  return (
    <div className="pv-page">
      <ViewHeader title="Settings" onBack={onBack} />
      <div className="pv-scroll">
        <div className="pv-settings">
          <SettingGroup title="Shortcuts">
            <SettingRow title="Capture" description="Works from anywhere in Windows.">
              <ShortcutRecorder label="Capture shortcut" value={settings.shortcut} onCommit={shortcut('shortcut')} notice={conflict} />
            </SettingRow>
            <SettingRow title="Scrolling capture" description="Optional.">
              <ShortcutRecorder label="Scrolling capture shortcut" value={settings.scrollShortcut} optional onCommit={shortcut('scrollShortcut')} />
            </SettingRow>
            <SettingRow title="GIF recording" description="Optional.">
              <ShortcutRecorder label="GIF recording shortcut" value={settings.gifShortcut} optional onCommit={shortcut('gifShortcut')} />
            </SettingRow>
          </SettingGroup>

          <SettingGroup title="General">
            <SettingRow title="Start with Windows" description={`${APP_NAME} waits quietly in the tray.`}>
              <Switch label="Start with Windows" checked={settings.autostart} onChange={(v) => void set('autostart', v)} />
            </SettingRow>
            <SettingRow title="After a capture">
              <Choices label="After a capture" value={settings.afterCapture} options={AFTER} onChange={(v) => void set('afterCapture', v)} />
            </SettingRow>
            <SettingRow title="Theme">
              <Choices label="Theme" value={settings.theme} options={THEMES} onChange={(v) => void set('theme', v)} />
            </SettingRow>
          </SettingGroup>

          <SettingGroup title="Saving">
            <SettingRow title="Save folder" description="Where Save puts your images.">
              <div className="pv-folder">
                <span className="pv-folder-path" title={settings.saveFolder}>
                  {middleEllipsis(settings.saveFolder || 'Pictures', 38)}
                </span>
                <button type="button" className="pe-btn" onClick={() => void pickFolder()}>
                  <FolderOpen size={16} strokeWidth={1.5} aria-hidden="true" />
                  Change
                </button>
              </div>
            </SettingRow>
            <SettingRow title="Format">
              <Choices label="Default format" value={settings.format} options={FORMATS} onChange={(v) => void set('format', v)} />
            </SettingRow>
            <SettingRow title="Quality" description={settings.format === 'png' ? 'PNG is lossless, so quality does not apply.' : undefined}>
              <QualitySlider value={settings.quality} disabled={settings.format === 'png'} onCommit={(v) => void set('quality', Math.round(v * 100) / 100)} />
            </SettingRow>
          </SettingGroup>

          <SettingGroup title="Looks">
            <SettingRow title="Default look" description="Applied to every new capture." htmlFor={presetId}>
              <select id={presetId} className="pe-select" value={settings.defaultPreset} onChange={(e) => void set('defaultPreset', e.target.value)}>
                <option value="auto">Auto (balanced to the screenshot)</option>
                {DEFAULT_PRESET_CHOICES.filter((p) => p !== 'auto').map((p) => {
                  const size = PRESETS[p];
                  return (
                    <option key={p} value={p}>
                      {size.width && size.height ? `${size.label} · ${size.width}×${size.height}` : size.label}
                    </option>
                  );
                })}
                {looks.list.length > 0 ? (
                  <optgroup label="Saved looks">
                    {looks.list.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </SettingRow>
            <SettingRow
              title="Saved looks"
              description={
                ent.pro ? (
                  'Unlimited with Pro. Save one from the Style tab.'
                ) : (
                  <>
                    {looks.quota.used} of {FREE_PRESET_LIMIT} used.{' '}
                    {looks.quota.atLimit ? (
                      <button type="button" className="pv-link" onClick={onUpgrade}>
                        Get Pro for unlimited.
                      </button>
                    ) : (
                      'Save one from the Style tab.'
                    )}
                  </>
                )
              }
              stacked={looks.list.length > 0}
            >
              {looks.list.length > 0 ? (
                <ul className="pv-looks">
                  {looks.list.map((l) => (
                    <li key={l.id} className="pv-lookrow">
                      <span className="pv-lookname">{l.name}</span>
                      <IconButton label={`Delete the look ${l.name}`} tipAlign="end" onClick={() => void looks.onDeletePreset(l.id)}>
                        <X size={14} strokeWidth={1.5} aria-hidden="true" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="pv-muted">None yet</span>
              )}
            </SettingRow>
          </SettingGroup>

          <BrandMarkSetting onUpgrade={onUpgrade} />

          <p className="pv-about">
            {APP_NAME} {info?.version ?? ''}
          </p>
        </div>
      </div>
    </div>
  );
}
