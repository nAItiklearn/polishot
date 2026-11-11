/**
 * True when the key event's target is somewhere the person is typing text, so page-level shortcuts (Ctrl+C
 * for the image, paste, single-key panel switches) must stay out of the way.
 *
 * Sliders, checkboxes, buttons and the colour and file pickers are inputs too, but nothing is typed into
 * them: after dragging the Padding slider, Ctrl+C must still copy the image. This matches the rule the
 * editor itself uses for its own shortcuts.
 */
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return false;
}
