import { FilterXSS } from 'xss';

// Zero allowed tags: every tag is removed, and the bodies of script/style are dropped too.
const stripAllHtml = new FilterXSS({
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style'],
});

// C0 controls except tab (\t), newline (\n) and carriage return (\r), plus DEL and C1 controls.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Normalises free text before it is stored: strips control characters and
 * all HTML (XSS defence-in-depth for any client that renders answers), then trims.
 */
export function sanitizeText(input: string): string {
  return stripAllHtml.process(input.normalize('NFC').replace(CONTROL_CHARS, '')).trim();
}
