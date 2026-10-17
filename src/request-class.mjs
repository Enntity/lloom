export const REQUEST_CLASSES = ['standard', 'interactive', 'foreground'];

export function normalizeSchedulingClass(value) {
  return typeof value === 'string' && REQUEST_CLASSES.includes(value) ? value : 'standard';
}
