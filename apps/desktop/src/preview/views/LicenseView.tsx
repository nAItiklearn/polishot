import { SITE_URL } from '@polishot/brand';
import { useId, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import { ViewHeader } from '../components/ViewHeader';
import { useApp } from '../context';
import { errorMessage, ipc } from '../../shared/ipc';
import { FREE_PRESET_LIMIT, formatUpdatesUntil, updatesExpiredMessage } from '../lib/entitlement';

/** The site's pricing page. The price lives there, in one place. */
export const PRICING_URL = `${SITE_URL}/pricing`;

const PRO_INCLUDES: readonly string[] = [
  'No watermark on exports',
  'Your own logo or text instead of ours',
  'Unlimited saved looks',
  'Unlimited batch beautify',
  'One year of updates',
];

const FREE_INCLUDES: readonly string[] = [
  `Every capture, edit, redaction and export feature`,
  `A small watermark on exports`,
  `Up to ${FREE_PRESET_LIMIT} saved looks`,
];

function formatIssued(ms: number | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' }).format(ms);
}

/** Opens the pricing page in the browser, or copies the link when this build cannot open one. */
export async function openPricing(notify: (m: string) => void): Promise<void> {
  try {
    await ipc.openUrl(PRICING_URL);
  } catch {
    try {
      await ipc.copyText(PRICING_URL);
      notify('Pricing link copied. Paste it into your browser.');
    } catch {
      notify(`Visit ${PRICING_URL}`);
    }
  }
}

export interface LicenseViewProps {
  onBack: () => void;
}

export function LicenseView({ onBack }: LicenseViewProps) {
  const { license, ent, setLicense, notify } = useApp();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const keyId = useId();
  const errId = useId();

  const hasKey = license?.edition !== undefined || license?.keyId !== undefined;
  const expired = updatesExpiredMessage(ent);
  const until = formatUpdatesUntil(ent.updatesUntil);
  const issued = formatIssued(license?.issuedAt);
  const edition = license?.edition === 'team' ? 'Team' : license?.edition === 'personal' ? 'Personal' : null;

  const activate = async (e: FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    if (!value) {
      setError('Paste your license key first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const status = await ipc.licenseActivate(value);
      setLicense(status);
      setKey('');
      notify(status.licensed ? 'Pro is active. Thank you.' : 'Your key is saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    setBusy(true);
    try {
      setLicense(await ipc.licenseDeactivate());
      setConfirmOff(false);
      notify('License removed from this computer');
    } catch (err) {
      notify({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const headline = ent.pro ? 'Pro' : 'Free';
  const sub = ent.pro
    ? edition
      ? `${edition} license${until ? `, updates until ${until}` : ''}`
      : 'License active'
    : expired
      ? 'This version is newer than your license covers'
      : 'Everything works. Exports carry a small watermark.';

  return (
    <div className="pv-page">
      <ViewHeader title="License" onBack={onBack} />
      <div className="pv-scroll">
        <div className="pv-license">
          <section className="pv-card pv-license-card" aria-label="License status">
            <div className="pv-license-top">
              <div>
                <p className="pv-license-edition">{headline}</p>
                <p className="pv-license-sub">{sub}</p>
              </div>
              {!ent.pro && !hasKey ? (
                <button type="button" className="pe-btn" onClick={() => void openPricing(notify)}>
                  Buy Pro
                </button>
              ) : null}
            </div>

            {expired ? (
              <p className="pv-license-notice" role="status">
                {expired} The last version it covers stays Pro for good.
              </p>
            ) : null}
            {ent.reason === 'invalid' ? (
              <p className="pv-license-notice" role="status">
                The saved license could not be verified. Paste your key again to restore Pro.
              </p>
            ) : null}

            {hasKey ? (
              <dl className="pv-facts">
                {edition ? (
                  <div>
                    <dt>Edition</dt>
                    <dd>{edition}</dd>
                  </div>
                ) : null}
                {issued ? (
                  <div>
                    <dt>Issued</dt>
                    <dd>{issued}</dd>
                  </div>
                ) : null}
                {until ? (
                  <div>
                    <dt>Updates until</dt>
                    <dd>{until}</dd>
                  </div>
                ) : null}
                {license?.keyId ? (
                  <div>
                    <dt>Key ID</dt>
                    <dd className="pv-mono">{license.keyId}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}

            {!ent.pro || !hasKey ? (
              <form className="pv-activate" onSubmit={(e) => void activate(e)}>
                <label className="pe-label" htmlFor={keyId}>
                  {hasKey ? 'Replace the license key' : 'License key'}
                </label>
                <div className="pv-activate-row">
                  <input
                    id={keyId}
                    className="pe-input pv-keyinput"
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value);
                      if (error) setError(null);
                    }}
                    placeholder="PSHOT-"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errId : undefined}
                  />
                  <button type="submit" className="pe-btn pe-btn-primary" disabled={busy || !key.trim()}>
                    {busy ? 'Checking…' : 'Activate'}
                  </button>
                </div>
                <p className="pv-field-error" id={errId} role={error ? 'alert' : undefined}>
                  {error}
                </p>
              </form>
            ) : null}

            {hasKey ? (
              <div className="pv-license-foot">
                <button type="button" className="pe-btn pe-btn-quiet" onClick={() => setConfirmOff(true)} disabled={busy}>
                  Deactivate on this computer
                </button>
                {!ent.pro ? (
                  <button type="button" className="pe-btn" onClick={() => void openPricing(notify)}>
                    Buy Pro
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="pv-compare" aria-label="What each edition includes">
            <div>
              <h2 className="pv-group-title">Free</h2>
              <ul className="pv-list">
                {FREE_INCLUDES.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="pv-group-title">Pro</h2>
              <ul className="pv-list">
                {PRO_INCLUDES.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOff}
        title="Deactivate this license?"
        body={`Exports will carry the watermark again. You can activate the same key again on any computer, now or later.`}
        confirmLabel="Deactivate"
        busy={busy}
        onConfirm={() => void deactivate()}
        onCancel={() => setConfirmOff(false)}
      />
    </div>
  );
}
