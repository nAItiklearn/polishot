/**
 * The slice of the editor playground's test hook (packages/editor/playground/main.tsx, `window.__polishot`)
 * that the shot recipes use. Declared here rather than imported so tools/shots does not depend on the editor's
 * source; the recipes check what they rely on at run time.
 */
interface PolishotPlaygroundHook {
  editor: {
    load(image: unknown): void;
    update(patch: Record<string, unknown>): void;
    setLicensed(licensed: boolean): void;
    export(opts: { format: 'png' | 'jpeg' | 'webp'; quality: number; scale: 1 | 2 | 3; licensed: boolean }): Promise<Blob>;
  };
  words: unknown[];
  image: unknown;
}

interface Window {
  __polishot?: PolishotPlaygroundHook;
}
