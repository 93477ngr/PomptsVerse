export interface RouteState {
  view: string;
  params: Record<string, string>;
  query: Record<string, string>;
  rawPath: string;
}

type RouteCallback = (state: RouteState) => void;

let isNavigating = false;
let currentRouteState: RouteState | null = null;
let routeCallback: RouteCallback | null = null;

const SITE_NAME = 'PromptsOne';
const BASE_TITLE = 'PromptsOne — Google for AI Prompts & Engineering Portal';

const ROUTE_TITLES: Record<string, string> = {
  home: 'PromptsOne — Google for AI Prompts',
  search: 'Search AI Prompts — PromptsOne',
  collections: 'Curated AI Prompt Collections — PromptsOne',
  blog: 'AI Prompt Engineering Blog — PromptsOne',
  about: 'About Us — PromptsOne',
  privacy: 'Privacy Policy — PromptsOne',
  terms: 'Terms of Service — PromptsOne',
  cookies: 'Cookie Policy — PromptsOne',
  contact: 'Contact Us — PromptsOne',
  docs: 'Help Center & Documentation — PromptsOne',
  dashboard: 'Creator Workspace — PromptsOne',
  notFound: '404 Page Not Found — PromptsOne'
};

const VIEW_TO_PATH: Record<string, string> = {
  home: '/',
  search: '/search',
  collections: '/collections',
  blog: '/blog',
  about: '/about',
  privacy: '/privacy',
  terms: '/terms',
  cookies: '/cookies',
  contact: '/contact',
  docs: '/docs',
  dashboard: '/dashboard'
};

// Viewed prompt tracker in sessionStorage to prevent double counting
const VIEWED_PROMPTS_KEY = 'promptsone_viewed_ids';

export function isPromptAlreadyViewedInSession(promptId: string): boolean {
  try {
    const raw = sessionStorage.getItem(VIEWED_PROMPTS_KEY);
    const viewed = raw ? JSON.parse(raw) : [];
    return Array.isArray(viewed) && viewed.includes(promptId);
  } catch {
    return false;
  }
}

export function markPromptViewedInSession(promptId: string): void {
  try {
    const raw = sessionStorage.getItem(VIEWED_PROMPTS_KEY);
    const viewed: string[] = raw ? JSON.parse(raw) : [];
    if (!viewed.includes(promptId)) {
      viewed.push(promptId);
      sessionStorage.setItem(VIEWED_PROMPTS_KEY, JSON.stringify(viewed));
    }
  } catch {
    /* ignore session errors */
  }
}

export function parsePath(pathname: string, search = '', hash = ''): RouteState {
  const cleanPath = pathname.replace(/\/+$/, '') || '/';
  const queryParams: Record<string, string> = {};
  if (search) {
    const urlParams = new URLSearchParams(search);
    urlParams.forEach((val, key) => { queryParams[key] = val; });
  }

  // Fallback support for old hash routes like #prompt/123 or #search
  if (hash && hash.startsWith('#')) {
    const hashContent = hash.slice(1);
    if (hashContent.startsWith('prompt/')) {
      const id = hashContent.replace('prompt/', '');
      return { view: 'details', params: { id }, query: queryParams, rawPath: `/prompt/${id}` };
    }
    if (hashContent.startsWith('blog/')) {
      const slug = hashContent.replace('blog/', '');
      return { view: 'blog-detail', params: { slug }, query: queryParams, rawPath: `/blog/${slug}` };
    }
    if (VIEW_TO_PATH[hashContent]) {
      return { view: hashContent, params: {}, query: queryParams, rawPath: VIEW_TO_PATH[hashContent] };
    }
  }

  if (cleanPath === '/') {
    return { view: 'home', params: {}, query: queryParams, rawPath: '/' };
  }
  if (cleanPath === '/search') {
    return { view: 'search', params: {}, query: queryParams, rawPath: '/search' };
  }
  if (cleanPath.startsWith('/prompt/')) {
    const id = cleanPath.replace('/prompt/', '');
    return { view: 'details', params: { id }, query: queryParams, rawPath: cleanPath };
  }
  if (cleanPath === '/collections') {
    return { view: 'collections', params: {}, query: queryParams, rawPath: '/collections' };
  }
  if (cleanPath === '/blog') {
    return { view: 'blog', params: {}, query: queryParams, rawPath: '/blog' };
  }
  if (cleanPath.startsWith('/blog/')) {
    const slug = cleanPath.replace('/blog/', '');
    return { view: 'blog-detail', params: { slug }, query: queryParams, rawPath: cleanPath };
  }
  if (cleanPath === '/about') return { view: 'about', params: {}, query: queryParams, rawPath: '/about' };
  if (cleanPath === '/privacy') return { view: 'privacy', params: {}, query: queryParams, rawPath: '/privacy' };
  if (cleanPath === '/terms') return { view: 'terms', params: {}, query: queryParams, rawPath: '/terms' };
  if (cleanPath === '/cookies') return { view: 'cookies', params: {}, query: queryParams, rawPath: '/cookies' };
  if (cleanPath === '/contact') return { view: 'contact', params: {}, query: queryParams, rawPath: '/contact' };
  if (cleanPath === '/docs') return { view: 'docs', params: {}, query: queryParams, rawPath: '/docs' };
  if (cleanPath === '/dashboard') return { view: 'dashboard', params: {}, query: queryParams, rawPath: '/dashboard' };

  return { view: 'notFound', params: {}, query: queryParams, rawPath: cleanPath };
}

export function updateHeadMetadata(view: string, customTitle?: string, customDesc?: string, customImage?: string): void {
  const origin = window.location.origin;
  const canonicalEl = document.getElementById('canonical-url') as HTMLLinkElement;
  if (canonicalEl) {
    canonicalEl.href = `${origin}${window.location.pathname}`;
  }

  const title = customTitle || ROUTE_TITLES[view] || BASE_TITLE;
  document.title = title;

  const setMeta = (property: string, content: string) => {
    let el = document.querySelector(`meta[property="${property}"]`) as HTMLMetaElement;
    if (!el) {
      el = document.querySelector(`meta[name="${property}"]`) as HTMLMetaElement;
    }
    if (el && content) {
      el.setAttribute('content', content);
    }
  };

  setMeta('og:title', title);
  setMeta('twitter:title', title);
  setMeta('og:url', `${origin}${window.location.pathname}`);
  setMeta('twitter:url', `${origin}${window.location.pathname}`);

  if (customDesc) {
    setMeta('description', customDesc);
    setMeta('og:description', customDesc);
    setMeta('twitter:description', customDesc);
  }

  if (customImage) {
    setMeta('og:image', customImage);
    setMeta('twitter:image', customImage);
  }
}

export function initRouter(cb: RouteCallback): void {
  routeCallback = cb;

  // Initial route execution
  const initialState = parsePath(window.location.pathname, window.location.search, window.location.hash);
  currentRouteState = initialState;
  updateHeadMetadata(initialState.view);
  cb(initialState);

  // Listen for browser navigation (Back / Forward)
  window.addEventListener('popstate', () => {
    if (isNavigating) return;
    const state = parsePath(window.location.pathname, window.location.search, window.location.hash);
    currentRouteState = state;
    updateHeadMetadata(state.view);
    if (routeCallback) routeCallback(state);
  });

  // Delegated click listener for HTML links with data-nav or href starting with '/'
  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('a[href^="/"], [data-nav]');
    if (!target) return;
    const href = target.getAttribute('href') || target.getAttribute('data-nav');
    if (!href || href.startsWith('http') || target.getAttribute('target') === '_blank') return;

    e.preventDefault();
    navigateToPath(href);
  });
}

export function navigateToPath(targetPath: string, push = true): void {
  if (isNavigating) return;
  isNavigating = true;

  try {
    const url = new URL(targetPath, window.location.origin);
    const state = parsePath(url.pathname, url.search, url.hash);
    currentRouteState = state;

    if (push && window.location.pathname + window.location.search !== url.pathname + url.search) {
      window.history.pushState({}, '', url.pathname + url.search);
    }

    updateHeadMetadata(state.view);
    if (routeCallback) {
      routeCallback(state);
    }
  } finally {
    isNavigating = false;
  }
}

export function navigateTo(view: string, options: { id?: string; slug?: string; query?: string; push?: boolean } = {}): void {
  if (isNavigating) return;
  const push = options.push ?? true;

  let targetPath = VIEW_TO_PATH[view] || '/';
  if (view === 'details' && options.id) {
    targetPath = `/prompt/${options.id}`;
  } else if (view === 'blog-detail' && options.slug) {
    targetPath = `/blog/${options.slug}`;
  } else if (view === 'search' && options.query) {
    targetPath = `/search?q=${encodeURIComponent(options.query)}`;
  }

  navigateToPath(targetPath, push);
}

export function getCurrentRouteState(): RouteState | null {
  return currentRouteState;
}
