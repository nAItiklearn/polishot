'use client';

import dynamic from 'next/dynamic';

/**
 * ssr:false is only allowed in a Client Component, so the server page renders this wrapper. The
 * placeholder is what the server sends: a quiet frame the exact size of the app, so nothing shifts when
 * the editor shell replaces it.
 */
const EditorApp = dynamic(() => import('./EditorApp'), {
  ssr: false,
  loading: () => (
    <div
      aria-hidden="true"
      className="grid h-[calc(100dvh-4rem)] min-h-[520px] place-items-center border-b border-line bg-bg text-sm text-ink-3"
    >
      Loading the editor
    </div>
  ),
});

export function EditorLoader() {
  return <EditorApp />;
}
