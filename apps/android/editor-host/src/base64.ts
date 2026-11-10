const DATA_URL_PREFIX = /^data:[^;,]*;base64,/;

/**
 * Base64 text of a Blob without the `data:` prefix, which is the form the Android bridge expects. FileReader
 * does the encoding natively, so a 30 MB export does not go through a JavaScript string builder.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('The image could not be read.'));
        return;
      }
      resolve(stripDataUrlPrefix(result));
    };
    reader.readAsDataURL(blob);
  });
}

export function stripDataUrlPrefix(dataUrl: string): string {
  return dataUrl.replace(DATA_URL_PREFIX, '');
}
