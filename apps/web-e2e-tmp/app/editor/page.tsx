import type { Metadata } from 'next';
import { APP_NAME } from '@polishot/brand';
import { pageMetadata } from '@/lib/metadata';
import { EditorLoader } from './EditorLoader';

export const metadata: Metadata = pageMetadata({
  title: 'Web editor',
  description: `Polish a screenshot in your browser with ${APP_NAME}. Nothing is uploaded; the image stays in your tab.`,
  path: '/editor',
});

export default function EditorPage() {
  return (
    <>
      <h1 className="sr-only">Web editor: polish a screenshot in your browser</h1>
      <EditorLoader />
    </>
  );
}
