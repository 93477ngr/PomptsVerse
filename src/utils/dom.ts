import DOMPurify from 'dompurify';

export class RawHtml {
  constructor(public value: string) {}
}

export function raw(value: string): RawHtml {
  return new RawHtml(value);
}

export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  const s = String(str);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(str: unknown): string {
  return escapeHtml(str);
}

export function safeUrl(url: unknown, fallback = 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80'): string {
  if (!url || typeof url !== 'string') return fallback;
  const trimmed = url.trim();
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://') || trimmed.startsWith('/') || trimmed.startsWith('data:image/')) {
    // Avoid javascript: protocol attacks
    if (/^\s*javascript:/i.test(trimmed)) return fallback;
    return escapeAttr(trimmed);
  }
  return fallback;
}

export function html(strings: TemplateStringsArray, ...values: any[]): string {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    if (val instanceof RawHtml) {
      result += val.value;
    } else if (Array.isArray(val)) {
      result += val.map(v => (v instanceof RawHtml ? v.value : escapeHtml(v))).join('');
    } else {
      result += escapeHtml(val);
    }
    result += strings[i + 1];
  }
  return result;
}

export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: ['p', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'br', 'span', 'div', 'img'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt', 'class', 'id', 'title', 'style'],
    ALLOW_DATA_ATTR: false
  });
}

export function getElementSafe<T extends HTMLElement = HTMLElement>(id: string, required = false): T | null {
  const el = document.getElementById(id) as T | null;
  if (!el && required && process.env.NODE_ENV !== 'production') {
    console.warn(`[DOM Guard] Expected element with id "${id}" not found in current document.`);
  }
  return el;
}
