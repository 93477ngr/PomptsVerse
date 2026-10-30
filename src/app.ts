import { 
  auth, 
  db, 
  googleProvider, 
  handleFirestoreError, 
  OperationType, 
  syncUserDoc, 
  getUserRole, 
  uploadToCloudinary,
  optimizeCloudinaryUrl,
  testConnection 
} from './firebase';
import { 
  signInWithPopup, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  updateProfile,
  signOut as firebaseSignOut, 
  onAuthStateChanged,
  User 
} from 'firebase/auth';
import { 
  collection, 
  doc, 
  getDoc,
  getDocs, 
  addDoc, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  onSnapshot, 
  serverTimestamp, 
  increment, 
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  QueryDocumentSnapshot,
  DocumentData
} from 'firebase/firestore';
import {
  initAdsSystem,
  injectFeedAds,
  renderDetailPageAds,
  renderSearchAds,
  setupAdObservers
} from './ads';

// Lucide type helper
declare const lucide: { createIcons: () => void };

// =============================================================================
// DATA INTERFACES
// =============================================================================
export interface PromptItem {
  id: string;
  title: string;
  tool: string;
  category: string;
  image: string;
  images?: string[];         // Support for multiple example images/variations
  prompt: string;
  negative?: string;
  views: number;
  likes: number;
  downloads: number;
  copyCount?: number;        // Track copy events separately from downloads
  creator: string;
  creatorId?: string;
  featured: boolean;
  trending: boolean;
  status: 'approved' | 'pending' | 'rejected';
  rankScore?: number;        // Precomputed server-side score (written on save)
  baseScore?: number;        // Precomputed base popularity score
  seasonalTags?: string[];   // e.g. ['ganesh','festival','diwali']
  tags?: string[];           // General hashtags
  createdAt?: any;
  updatedAt?: any;
  _score?: number;           // Runtime computed score (never persisted to Firestore)
}

export interface CategoryItem {
  id: string;
  name: string;
  icon: string;
  count: number;
  promptCount?: number;
}


// =============================================================================
// APP STATE
// =============================================================================

// Home page cache — approved prompts only, paginated from Firestore
let prompts: PromptItem[] = [];
let adminAllPrompts: PromptItem[] = [];

const DEFAULT_CATEGORIES: CategoryItem[] = [
  { id: 'cat-art', name: 'AI Art', icon: 'palette', count: 0, promptCount: 0 },
  { id: 'cat-festivals', name: 'Festivals', icon: 'sparkles', count: 0, promptCount: 0 },
  { id: 'cat-birthday', name: 'Birthday', icon: 'gift', count: 0, promptCount: 0 },
  { id: 'cat-wedding', name: 'Wedding', icon: 'heart', count: 0, promptCount: 0 },
  { id: 'cat-business', name: 'Business', icon: 'briefcase', count: 0, promptCount: 0 },
  { id: 'cat-realestate', name: 'Real Estate', icon: 'home', count: 0, promptCount: 0 },
  { id: 'cat-socialmedia', name: 'Social Media', icon: 'share-2', count: 0, promptCount: 0 },
  { id: 'cat-marketing', name: 'Marketing', icon: 'trending-up', count: 0, promptCount: 0 },
  { id: 'cat-photography', name: 'Photography', icon: 'camera', count: 0, promptCount: 0 },
  { id: 'cat-wallpaper', name: 'Wallpaper', icon: 'image', count: 0, promptCount: 0 },
  { id: 'cat-anime', name: 'Anime', icon: 'smile', count: 0, promptCount: 0 },
  { id: 'cat-3d', name: '3D Render', icon: 'box', count: 0, promptCount: 0 },
  { id: 'cat-logo', name: 'Logo Design', icon: 'pen-tool', count: 0, promptCount: 0 },
  { id: 'cat-portraits', name: 'Portraits', icon: 'user', count: 0, promptCount: 0 },
  { id: 'cat-fantasy', name: 'Fantasy', icon: 'wand-2', count: 0, promptCount: 0 },
  { id: 'cat-architecture', name: 'Architecture', icon: 'building', count: 0, promptCount: 0 }
];

let categories: CategoryItem[] = [...DEFAULT_CATEGORIES];
let bookmarks: string[] = [];
let userLikes: string[] = [];
let currentSelectedPrompt: PromptItem | null = null;
let activeView = 'home';
let currentUser: User | null = null;
let currentUserRole: 'admin' | 'user' = 'user';
const ADMIN_EMAILS = [
  'gangareddynaredla24925@gmail.com',
  'localride369@gmail.com'
];
let isAuthLoading = true;
let unsubscribeBookmarks: (() => void) | null = null;
let unsubscribeLikes: (() => void) | null = null;
let unsubscribeInitialPrompts: (() => void) | null = null;
let unsubscribeTrendingPrompts: (() => void) | null = null;

// Pagination state
let lastVisibleDoc: QueryDocumentSnapshot<DocumentData> | null = null;
let isLoadingMore = false;
let hasMorePrompts = true;
let isInitialLoading = true;
let currentSortType = 'popular'; // 'popular' | 'newest' | 'likes' | 'trending'
let activeTrendingHashtags: string[] = [
  '#AIPrompts', '#ChatGPT', '#PromptEngineering', '#MidjourneyPrompt',
  '#GenerativeAI', '#FluxAI', '#AICreators', '#PromptOfTheDay'
];
let currentToolFilter = 'all';   // 'all' | tool name
let currentEventTheme = 'ai_core';
let cachedStatsConfig: any = {};
let liveJitterInterval: any = null;
let currentLiveBase = 128;

async function incrementCopiedTodayCounter() {
  try {
    const statsRef = doc(db, 'siteConfigs', 'stats');
    await setDoc(statsRef, { copiedToday: increment(1) }, { merge: true });
  } catch (_) { /* silent */ }
}

function renderRealtimeStatsBar(_statsConfig: any = cachedStatsConfig) {
  if (liveJitterInterval) {
    clearInterval(liveJitterInterval);
    liveJitterInterval = null;
  }
  const bar = document.getElementById('stats-counter-bar');
  if (bar) {
    bar.style.display = 'none';
    bar.innerHTML = '';
  }
}

const EVENT_THEMES: Record<string, { bgClass: string; badge: string; chips: Array<{ text: string; query: string }> }> = {
  ai_core: {
    bgClass: 'bg-[#f8fafc] text-slate-800',
    badge: '⚡ AI Core',
    chips: [
      { text: 'ChatGPT', query: 'chatgpt' },
      { text: 'Midjourney', query: 'midjourney' },
      { text: 'Claude', query: 'claude' }
    ]
  },
  ganesh: {
    bgClass: 'bg-amber-50/50',
    badge: '🌸 Ganesh Chaturthi Special',
    chips: [
      { text: 'Ganesha', query: 'ganesha' },
      { text: 'Festival', query: 'festival' },
      { text: 'Indian', query: 'indian' }
    ]
  },
  diwali: {
    bgClass: 'bg-orange-50/50',
    badge: '🪔 Diwali Festival of Lights',
    chips: [
      { text: 'Diya', query: 'diya' },
      { text: 'Diwali', query: 'diwali' },
      { text: 'Festival', query: 'festival' }
    ]
  },
  christmas: {
    bgClass: 'bg-red-50/50',
    badge: '🎄 Merry Christmas',
    chips: [
      { text: 'Christmas', query: 'christmas' },
      { text: 'Santa', query: 'santa' },
      { text: 'Winter', query: 'winter' }
    ]
  },
  newyear: {
    bgClass: 'bg-indigo-950 text-white',
    badge: '✨ Happy New Year',
    chips: [
      { text: 'New Year', query: 'new year' },
      { text: 'Resolution', query: 'resolution' }
    ]
  },
  valentine: {
    bgClass: 'bg-rose-50/50',
    badge: "💖 Valentine's Day Special",
    chips: [
      { text: 'Love', query: 'love' },
      { text: 'Valentine', query: 'valentine' },
      { text: 'Gift', query: 'gift' }
    ]
  },
  holi: {
    bgClass: 'bg-yellow-50/50',
    badge: '🎨 Holi Festival of Colors',
    chips: [
      { text: 'Colors', query: 'colors' },
      { text: 'Holi', query: 'holi' }
    ]
  },
  eid: {
    bgClass: 'bg-emerald-50/50',
    badge: '🌙 Eid Mubarak',
    chips: [
      { text: 'Eid', query: 'eid' },
      { text: 'Festival', query: 'festival' }
    ]
  },
  raksha: {
    bgClass: 'bg-pink-50/50',
    badge: '🎀 Raksha Bandhan',
    chips: [
      { text: 'Rakhi', query: 'rakhi' },
      { text: 'Sibling', query: 'sibling' }
    ]
  },
  halloween: {
    bgClass: 'bg-orange-950 text-white',
    badge: '🎃 Spooky Halloween',
    chips: [
      { text: 'Spooky', query: 'spooky' },
      { text: 'Halloween', query: 'halloween' }
    ]
  }
};

const HOME_PAGE_LIMIT = 24;
const LOAD_MORE_LIMIT = 12;


// =============================================================================
// RANKING ENGINE — Deterministic, Canonical, No Random
// =============================================================================

// Compute base popularity score (written to Firestore as rankScore on prompt save)
function computeBaseScore(p: Partial<PromptItem>): number {
  let score = 0;
  score += (p.views || 0) * 0.1;
  score += (p.likes || 0) * 1.5;
  score += (p.downloads || 0) * 3.0;
  score += (p.copyCount || 0) * 2.0;
  if (p.featured) score += 150;
  if (p.trending) score += 50;
  return Math.round(score);
}

/**
 * Full deterministic client-side ranking score.
 * Priority order:
 *   1. Precomputed server rankScore blend (if present)
 *   2. Popularity: views + likes + downloads + copyCount
 *   3. Recency decay: half-life ~23 days (content decays by up to 50%)
 *   4. Admin/editorial boosts: featured (+150), trending (+50)
 *   5. Search relevance (8 tiers): exact title → starts-with → contains → category → tool → tags → prompt text
 */
function computeRankScore(p: PromptItem, queryStr = ''): number {
  let score = 0;

  // 1. Blend precomputed server score
  if (p.rankScore && p.rankScore > 0) {
    score += p.rankScore * 0.5;
  }

  // 2. Popularity metrics
  const popularityScore =
    (p.views || 0) * 0.1
    + (p.likes || 0) * 1.5
    + (p.downloads || 0) * 3.0
    + (p.copyCount || 0) * 2.0;

  // 3. Recency decay — newer content boosted, old content decays (half-life ~23 days)
  let recencyMultiplier = 1.0;
  if (p.createdAt?.seconds) {
    const nowSeconds = Date.now() / 1000;
    const daysOld = Math.max(0, (nowSeconds - p.createdAt.seconds) / 86400);
    recencyMultiplier = 0.5 + 0.5 * Math.exp(-0.03 * daysOld);
  }
  score += popularityScore * recencyMultiplier;

  // 4. Editorial boosts (immune to recency decay — always apply)
  if (p.featured) score += 150;
  if (p.trending) score += 50;

  // 5. Seasonal theme alignment — no hardcoded themes; Firestore-driven only (ranking boost removed)

  // 6. Search relevance — tiered priority scoring
  if (queryStr) {
    const q = queryStr.toLowerCase().trim();
    const titleLow   = p.title.toLowerCase();
    const catLow     = p.category.toLowerCase();
    const toolLow    = p.tool.toLowerCase();
    const textLow    = p.prompt.toLowerCase();
    const tagsLow    = [...(p.tags || []), ...(p.seasonalTags || [])].join(' ').toLowerCase();

    if (titleLow === q)              score += 500; // Exact title match (highest priority)
    else if (titleLow.startsWith(q)) score += 350; // Title starts with query
    else if (titleLow.includes(q))   score += 200; // Title contains query

    if (catLow.includes(q))   score += 150; // Category match
    if (toolLow.includes(q))  score += 100; // AI tool match
    if (tagsLow.includes(q))  score += 75;  // Tag / seasonal tag match
    if (textLow.includes(q))  score += 50;  // Prompt body match (lowest priority)
  }

  return score;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatNumber(n: number): string {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function findPromptById(id: string): PromptItem | undefined {
  return prompts.find(p => p.id === id) || adminAllPrompts.find(p => p.id === id);
}

// Deduplicate an array of prompts by id
function dedupePrompts(arr: PromptItem[]): PromptItem[] {
  const seen = new Set<string>();
  return arr.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

function renderHeroVisualPanels(_items: PromptItem[]) {
  const leftPanel = document.getElementById('hero-left-panel');
  const rightPanel = document.getElementById('hero-right-panel');
  if (leftPanel) leftPanel.innerHTML = '';
  if (rightPanel) rightPanel.innerHTML = '';
}

function renderLiveAITrendsTicker(items: PromptItem[]) {
  const container = document.getElementById('live-ai-trends-ticker');
  if (!container) return;
  const approved = items.filter(p => p.status === 'approved' && p.trending).slice(0, 6);
  const displayItems = approved.length > 0 ? approved : items.filter(p => p.status === 'approved').slice(0, 6);

  if (displayItems.length === 0) {
    container.innerHTML = `
      <span class="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 font-extrabold uppercase tracking-wider text-[10px] flex items-center gap-1 shrink-0">
        🔥 Live AI Trends
      </span>
      <span class="text-slate-400 text-[10px] font-medium ml-2">No active trends</span>
    `;
    return;
  }

  container.innerHTML = `
    <span class="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 font-extrabold uppercase tracking-wider text-[10px] flex items-center gap-1 shrink-0">
      🔥 Live AI Trends
    </span>
    ${displayItems.map((p, idx) => `
      ${idx > 0 ? '<span class="text-slate-700 font-medium">•</span>' : ''}
      <button onclick="quickSearch('${p.title.replace(/'/g, "\\'")}')" class="hover:text-amber-300 transition flex items-center gap-1 font-semibold text-slate-200 text-xs">${p.title}</button>
    `).join('')}
  `;
}

// =============================================================================
// LOADING SKELETONS
// =============================================================================

function renderLoadingSkeleton(container: HTMLElement | null, count: number) {
  if (!container) return;
  container.innerHTML = Array(count).fill(0).map(() => `
    <div class="bg-white rounded-2xl border border-slate-200/90 shadow-card overflow-hidden animate-pulse flex flex-col">
      <div class="h-48 bg-gradient-to-br from-slate-100 to-slate-200"></div>
      <div class="p-3.5 space-y-2 flex-1">
        <div class="h-3 bg-slate-200 rounded-lg w-3/4"></div>
        <div class="h-2 bg-slate-100 rounded w-full"></div>
        <div class="h-2 bg-slate-100 rounded w-5/6"></div>
      </div>
      <div class="px-3.5 pb-3.5 pt-2 flex items-center justify-between border-t border-slate-100">
        <div class="h-2 bg-slate-100 rounded w-1/4"></div>
        <div class="h-6 bg-blue-50 rounded-lg w-14"></div>
      </div>
    </div>
  `).join('');
}

function renderTrendingSkeletons(container: HTMLElement | null, count: number) {
  if (!container) return;
  container.innerHTML = Array(count).fill(0).map(() => `
    <div class="bg-white rounded-2xl border border-slate-200/80 shadow-card overflow-hidden animate-pulse">
      <div class="h-40 bg-gradient-to-br from-slate-100 to-slate-200"></div>
      <div class="p-3.5 space-y-2">
        <div class="h-3 bg-slate-200 rounded w-3/4"></div>
        <div class="flex items-center justify-between pt-1 border-t border-slate-100 mt-1">
          <div class="h-2 bg-slate-100 rounded w-12"></div>
          <div class="h-2 bg-slate-100 rounded w-12"></div>
        </div>
      </div>
    </div>
  `).join('');
}

// =============================================================================
// EMPTY STATE
// =============================================================================

function renderEmptyState(
  container: HTMLElement | null,
  message: string,
  subtext = 'Try different keywords or browse all categories'
) {
  if (!container) return;
  container.innerHTML = `
    <div class="col-span-full text-center py-16 space-y-4">
      <div class="w-16 h-16 mx-auto rounded-2xl bg-slate-100 flex items-center justify-center">
        <i data-lucide="search-x" class="w-8 h-8 text-slate-300"></i>
      </div>
      <div>
        <h3 class="font-bold text-slate-700 text-sm">${message}</h3>
        <p class="text-xs text-slate-400 mt-1">${subtext}</p>
      </div>
      <button onclick="resetSearchFilters(); navigateTo('home');"
        class="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-xs font-bold rounded-xl hover:bg-blue-700 transition">
        <i data-lucide="home" class="w-3.5 h-3.5"></i> Browse All Prompts
      </button>
    </div>
  `;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Dynamic site configuration from Firestore
async function loadSiteConfigs() {
  try {
    // 0. Site Global Branding & settings
    const siteSettingsRef = doc(db, 'settings', 'site');
    onSnapshot(siteSettingsRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        // Update Brand Name (Header & Footer)
        const brandNameEl = document.getElementById('site-brand-name');
        if (brandNameEl && data.brandName) {
          brandNameEl.textContent = data.brandName;
        }
        const footerBrandNameEl = document.getElementById('footer-brand-name');
        if (footerBrandNameEl && data.brandName) {
          footerBrandNameEl.textContent = data.brandName;
        }
        
        // Update dynamic <title>
        document.title = data.seoTitle || (data.brandName ? (data.brandName + ' — AI Prompt Engine') : 'PromptVerse AI - Google for AI Prompts');

        // Update meta tags
        const helpers = {
          setMeta: (name: string, val: string) => {
            let el = document.querySelector(`meta[name='${name}']`);
            if (!el && val) {
              el = document.createElement('meta');
              el.setAttribute('name', name);
              document.head.appendChild(el);
            }
            if (el) { if (val) el.setAttribute('content', val); else el.remove(); }
          },
          setProperty: (prop: string, val: string) => {
            let el = document.querySelector(`meta[property='${prop}']`);
            if (!el && val) {
              el = document.createElement('meta');
              el.setAttribute('property', prop);
              document.head.appendChild(el);
            }
            if (el) { if (val) el.setAttribute('content', val); else el.remove(); }
          }
        };

        helpers.setMeta('description', data.metaDescription || '');
        helpers.setMeta('keywords', data.searchKeywords || '');
        if (data.googleVerification) {
          helpers.setMeta('google-site-verification', data.googleVerification);
        }
        if (data.bingVerification) {
          helpers.setMeta('msvalidate.01', data.bingVerification);
        }
        if (data.robotsDirective) {
          helpers.setMeta('robots', data.robotsDirective);
        }
        if (data.author) {
          helpers.setMeta('author', data.author);
        }
        if (Array.isArray(data.trendingHashtags) && data.trendingHashtags.length > 0) {
          activeTrendingHashtags = [...data.trendingHashtags];
          renderGalleryTagPills();
        }

        // Canonical URL
        const canonicalVal = data.canonicalUrl || 'https://promptsone.com/';
        let canonicalEl = document.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
        if (!canonicalEl && canonicalVal) {
          canonicalEl = document.createElement('link');
          canonicalEl.rel = 'canonical';
          document.head.appendChild(canonicalEl);
        }
        if (canonicalEl) {
          canonicalEl.href = canonicalVal;
        }

        // Open Graph
        helpers.setProperty('og:title', data.ogTitle || data.seoTitle || '');
        helpers.setProperty('og:description', data.ogDescription || data.metaDescription || '');
        helpers.setProperty('og:image', data.ogImage || data.logoUrl || '');
        helpers.setProperty('og:url', canonicalVal);
        helpers.setProperty('og:site_name', data.ogSiteName || data.brandName || 'PromptsOne');

        // Twitter Cards
        helpers.setMeta('twitter:card', data.twitterCard || 'summary_large_image');
        helpers.setMeta('twitter:title', data.ogTitle || data.seoTitle || '');
        helpers.setMeta('twitter:description', data.ogDescription || data.metaDescription || '');
        helpers.setMeta('twitter:image', data.ogImage || data.logoUrl || '');
        helpers.setMeta('twitter:url', canonicalVal);
        if (data.twitterCreator) {
          helpers.setMeta('twitter:creator', data.twitterCreator);
          helpers.setMeta('twitter:site', data.twitterCreator);
        }
        
        // JSON-LD Structured Data
        let script = document.querySelector("script[type='application/ld+json']") as HTMLScriptElement | null;
        if (data.structuredDataOrg) {
          if (!script) {
            script = document.createElement('script');
            script.type = 'application/ld+json';
            document.head.appendChild(script);
          }
          script.textContent = data.structuredDataOrg;
        } else if (script) {
          script.remove();
        }

        // Update Logo Image (Header & Footer)
        const logoContainer = document.getElementById('site-logo-container');
        if (logoContainer && data.logoUrl) {
          logoContainer.innerHTML = `<img src="${data.logoUrl}" class="w-10 h-10 object-contain rounded-xl" alt="Logo" />`;
          logoContainer.className = "w-10 h-10 flex items-center justify-center transition duration-300 group-hover:scale-105";
        }
        const footerLogoContainer = document.getElementById('footer-logo-container');
        if (footerLogoContainer && data.logoUrl) {
          footerLogoContainer.innerHTML = `<img src="${data.logoUrl}" class="w-9 h-9 object-contain rounded-xl" alt="Logo" />`;
          footerLogoContainer.className = "w-9 h-9 flex items-center justify-center transition duration-300 group-hover:scale-105";
        }
        
        // Update Favicon URL
        if (data.faviconUrl) {
          let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
          if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.appendChild(link);
          }
          link.href = data.faviconUrl;
        }
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'settings/site');
    });

    // Real-Time Listener for dedicated settings/seo
    onSnapshot(doc(db, 'settings', 'seo'), (snap) => {
      if (snap.exists()) {
        const seo = snap.data();
        if (seo.seoTitle) document.title = seo.seoTitle;
        const setMetaHelper = (name: string, val: string) => {
          if (!val) return;
          let el = document.querySelector(`meta[name='${name}']`);
          if (!el) { el = document.createElement('meta'); el.setAttribute('name', name); document.head.appendChild(el); }
          el.setAttribute('content', val);
        };
        const setPropHelper = (prop: string, val: string) => {
          if (!val) return;
          let el = document.querySelector(`meta[property='${prop}']`);
          if (!el) { el = document.createElement('meta'); el.setAttribute('property', prop); document.head.appendChild(el); }
          el.setAttribute('content', val);
        };
        if (seo.metaDescription) setMetaHelper('description', seo.metaDescription);
        if (seo.searchKeywords) setMetaHelper('keywords', seo.searchKeywords);
        if (seo.googleVerification) setMetaHelper('google-site-verification', seo.googleVerification);
        if (seo.bingVerification) setMetaHelper('msvalidate.01', seo.bingVerification);
        if (seo.robotsDirective) setMetaHelper('robots', seo.robotsDirective);
        if (seo.author) setMetaHelper('author', seo.author);
        if (seo.ogTitle) setPropHelper('og:title', seo.ogTitle);
        if (seo.ogDescription) setPropHelper('og:description', seo.ogDescription);
        if (seo.ogImage) setPropHelper('og:image', seo.ogImage);
        if (seo.canonicalUrl) {
          let canonicalEl = document.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
          if (canonicalEl) canonicalEl.href = seo.canonicalUrl;
        }
        if (seo.structuredDataOrg) {
          let s = document.querySelector("script[type='application/ld+json']") as HTMLScriptElement | null;
          if (!s) { s = document.createElement('script'); s.type = 'application/ld+json'; document.head.appendChild(s); }
          s.textContent = seo.structuredDataOrg;
        }
        if (Array.isArray(seo.trendingHashtags) && seo.trendingHashtags.length > 0) {
          activeTrendingHashtags = [...seo.trendingHashtags];
          renderGalleryTagPills();
        }
      }
    }, () => {});

    // 1. Hero
    const heroRef = doc(db, 'siteConfigs', 'hero');
    onSnapshot(heroRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        const headlineEl = document.getElementById('hero-headline');
        const subtitleEl = document.getElementById('hero-subtitle');
        const badgeEl = document.getElementById('hero-event-badge');
        if (headlineEl && data.headline) headlineEl.innerHTML = data.headline;
        if (subtitleEl && data.subtitle) subtitleEl.innerText = data.subtitle;
        if (badgeEl && data.badgeText) badgeEl.innerText = data.badgeText;
        if (data.typewriterPhrases && Array.isArray(data.typewriterPhrases)) {
          typewriterPhrases = data.typewriterPhrases;
        }
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'siteConfigs/hero');
    });

    // 2. Real-Time Dynamic Statistics Engine
    const statsRef = doc(db, 'siteConfigs', 'stats');
    onSnapshot(statsRef, (snap) => {
      if (snap.exists()) {
        cachedStatsConfig = snap.data();
      } else {
        cachedStatsConfig = {};
      }
      renderRealtimeStatsBar(cachedStatsConfig);
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'siteConfigs/stats');
    });

    // 3. Seasonal Campaigns — live listener on 'seasonalCampaigns' collection
    // Only campaigns with active:true (and within scheduledStart/scheduledEnd if set) render on homepage.
    const campaignsRef = collection(db, 'seasonalCampaigns');
    onSnapshot(query(campaignsRef, orderBy('order', 'asc')), (snap) => {
      const bannerSec = document.getElementById('festive-special-banner-section');
      const chipsEl = document.getElementById('hero-popular-chips');
      const chipsWrapper = document.getElementById('hero-popular-chips-wrapper');

      const now = new Date();

      // Find first active campaign that is within its scheduled window (if any)
      let activeCampaign: any = null;
      for (const docSnap of snap.docs) {
        const data = { id: docSnap.id, ...docSnap.data() } as any;
        if (!data.active) continue;
        // Check scheduling window
        if (data.scheduledStart) {
          const start = data.scheduledStart.seconds ? new Date(data.scheduledStart.seconds * 1000) : new Date(data.scheduledStart);
          if (now < start) continue;
        }
        if (data.scheduledEnd) {
          const end = data.scheduledEnd.seconds ? new Date(data.scheduledEnd.seconds * 1000) : new Date(data.scheduledEnd);
          if (now > end) continue;
        }
        activeCampaign = data;
        break; // Use the first valid active campaign (lowest order)
      }

      // Render (or clear) the festive banner
      if (bannerSec) {
        if (activeCampaign) {
          bannerSec.innerHTML = `
            <div class="${activeCampaign.bgClass || 'bg-gradient-to-br from-slate-900 to-indigo-950'} rounded-2xl p-6 text-white shadow-xl flex flex-col md:flex-row items-center justify-between gap-6 relative overflow-hidden">
              <div class="space-y-2 max-w-2xl relative z-10">
                <span class="px-3 py-1 rounded-full bg-white/20 text-white text-xs font-bold uppercase tracking-wider backdrop-blur-md">
                  ${activeCampaign.tag || '🎉 Special Campaign'}
                </span>
                <h3 class="text-xl sm:text-2xl font-extrabold leading-snug">
                  ${activeCampaign.title || ''}
                </h3>
                <p class="text-xs sm:text-sm text-slate-300 leading-relaxed">
                  ${activeCampaign.subtitle || ''}
                </p>
              </div>
              <div class="flex items-center gap-3 shrink-0 relative z-10">
                <button onclick="quickSearch('${(activeCampaign.searchQuery || '').replace(/'/g, "\\'")}')"
                  class="px-6 py-3 bg-white hover:bg-slate-50 text-slate-900 font-extrabold text-xs sm:text-sm rounded-xl shadow-lg transition transform hover:scale-105 flex items-center gap-2">
                  Explore Collection <i data-lucide="arrow-right" class="w-4 h-4"></i>
                </button>
              </div>
            </div>
          `;
          if (typeof lucide !== 'undefined') lucide.createIcons();
        } else {
          bannerSec.innerHTML = ''; // No active campaign — clean slate
        }
      }

      // Render chips for the active campaign (or hide the chips wrapper)
      if (chipsEl && chipsWrapper) {
        if (activeCampaign && Array.isArray(activeCampaign.chips) && activeCampaign.chips.length > 0) {
          chipsWrapper.classList.remove('hidden');
          chipsEl.innerHTML = activeCampaign.chips.map((chip: any) => `
            <button onclick="quickSearch('${(chip.query || chip.text || '').replace(/'/g, "\\'")}')"
              class="px-3 py-1.5 rounded-full bg-white hover:bg-slate-50 text-slate-800 font-medium border border-slate-200/60 transition flex items-center gap-1.5 shadow-sm transform hover:scale-105">
              ${chip.text || chip.query}
            </button>
          `).join('');
        } else {
          chipsEl.innerHTML = '';
          chipsWrapper.classList.add('hidden');
        }
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, 'seasonalCampaigns');
    });

    // 4. Community Section Configuration
    const commRef = doc(db, 'siteConfigs', 'community');
    onSnapshot(commRef, (snap) => {
      const container = document.getElementById('community-section-container');
      if (!container) return;
      if (snap.exists()) {
        const data = snap.data();
        container.style.display = 'block';
        container.innerHTML = `
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center">
              <i data-lucide="message-square" class="w-5 h-5"></i>
            </div>
            <div>
              <h4 class="font-bold text-sm">${data.title}</h4>
              <p class="text-xs text-slate-400">${data.subtitle || ''}</p>
            </div>
          </div>
          <p class="text-xs text-slate-300 leading-relaxed">${data.description || ''}</p>
          <button onclick="window.open('${data.inviteUrl || '#'}', '_blank')" class="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs rounded-xl transition">
            ${data.buttonText || 'Join Community'}
          </button>
        `;
      } else {
        container.style.display = 'none';
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'siteConfigs/community');
    });

    // 5. Contact Desk & Social Media Settings
    const contactSettingsRef = doc(db, 'settings', 'contact');
    onSnapshot(contactSettingsRef, (snap) => {
      const setEl = (id: string, text: string) => { const el = document.getElementById(id); if (el) el.textContent = text; };
      const iframe = document.getElementById('contact-page-map') as HTMLIFrameElement;
      const submitBtn = document.getElementById('contact-submit-btn') as HTMLButtonElement;

      const defaultPhone = '+1 (800) 555-0199';
      const defaultEmail = 'support@promptsone.com';
      const defaultAddress = 'Global AI Hub, Silicon Valley, CA';
      const defaultHours = 'Mon - Fri: 9:00 AM - 6:00 PM IST';

      if (snap.exists()) {
        const data = snap.data();
        setEl('footer-phone', data.phone || defaultPhone);
        setEl('footer-email', data.email || defaultEmail);
        setEl('footer-address', data.address || defaultAddress);
        setEl('footer-hours', data.businessHours || defaultHours);

        renderFooterSocialLinks(data);

        setEl('contact-page-phone', data.phone || defaultPhone);
        setEl('contact-page-email', data.email || defaultEmail);
        setEl('contact-page-address', data.address || defaultAddress);
        setEl('contact-page-hours', data.businessHours || defaultHours);

        if (iframe && data.googleMapsEmbed) {
          iframe.src = data.googleMapsEmbed;
        }

        if (submitBtn) {
          if (data.contactFormEnabled === false) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<i data-lucide="lock" class="w-4 h-4"></i> Form Disabled by Admin`;
            submitBtn.className = 'w-full sm:w-auto px-6 py-3 bg-slate-400 text-white font-extrabold rounded-xl cursor-not-allowed flex items-center justify-center gap-2';
          } else {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i data-lucide="send" class="w-4 h-4"></i> Submit Inquiry`;
            submitBtn.className = 'w-full sm:w-auto px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-extrabold rounded-xl transition shadow-md shadow-blue-500/25 flex items-center justify-center gap-2';
          }
        }
      } else {
        setEl('footer-phone', defaultPhone);
        setEl('footer-email', defaultEmail);
        setEl('footer-address', defaultAddress);
        setEl('footer-hours', defaultHours);
        renderFooterSocialLinks({});
        setEl('contact-page-phone', defaultPhone);
        setEl('contact-page-email', defaultEmail);
        setEl('contact-page-address', defaultAddress);
        setEl('contact-page-hours', defaultHours);
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'settings/contact');
    });
  } catch (err) {
    console.warn('Error loading site configs:', err);
  }
}

function isValidSocialLink(rawUrl: any): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const url = rawUrl.trim();
  if (!url) return false;

  const lower = url.toLowerCase();
  const dummyPlaceholders = [
    'yourhandle',
    'yourpage',
    'yourchannel',
    '@yourchannel',
    '/username',
    'yourprofile',
    'yourorg',
    'invitecode',
    'promptsone',
    '15550199',
    'example.com'
  ];
  for (const placeholder of dummyPlaceholders) {
    if (lower.includes(placeholder)) return false;
  }

  // Accept WhatsApp phone numbers (e.g. 9876543210 or +919876543210)
  if (/^\+?[0-9]{7,15}$/.test(url.replace(/[\s-]/g, ''))) return true;
  // Accept standard web URLs
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('wa.me/')) return true;
  // Accept domain-style inputs without protocol
  if (lower.includes('.com/') || lower.includes('.me/') || lower.includes('.gg/') || lower.includes('.org/')) return true;

  return false;
}

function formatSocialUrl(key: string, rawVal: string): string {
  let val = (rawVal || '').trim();
  if (!val) return '';
  if (key === 'whatsapp') {
    if (val.startsWith('http://') || val.startsWith('https://')) return val;
    const digits = val.replace(/[^0-9]/g, '');
    if (digits) return `https://wa.me/${digits}`;
    return '';
  }
  if (!val.startsWith('http://') && !val.startsWith('https://')) {
    return `https://${val}`;
  }
  return val;
}

function renderFooterSocialLinks(data: any) {
  const container = document.getElementById('footer-social-links-container');
  const contactContainer = document.getElementById('contact-page-social-links');

  const platforms = [
    {
      key: 'instagram',
      label: 'Instagram',
      color: 'hover:bg-[#E1306C]',
      svg: `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>`
    },
    {
      key: 'facebook',
      label: 'Facebook',
      color: 'hover:bg-[#1877F2]',
      svg: `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`
    },
    {
      key: 'youtube',
      label: 'YouTube',
      color: 'hover:bg-[#FF0000]',
      svg: `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`
    },
    {
      key: 'twitter',
      label: 'Twitter / X',
      color: 'hover:bg-slate-950',
      svg: `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`
    },
    {
      key: 'linkedin',
      label: 'LinkedIn',
      color: 'hover:bg-[#0A66C2]',
      svg: `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"/></svg>`
    },
    {
      key: 'whatsapp',
      label: 'WhatsApp',
      color: 'hover:bg-[#25D366]',
      svg: `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.572-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>`
    },
    {
      key: 'telegram',
      label: 'Telegram',
      color: 'hover:bg-[#229ED9]',
      svg: `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`
    },
    {
      key: 'discord',
      label: 'Discord',
      color: 'hover:bg-[#5865F2]',
      svg: `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`
    },
    {
      key: 'github',
      label: 'GitHub',
      color: 'hover:bg-[#333333]',
      svg: `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>`
    },
    {
      key: 'pinterest',
      label: 'Pinterest',
      color: 'hover:bg-[#E60023]',
      svg: `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M12 0C5.373 0 0 5.372 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738.098.119.112.224.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.631-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12 0-6.628-5.373-12-12-12z"/></svg>`
    }
  ];

  let html = '';
  platforms.forEach(p => {
    const rawVal = data ? data[p.key] : null;
    if (isValidSocialLink(rawVal)) {
      const url = formatSocialUrl(p.key, rawVal);
      if (url) {
        html += `
          <a href="${url}" target="_blank" rel="noopener noreferrer" 
             class="p-2 bg-slate-800 ${p.color} hover:text-white rounded-xl text-slate-400 transition flex items-center justify-center shadow-xs" 
             aria-label="${p.label}" title="${p.label}">
            ${p.svg}
          </a>
        `;
      }
    }
  });

  if (container) container.innerHTML = html;
  if (contactContainer) contactContainer.innerHTML = html;
}

// Live listener for AI Tools collection
function loadAIToolsListener() {
  const toolsRef = collection(db, 'aiTools');
  onSnapshot(toolsRef, (snap) => {
    const badgesContainer = document.getElementById('hero-floating-badges');
    const exploreGrid = document.getElementById('explore-tools-grid');
    const sidebarContainer = document.getElementById('sidebar-popular-tools');

    let toolsList: any[] = [];
    if (snap.empty) {
      if (badgesContainer) badgesContainer.innerHTML = '';
      if (exploreGrid) exploreGrid.innerHTML = `<div class="col-span-full py-8 text-center text-slate-400 text-xs">No AI tools available.</div>`;
      if (sidebarContainer) sidebarContainer.innerHTML = `<div class="py-4 text-center text-slate-400 text-xs">No AI tools available.</div>`;
      return;
    }

    toolsList = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).sort((a: any, b: any) => (a.order || 99) - (b.order || 99));

    // Render 1: Floating badges (Official logos only, keeping floating animation)
    if (badgesContainer) {
      const floatingClasses = [
        "absolute -top-12 -left-8 z-20 animate-float-slow px-2.5 py-2.5 rounded-full glass-badge shadow-md hover:scale-110 transition cursor-pointer flex items-center justify-center border border-emerald-300/80 bg-emerald-50/90",
        "absolute -top-10 -right-8 z-20 animate-float-delayed px-2.5 py-2.5 rounded-full glass-badge shadow-md hover:scale-110 transition cursor-pointer flex items-center justify-center border border-blue-300/80 bg-blue-50/90",
        "hidden md:flex absolute top-20 -left-14 z-20 animate-float-reverse px-2.5 py-2.5 rounded-full glass-badge shadow-md hover:scale-110 transition cursor-pointer items-center justify-center border border-purple-300/80 bg-purple-50/90",
        "hidden md:flex absolute top-20 -right-14 z-20 animate-float-slow px-2.5 py-2.5 rounded-full glass-badge shadow-md hover:scale-110 transition cursor-pointer items-center justify-center border border-amber-300/80 bg-amber-50/90",
        "hidden lg:flex absolute top-48 -left-16 z-20 animate-float-delayed px-2.5 py-2.5 rounded-full glass-badge shadow-md hover:scale-110 transition cursor-pointer items-center justify-center border border-indigo-300/80 bg-indigo-50/90",
        "hidden lg:flex absolute top-48 -right-16 z-20 animate-float-reverse px-2.5 py-2.5 rounded-full glass-badge shadow-md hover:scale-110 transition cursor-pointer items-center justify-center border border-rose-300/80 bg-rose-50/90",
        "hidden xl:flex absolute -bottom-10 -left-10 z-20 animate-float-pulse px-2.5 py-2.5 rounded-full glass-badge shadow-md hover:scale-110 transition cursor-pointer items-center justify-center border border-pink-300/80 bg-pink-50/90",
        "hidden xl:flex absolute -bottom-10 -right-10 z-20 animate-float-slow px-2.5 py-2.5 rounded-full glass-badge shadow-md hover:scale-110 transition cursor-pointer items-center justify-center border border-orange-300/80 bg-orange-50/90"
      ];
      badgesContainer.innerHTML = toolsList.slice(0, 8).map((t, idx) => `
        <div onclick="quickSearch('${t.name}')" class="${floatingClasses[idx] || floatingClasses[0]}" title="${t.name}">
          ${t.logoUrl ? `<img src="${t.logoUrl}" class="w-5 h-5 object-contain" />` : `<i data-lucide="${t.icon || 'cpu'}" class="w-5 h-5 ${t.color || 'text-blue-600'}"></i>`}
        </div>
      `).join('');
    }

    // Render 2: Explore by AI tool grid
    if (exploreGrid) {
      exploreGrid.innerHTML = toolsList.map(t => `
        <div onclick="filterByTool('${t.name}')" class="bg-white p-3.5 rounded-2xl border border-slate-200/90 shadow-card hover:shadow-card-hover transition cursor-pointer text-center group">
          <div class="w-10 h-10 rounded-xl bg-slate-50 ${t.color || 'text-blue-600'} font-extrabold flex items-center justify-center mx-auto mb-2 group-hover:scale-110 transition">
            <i data-lucide="${t.icon || 'cpu'}" class="w-5 h-5 mx-auto"></i>
          </div>
          <div class="font-bold text-xs text-slate-900">${t.name}</div>
          <div class="text-[10px] text-slate-500 font-medium">${t.count || '0 Prompts'}</div>
        </div>
      `).join('');
    }

    // Render 3: Sidebar Popular AI Tools widget
    if (sidebarContainer) {
      sidebarContainer.innerHTML = toolsList.slice(0, 5).map(t => `
        <div onclick="quickSearch('${t.name}')" class="flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 cursor-pointer transition">
          <div class="flex items-center gap-2.5">
            <i data-lucide="${t.icon || 'cpu'}" class="w-4 h-4 ${t.color || 'text-blue-600'}"></i>
            <span class="text-xs font-bold text-slate-800">${t.name}</span>
          </div>
          <span class="text-[10px] font-semibold text-slate-400">${t.count || '0 Prompts'}</span>
        </div>
      `).join('');
    }

    // Render 4: Form & Search Filter Select Dropdowns
    const formToolSelect = document.getElementById('form-tool') as HTMLSelectElement;
    const searchToolSelect = document.getElementById('search-tool-select') as HTMLSelectElement;
    const toolFilterSelect = document.getElementById('tool-filter-select') as HTMLSelectElement;
    const pfToolSelect = document.getElementById('pf-tool') as HTMLSelectElement;

    const toolOptionsHtml = toolsList.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
    if (formToolSelect && toolsList.length > 0) formToolSelect.innerHTML = toolOptionsHtml;
    if (pfToolSelect && toolsList.length > 0) pfToolSelect.innerHTML = toolOptionsHtml;
    if (searchToolSelect && toolsList.length > 0) searchToolSelect.innerHTML = `<option value="all">All AI Tools</option>` + toolOptionsHtml;
    if (toolFilterSelect && toolsList.length > 0) toolFilterSelect.innerHTML = `<option value="all">All AI Tools</option>` + toolOptionsHtml;

    if (typeof lucide !== 'undefined') lucide.createIcons();
  }, (err) => {
    handleFirestoreError(err, OperationType.LIST, 'aiTools');
  });
}

// =============================================================================
// INITIALIZATION
// =============================================================================

window.addEventListener('DOMContentLoaded', () => {
  // Show loading skeletons while Firestore data fetches
  renderLoadingSkeleton(document.getElementById('prompts-grid'), 12);
  renderTrendingSkeletons(document.getElementById('trending-prompts-container'), 5);

  testConnection();
  setupAuthListener();

  // Load configs & tools from Firestore
  loadSiteConfigs();
  loadAIToolsListener();

  // Load data from Firestore (efficient, paginated)
  loadInitialPrompts();
  loadCategoriesListener();
  loadTrendingPrompts();

  initTypewriter();
  handleHashRouting();
  injectThirdPartyScripts();

  // Initialize production-grade monetization system (AdSense + Sponsored Ads)
  initAdsSystem().catch(err => console.warn('Monetization init notice:', err));

  // Ambient cursor glow
  document.addEventListener('mousemove', (e) => {
    const glow = document.getElementById('cursor-glow');
    if (glow) {
      glow.style.transform = `translate(${e.clientX - 120}px, ${e.clientY - 120}px)`;
    }
  });

  attachWindowGlobalFunctions();
});

// =============================================================================
// AUTH LISTENER
// =============================================================================

function setupAuthListener() {
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    isAuthLoading = false;

    if (user) {
      try {
        await syncUserDoc(user);
        currentUserRole = await getUserRole(user);
        listenToUserBookmarks(user.uid);
        listenToUserLikes(user.uid);
      } catch (e) {
        console.warn('Auth sync notice:', e);
      }
    } else {
      currentUserRole = 'user';
      bookmarks = [];
      userLikes = [];
      if (unsubscribeBookmarks) {
        unsubscribeBookmarks();
        unsubscribeBookmarks = null;
      }
      if (unsubscribeLikes) {
        unsubscribeLikes();
        unsubscribeLikes = null;
      }
    }

    renderAuthUI();
    renderAll(); // Re-render from cache with updated auth/bookmark state
  });
}

// =============================================================================
// FIRESTORE DATA LOADING — PAGINATED, EFFICIENT
// =============================================================================

/**
 * Load the first page of approved prompts from Firestore.
 * Uses compound queries with orderBy for server-side sorting.
 * Falls back to simple approved query if composite index missing.
 */
function loadInitialPrompts() {
  isInitialLoading = true;
  lastVisibleDoc = null;
  hasMorePrompts = true;
  currentToolFilter = 'all';

  if (unsubscribeInitialPrompts) {
    unsubscribeInitialPrompts();
    unsubscribeInitialPrompts = null;
  }

  renderLoadingSkeleton(document.getElementById('prompts-grid'), 12);

  const q = query(
    collection(db, 'prompts'),
    where('status', '==', 'approved'),
    limit(100)
  );

  unsubscribeInitialPrompts = onSnapshot(q, (snapshot) => {
    isInitialLoading = false;
    if (snapshot.empty) {
      prompts = [];
      renderEmptyState(document.getElementById('prompts-grid'), 'No prompts found in the database', 'Be the first to share a premium AI prompt!');
      renderTrendingPromptsFromCache();
      renderHeroVisualPanels([]);
      renderLiveAITrendsTicker([]);
      return;
    }

    prompts = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem));
    lastVisibleDoc = snapshot.docs[snapshot.docs.length - 1] ?? null;
    hasMorePrompts = false;

    updateLoadMoreButton();
    renderGalleryFromCache();
    renderTrendingPromptsFromCache();
    renderHeroVisualPanels(prompts);
    renderLiveAITrendsTicker(prompts);
  }, (err) => {
    console.warn('Initial prompts listener notice, falling back:', err);
    getDocs(query(collection(db, 'prompts'), limit(100))).then(fallbackSnap => {
      isInitialLoading = false;
      if (fallbackSnap.empty) {
        prompts = [];
        renderEmptyState(document.getElementById('prompts-grid'), 'No prompts found in the database', 'Be the first to share a premium AI prompt!');
        return;
      }
      prompts = fallbackSnap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem))
        .filter(p => p.status === 'approved' || currentUserRole === 'admin');
      lastVisibleDoc = fallbackSnap.docs[fallbackSnap.docs.length - 1] ?? null;
      hasMorePrompts = false;
      updateLoadMoreButton();
      renderGalleryFromCache();
      renderTrendingPromptsFromCache();
      renderHeroVisualPanels(prompts);
      renderLiveAITrendsTicker(prompts);
    }).catch(fallbackErr => {
      console.warn('Fallback query failed:', fallbackErr);
      isInitialLoading = false;
    });
  });
}

// Categories: real-time listener (small collection, always current)
function loadCategoriesListener() {
  const categoriesRef = collection(db, 'categories');
  onSnapshot(categoriesRef, async (snapshot) => {
    if (snapshot.empty) return;

    const loaded = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as CategoryItem[];
    if (loaded.length > 0) categories = loaded;

    renderCategoryPills();
    populateFormCategoryOptions();
  }, (err) => {
    console.warn('Categories snapshot notice:', err);
  });
}

// Dedicated Firestore query for trending section (not the full gallery)
function loadTrendingPrompts() {
  const container = document.getElementById('trending-prompts-container');
  renderTrendingSkeletons(container, 5);

  if (unsubscribeTrendingPrompts) {
    unsubscribeTrendingPrompts();
    unsubscribeTrendingPrompts = null;
  }

  const q = query(
    collection(db, 'prompts'),
    where('status', '==', 'approved'),
    where('trending', '==', true),
    limit(10)
  );

  unsubscribeTrendingPrompts = onSnapshot(q, (snapshot) => {
    if (snapshot.empty) {
      renderTrendingPromptsFromCache();
      return;
    }

    const trendingList = snapshot.docs
      .map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem))
      .map(p => ({ ...p, _score: computeRankScore(p, '') }))
      .sort((a, b) => (b._score ?? 0) - (a._score ?? 0))
      .slice(0, 5);

    renderTrendingPromptsUI(trendingList);
  }, (err) => {
    console.warn('Trending listener error, falling back to cache:', err);
    renderTrendingPromptsFromCache();
  });
}

function renderTrendingPromptsFromCache() {
  let trendingList = [...prompts]
    .filter(p => p.trending && (p.status === 'approved' || currentUserRole === 'admin'))
    .map(p => ({ ...p, _score: computeRankScore(p, '') }))
    .sort((a, b) => (b._score ?? 0) - (a._score ?? 0))
    .slice(0, 5);

  // Fallback: if no flagged-trending prompts, use top ranked
  if (trendingList.length === 0) {
    trendingList = [...prompts]
      .filter(p => p.status === 'approved' || currentUserRole === 'admin')
      .map(p => ({ ...p, _score: computeRankScore(p, '') }))
      .sort((a, b) => (b._score ?? 0) - (a._score ?? 0))
      .slice(0, 5);
  }

  renderTrendingPromptsUI(trendingList);
}

function renderTrendingPromptsUI(trendingList: PromptItem[]) {
  const container = document.getElementById('trending-prompts-container');
  if (!container) return;

  if (trendingList.length === 0) {
    container.innerHTML = `
      <div class="col-span-full text-center py-8 text-slate-400 text-xs font-medium">
        No trending prompts yet — check back soon!
      </div>`;
    return;
  }

  container.innerHTML = trendingList.map(p => `
    <div class="bg-white rounded-2xl border border-slate-200/80 shadow-card hover:shadow-card-hover transition duration-300 overflow-hidden group cursor-pointer flex flex-col justify-between" onclick="openPromptDetail('${p.id}')">
      <div>
        <div class="relative w-full h-52 sm:h-56 overflow-hidden bg-[#f4f7f5] border-b border-[#dde8df] group/img">
          <img src="${optimizeImageUrl(p.image)}" alt="${p.title}" 
               class="w-full h-full object-cover object-center block group-hover/img:scale-105 transition-transform duration-500 opacity-0" 
               loading="lazy" 
               onload="this.classList.remove('opacity-0');"
               onerror="this.src='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=600&q=80'; this.classList.remove('opacity-0');" />
          <span class="absolute top-2 left-2 z-20 px-2.5 py-0.5 rounded-md bg-white/90 backdrop-blur-md text-slate-900 font-bold text-[10px] shadow-sm">
            ${p.tool}
          </span>
          ${p.trending ? `<span class="absolute top-2 right-2 z-20 px-2.5 py-0.5 rounded-md bg-orange-500/90 text-white font-bold text-[10px] backdrop-blur-sm">🔥 Hot</span>` : ''}
        </div>
        <div class="p-3 space-y-1">
          <h4 class="font-bold text-xs text-slate-900 line-clamp-1 group-hover:text-blue-600 transition">${p.title}</h4>
        </div>
      </div>
      <div class="p-3 pt-0">
        <div class="flex items-center justify-between text-[11px] text-slate-500 font-medium pt-1.5 border-t border-slate-100">
          <span class="flex items-center gap-1"><i data-lucide="eye" class="w-3 h-3 text-blue-400"></i> ${formatNumber(p.views)}</span>
          <span class="flex items-center gap-1 text-rose-500"><i data-lucide="heart" class="w-3 h-3"></i> ${formatNumber(p.likes)}</span>
        </div>
      </div>
    </div>
  `).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// GALLERY RENDERING — CACHE-BASED, RANKED
// GALLERY RENDERING — CACHE-BASED, RANKED
// =============================================================================

function renderGalleryFromCache() {
  const grid = document.getElementById('prompts-grid');
  if (!grid) return;

  let pool = [...prompts];

  // Apply active tool filter
  if (currentToolFilter !== 'all') {
    pool = pool.filter(p => p.tool === currentToolFilter);
  }

  // Apply canonical ranking
  const scored = pool
    .map(p => ({ ...p, _score: computeRankScore(p, '') }))
    .sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

  if (scored.length === 0) {
    renderEmptyState(
      grid,
      currentToolFilter !== 'all' ? `No ${currentToolFilter} prompts in this page` : 'No prompts found yet',
      currentToolFilter !== 'all' ? 'Switch "All AI Tools" to see all prompts, or load more below' : 'Be the first to submit a prompt!'
    );
    return;
  }

  grid.innerHTML = scored.map(p => createPromptCardHTML(p)).join('');
  
  // Inject sponsored ads & AdSense feed units
  injectFeedAds('prompts-grid', 8);
  // Re-run observer to bind the newly injected ad elements
  setupAdObservers();
  
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updateLoadMoreButton() {
  const btn = document.getElementById('load-more-btn');
  if (!btn) return;
  // Hide if no more pages OR tool filter is active (pagination resets on filter change)
  if (!hasMorePrompts || currentToolFilter !== 'all') {
    btn.classList.add('hidden');
  } else {
    btn.classList.remove('hidden');
    btn.innerHTML = 'Load More Prompts';
  }
}

// =============================================================================
// LOAD MORE — CURSOR-BASED FIRESTORE PAGINATION
// =============================================================================

async function loadMorePrompts() {
  if (!hasMorePrompts || isLoadingMore) return;
  if (!lastVisibleDoc) {
    showToast('All prompts already loaded');
    return;
  }
  if (currentToolFilter !== 'all') return; // Tool filter disables pagination

  isLoadingMore = true;
  const btn = document.getElementById('load-more-btn');
  if (btn) {
    btn.innerHTML = `<span class="flex items-center gap-2 justify-center">
    <i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Loading...</span>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  try {
    let q;
    if (currentSortType === 'newest') {
      q = query(collection(db, 'prompts'), where('status', '==', 'approved'), orderBy('createdAt', 'desc'), startAfter(lastVisibleDoc), limit(LOAD_MORE_LIMIT));
    } else if (currentSortType === 'likes') {
      q = query(collection(db, 'prompts'), where('status', '==', 'approved'), orderBy('likes', 'desc'), startAfter(lastVisibleDoc), limit(LOAD_MORE_LIMIT));
    } else if (currentSortType === 'trending') {
      q = query(collection(db, 'prompts'), where('status', '==', 'approved'), where('trending', '==', true), orderBy('likes', 'desc'), startAfter(lastVisibleDoc), limit(LOAD_MORE_LIMIT));
    } else {
      q = query(collection(db, 'prompts'), where('status', '==', 'approved'), orderBy('views', 'desc'), startAfter(lastVisibleDoc), limit(LOAD_MORE_LIMIT));
    }

    const snapshot = await getDocs(q);
    const newPrompts = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem));

    if (newPrompts.length > 0) {
      const existingIds = new Set(prompts.map(p => p.id));
      const unique = newPrompts.filter(p => !existingIds.has(p.id));
      prompts = [...prompts, ...unique];
      lastVisibleDoc = snapshot.docs[snapshot.docs.length - 1] ?? lastVisibleDoc;
    }

    hasMorePrompts = snapshot.docs.length === LOAD_MORE_LIMIT;
    updateLoadMoreButton();
    renderGalleryFromCache();

    showToast(newPrompts.length > 0 ? `Loaded ${newPrompts.length} more prompts!` : 'All prompts loaded!');

  } catch (err: any) {
    console.warn('Load more failed:', err.message);
    showToast('Could not load more. Please try again.');
    if (btn) btn.innerHTML = 'Load More Prompts';
  } finally {
    isLoadingMore = false;
  }
}

// =============================================================================
// BOOKMARKS LISTENER
// =============================================================================

function listenToUserBookmarks(userId: string) {
  if (unsubscribeBookmarks) unsubscribeBookmarks();
  const bookmarksRef = collection(db, 'users', userId, 'bookmarks');
  unsubscribeBookmarks = onSnapshot(bookmarksRef, (snapshot) => {
    bookmarks = snapshot.docs.map(d => d.id);
    renderAll();
  }, (err) => {
    console.warn(`Bookmarks listener notice for user ${userId}:`, err);
  });
}

function listenToUserLikes(userId: string) {
  if (unsubscribeLikes) unsubscribeLikes();
  const likesRef = collection(db, 'users', userId, 'likes');
  unsubscribeLikes = onSnapshot(likesRef, (snapshot) => {
    userLikes = snapshot.docs.map(d => d.id);
    renderAll();
  }, (err) => {
    console.warn(`Likes listener notice for user ${userId}:`, err);
  });
}

// =============================================================================
// AUTH UI
// =============================================================================

function formatUserDisplayName(user: { displayName?: string | null; email?: string | null }): string {
  if (user.displayName && user.displayName.trim() && !user.displayName.includes('@')) {
    return user.displayName.trim();
  }
  const prefix = user.email ? user.email.split('@')[0] : 'Creator';
  const withoutDigits = prefix.replace(/\d+$/, '');
  const base = withoutDigits.length >= 3 ? withoutDigits : prefix;
  return base.replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function toggleUserDropdownMenu() {
  const dd = document.getElementById('user-nav-dropdown');
  if (dd) dd.classList.toggle('hidden');
}

function closeUserDropdownMenu() {
  const dd = document.getElementById('user-nav-dropdown');
  if (dd) dd.classList.add('hidden');
}

// Close user dropdown when clicking outside
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const parent = document.getElementById('user-menu-dropdown-parent');
    if (parent && !parent.contains(e.target as Node)) {
      closeUserDropdownMenu();
    }
  });
}

function renderAuthUI() {
  const authContainer = document.getElementById('navbar-auth-section');
  const mobileAuth = document.getElementById('mobile-auth-section');

  if (currentUser) {
    const name = formatUserDisplayName(currentUser);
    const avatarLetter = name.charAt(0).toUpperCase();
    const photoURL = currentUser.photoURL;

    if (authContainer) {
      authContainer.innerHTML = `
        <div class="relative flex items-center gap-2">
          <button onclick="openAddPromptModal()" class="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white text-xs font-bold rounded-xl shadow-sm transition">
            <i data-lucide="plus" class="w-3.5 h-3.5"></i> Submit Prompt
          </button>

          <div class="relative" id="user-menu-dropdown-parent">
            <button onclick="toggleUserDropdownMenu()" id="user-menu-toggle-btn" class="flex items-center gap-2 px-2.5 py-1.5 bg-white hover:bg-slate-50 border border-slate-200/90 rounded-xl shadow-sm text-xs font-bold text-slate-800 transition">
              ${photoURL 
                ? `<img src="${photoURL}" class="w-6 h-6 rounded-full object-cover border border-slate-200 shrink-0" alt="${name}" onerror="this.outerHTML='<div class=\\'w-6 h-6 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white flex items-center justify-center text-[10px] font-extrabold shrink-0\\'>${avatarLetter}</div>'" />` 
                : `<div class="w-6 h-6 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white flex items-center justify-center text-[10px] font-extrabold shrink-0 shadow-sm">${avatarLetter}</div>`
              }
              <span class="max-w-[90px] sm:max-w-[120px] truncate text-slate-900 font-bold">${name}</span>
              <i data-lucide="chevron-down" class="w-3.5 h-3.5 text-slate-400"></i>
            </button>

            <!-- Dropdown popup -->
            <div id="user-nav-dropdown" class="hidden absolute right-0 mt-2 w-56 bg-white rounded-2xl shadow-2xl border border-slate-200/90 py-2 z-50">
              <div class="px-3.5 py-2.5 border-b border-slate-100 flex items-center gap-2.5">
                <div class="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-extrabold text-xs flex items-center justify-center shadow-sm shrink-0">
                  ${avatarLetter}
                </div>
                <div class="min-w-0">
                  <p class="text-xs font-bold text-slate-900 truncate">${name}</p>
                  <p class="text-[10px] text-slate-400 font-medium truncate">${currentUser.email || 'Verified Creator'}</p>
                </div>
              </div>

              <div class="p-1 space-y-0.5 text-xs font-semibold">
                <button onclick="navigateTo('dashboard'); closeUserDropdownMenu()" class="w-full text-left px-3 py-2 rounded-xl text-slate-700 hover:bg-slate-50 flex items-center gap-2 transition">
                  <i data-lucide="layout-dashboard" class="w-4 h-4 text-blue-600"></i> Creator Workspace
                </button>
                <button onclick="openAddPromptModal(); closeUserDropdownMenu()" class="w-full text-left px-3 py-2 rounded-xl text-slate-700 hover:bg-slate-50 flex items-center gap-2 transition">
                  <i data-lucide="plus-circle" class="w-4 h-4 text-emerald-600"></i> Submit New Prompt
                </button>
              </div>

              <div class="p-1 pt-1.5 border-t border-slate-100">
                <button onclick="handleUserLogout(); closeUserDropdownMenu()" class="w-full text-left px-3 py-2 rounded-xl text-rose-600 hover:bg-rose-50 text-xs font-semibold flex items-center gap-2 transition">
                  <i data-lucide="log-out" class="w-4 h-4 text-rose-500"></i> Sign Out
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    if (mobileAuth) {
      mobileAuth.innerHTML = `
        <div class="p-3 bg-slate-50 rounded-2xl border border-slate-200/80 space-y-3">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-extrabold text-xs flex items-center justify-center shadow-sm shrink-0">
              ${avatarLetter}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="text-xs font-bold text-slate-900 truncate">${name}</span>
              </div>
              <p class="text-[10px] text-slate-400 font-medium truncate">${currentUser.email || 'Verified Creator'}</p>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2 text-xs font-bold">
            <button onclick="navigateTo('dashboard'); toggleMobileMenu()" class="px-3 py-2 bg-white border border-slate-200 rounded-xl text-slate-700 hover:bg-blue-50 hover:text-blue-600 flex items-center justify-center gap-1.5 transition">
              <i data-lucide="layout-dashboard" class="w-3.5 h-3.5"></i> Dashboard
            </button>
            <button onclick="openAddPromptModal(); toggleMobileMenu()" class="px-3 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 flex items-center justify-center gap-1.5 transition">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i> Submit
            </button>
          </div>
          <button onclick="handleUserLogout(); toggleMobileMenu()" class="w-full py-2 text-rose-600 hover:bg-rose-50 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition border border-rose-100">
            <i data-lucide="log-out" class="w-3.5 h-3.5"></i> Sign Out
          </button>
        </div>
      `;
    }
  } else {
    if (authContainer) {
      authContainer.innerHTML = `
        <div class="flex items-center gap-2">
          <button onclick="openAuthModal('login')" class="px-3.5 py-1.5 text-xs font-bold text-slate-700 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition">
            Sign In
          </button>
          <button onclick="openAuthModal('signup')" class="px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-extrabold text-xs rounded-xl shadow-md transition flex items-center gap-1.5 btn-shimmer">
            <i data-lucide="user" class="w-3.5 h-3.5"></i> Join Free
          </button>
        </div>
      `;
    }
    if (mobileAuth) {
      mobileAuth.innerHTML = `
        <div class="flex items-center gap-2 pt-2">
          <button onclick="openAuthModal('login'); toggleMobileMenu()" class="flex-1 py-2 text-center text-xs font-bold text-slate-700 bg-slate-100 rounded-xl">
            Sign In
          </button>
          <button onclick="openAuthModal('signup'); toggleMobileMenu()" class="flex-1 py-2 text-center text-xs font-bold text-white bg-blue-600 rounded-xl">
            Join Free
          </button>
        </div>
      `;
    }
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// ROUTING & NAVIGATION
// =============================================================================

let previousView = 'home';

window.addEventListener('hashchange', handleHashRouting);
window.addEventListener('popstate', handleHashRouting);

function handleHashRouting() {
  const hash = window.location.hash;
  if (hash.startsWith('#prompt/')) {
    const promptId = hash.replace('#prompt/', '');
    openPromptDetail(promptId, false);
  } else if (hash === '#details') {
    if (!currentSelectedPrompt) {
      navigateTo('home');
    }
  } else if (hash === '#search') {
    navigateTo('search');
  } else if (hash === '#collections') {
    navigateTo('collections');
  } else if (hash === '#blog') {
    navigateTo('blog');
  } else if (hash === '#docs') {
    navigateTo('docs');
  } else if (hash === '#about') {
    navigateTo('about');
  } else if (hash === '#privacy') {
    navigateTo('privacy');
  } else if (hash === '#terms') {
    navigateTo('terms');
  } else if (hash === '#cookies') {
    navigateTo('cookies');
  } else if (hash === '#contact') {
    navigateTo('contact');
  } else if (hash === '#dashboard') {
    navigateTo('dashboard');
  } else if (hash === '#home' || hash === '' || !hash) {
    navigateTo('home');
  }
}

function goBackFromPrompt() {
  if (window.history.length > 1 && window.location.hash.startsWith('#prompt/')) {
    window.history.back();
    setTimeout(() => {
      if (activeView === 'details') {
        navigateTo(previousView || 'home');
      }
    }, 150);
  } else {
    navigateTo(previousView || 'home');
  }
}

function shareOnWhatsApp() {
  if (!currentSelectedPrompt) return;
  const promptUrl = `${window.location.origin}/#prompt/${currentSelectedPrompt.id}`;
  const text = encodeURIComponent(`Check out this AI Prompt: "${currentSelectedPrompt.title}"\n${promptUrl}`);
  window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
}

function navigateTo(viewName: string) {
  if (activeView !== 'details' && activeView !== viewName) {
    previousView = activeView;
  }
  activeView = viewName;
  document.querySelectorAll('.view-panel').forEach(el => el.classList.add('hidden'));
  const targetView = document.getElementById(`view-${viewName}`);
  if (targetView) targetView.classList.remove('hidden');

  const stickyBar = document.getElementById('mobile-prompt-sticky-bar');
  if (stickyBar) {
    if (viewName === 'details') stickyBar.classList.remove('hidden');
    else stickyBar.classList.add('hidden');
  }

  // Update hash dynamically for deep link/refresh routing without infinite back loops
  if (viewName === 'details') {
    // Preserve existing #prompt/{id} hash! DO NOT overwrite with #details!
    if (!window.location.hash.startsWith('#prompt/') && currentSelectedPrompt) {
      window.location.hash = `#prompt/${currentSelectedPrompt.id}`;
    }
  } else if (viewName === 'home') {
    if (window.location.hash && window.location.hash !== '#home') {
      window.history.pushState(null, '', window.location.pathname + window.location.search);
    }
  } else {
    if (window.location.hash !== `#${viewName}`) {
      window.location.hash = `#${viewName}`;
    }
  }

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.remove('bg-blue-50', 'text-blue-600', 'font-semibold', 'bg-[#e8f5ec]', 'text-[#2d8a45]');
    btn.classList.add('text-slate-600');
  });
  const activeNavBtn = document.getElementById(`nav-${viewName}`);
  if (activeNavBtn) {
    activeNavBtn.classList.remove('text-slate-600');
    activeNavBtn.classList.add('bg-[#e8f5ec]', 'text-[#2d8a45]', 'font-semibold');
  }

  // Set proper SEO title for pages
  const titles: Record<string, string> = {
    home: 'PromptsOne — Google for AI Prompts & Engineering Portal',
    search: 'Search Premium AI Prompts | PromptsOne',
    collections: 'Curated Prompt Collections | PromptsOne',
    blog: 'Blog & Prompting Guides | PromptsOne',
    docs: 'Help Center & Documentation | PromptsOne',
    about: 'About Us | PromptsOne',
    privacy: 'Privacy Policy | PromptsOne',
    terms: 'Terms of Service | PromptsOne',
    cookies: 'Cookie Policy | PromptsOne',
    contact: 'Contact & Support Desk | PromptsOne'
  };
  if (titles[viewName]) {
    document.title = titles[viewName];
  }

  // Sync canonical and og tags
  const canonicalEl = document.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
  const canonicalBase = 'https://promptsone.com/';
  if (canonicalEl) {
    canonicalEl.href = viewName === 'home' ? canonicalBase : `${canonicalBase}#${viewName}`;
  }
  const ogUrl = document.querySelector("meta[property='og:url']");
  if (ogUrl) {
    ogUrl.setAttribute('content', viewName === 'home' ? canonicalBase : `${canonicalBase}#${viewName}`);
  }
  const ogTitle = document.querySelector("meta[property='og:title']");
  if (ogTitle && titles[viewName]) {
    ogTitle.setAttribute('content', titles[viewName]);
  }

  // Trigger dynamic data loaders
  if (viewName === 'dashboard') {
    loadUserPrompts();
  } else if (viewName === 'blog') {
    loadBlogs();
  } else if (viewName === 'docs' || ['about', 'privacy', 'terms', 'cookies'].includes(viewName)) {
    loadDocs();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// =============================================================================
// USER WORKSPACE: SUBMISSIONS & DRAFTS
// =============================================================================

let userPrompts: any[] = [];

async function loadUserPrompts() {
  if (!currentUser) {
    navigateTo('home');
    openAuthModal('login');
    return;
  }
  const tbody = document.getElementById('user-prompts-tbody');
  if (!tbody) return;
  try {
    const q = query(collection(db, 'prompts'), where('creatorId', '==', currentUser.uid));
    const snap = await getDocs(q);
    userPrompts = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
    
    const countEl = document.getElementById('user-prompt-count');
    if (countEl) countEl.textContent = `${userPrompts.length} prompts`;
    
    if (userPrompts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400">You haven't submitted any prompts yet. Submit one above!</td></tr>`;
      return;
    }
    
    tbody.innerHTML = userPrompts.map(p => {
      const statusColors = {
        approved: 'bg-emerald-50 text-emerald-600 border-emerald-100',
        pending: 'bg-amber-50 text-amber-600 border-amber-100',
        draft: 'bg-slate-50 text-slate-600 border-slate-100',
        rejected: 'bg-rose-50 text-rose-600 border-rose-100'
      };
      const statusClass = statusColors[p.status as keyof typeof statusColors] || 'bg-slate-50 text-slate-600 border-slate-100';
      return `
        <tr class="border-b border-slate-100 hover:bg-slate-50/50">
          <td class="p-3">
            <div class="flex items-center gap-2">
              <img src="${p.image}" class="w-8 h-8 rounded-lg object-cover border" width="32" height="32" />
              <span class="font-bold text-slate-900">${p.title}</span>
            </div>
          </td>
          <td class="p-3 font-semibold text-slate-600">${p.tool}</td>
          <td class="p-3 text-slate-500">${p.category}</td>
          <td class="p-3">
            <span class="px-2 py-0.5 border text-[10px] font-extrabold rounded-full ${statusClass}">${p.status || 'pending'}</span>
          </td>
          <td class="p-3 text-slate-400 font-semibold">${p.views || 0} views / ${p.likes || 0} likes</td>
          <td class="p-3 text-right space-x-1">
            <button onclick="editUserPrompt('${p.id}')" class="p-1 text-blue-600 hover:bg-blue-50 rounded" title="Edit Prompt"><i data-lucide="edit-3" class="w-4 h-4 inline"></i></button>
            <button onclick="deleteUserPromptConfirm('${p.id}')" class="p-1 text-rose-600 hover:bg-rose-50 rounded" title="Delete Prompt"><i data-lucide="trash-2" class="w-4 h-4 inline"></i></button>
          </td>
        </tr>
      `;
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-rose-500">Failed to load submissions.</td></tr>`;
  }
}

let userFormImages: string[] = [];

function renderUserFormImages() {
  const grid = document.getElementById('form-images-preview-grid');
  const counter = document.getElementById('form-images-counter');
  if (counter) {
    counter.textContent = `${userFormImages.length} image${userFormImages.length !== 1 ? 's' : ''} added`;
  }
  if (!grid) return;
  if (userFormImages.length === 0) {
    grid.innerHTML = '';
    grid.classList.add('hidden');
    return;
  }
  grid.classList.remove('hidden');
  grid.innerHTML = userFormImages.map((img, idx) => `
    <div class="relative group rounded-xl overflow-hidden border border-slate-200 bg-slate-900 aspect-square flex items-center justify-center p-1">
      <img src="${img}" alt="Preview ${idx + 1}" class="max-w-full max-h-full object-contain" />
      <button type="button" onclick="removeUserFormImage(${idx})" class="absolute top-1 right-1 w-5 h-5 rounded-full bg-rose-600 hover:bg-rose-700 text-white flex items-center justify-center text-[10px] shadow transition" title="Remove image">
        <i data-lucide="x" class="w-3 h-3"></i>
      </button>
      ${idx === 0 ? `<span class="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-blue-600 text-white text-[9px] font-bold">Cover</span>` : ''}
    </div>
  `).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function removeUserFormImage(idx: number) {
  if (idx >= 0 && idx < userFormImages.length) {
    userFormImages.splice(idx, 1);
    renderUserFormImages();
  }
}

function addUserImageUrl() {
  const urlInput = document.getElementById('form-image-url') as HTMLInputElement;
  const url = urlInput ? urlInput.value.trim() : '';
  if (!url) {
    showToast('Please enter an image URL first');
    return;
  }
  userFormImages.push(url);
  urlInput.value = '';
  renderUserFormImages();
  showToast('Image URL added!');
}

async function handleUserMultiImageUpload(input: HTMLInputElement) {
  if (!input.files || input.files.length === 0) return;
  const files = Array.from(input.files);
  const btn = document.getElementById('user-upload-img-btn') as HTMLButtonElement;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<svg class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Uploading...';
  }
  showToast(`Uploading ${files.length} image(s)...`, 'info');
  try {
    for (let i = 0; i < files.length; i++) {
      const url = await uploadToCloudinary(files[i]);
      if (url) userFormImages.push(url);
    }
    input.value = '';
    renderUserFormImages();
    showToast(`${files.length} image(s) uploaded successfully!`, 'success');
  } catch (err: any) {
    showToast(`Upload error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="upload" class="w-3.5 h-3.5"></i> Upload Files';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

function uploadUserMultiImageButton() {
  const fileInput = document.getElementById('form-image-file') as HTMLInputElement;
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    showToast('Please select image files first');
    return;
  }
  handleUserMultiImageUpload(fileInput);
}

function openAddPromptModal() {
  const modal = document.getElementById('add-prompt-modal');
  if (modal) {
    modal.classList.remove('hidden');
    const form = document.getElementById('prompt-crud-form') as HTMLFormElement;
    if (form) form.reset();
    const idInput = document.getElementById('form-prompt-id') as HTMLInputElement;
    if (idInput) idInput.value = '';
    const titleEl = document.getElementById('add-modal-title');
    if (titleEl) titleEl.innerText = 'Create New Prompt';
    userFormImages = [];
    renderUserFormImages();
    populateFormCategoryOptions();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

function openUserSubmitModal() {
  if (!currentUser) {
    openAuthModal('login');
    return;
  }
  openAddPromptModal();
}

async function handleSavePromptForm(e: Event) {
  e.preventDefault();
  const user = auth.currentUser || currentUser;
  if (!user) {
    showToast('Please sign in to submit a prompt');
    openAuthModal('login');
    return;
  }

  const submitBtn = document.getElementById('form-submit-btn') as HTMLButtonElement;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';
  }

  const idInput = document.getElementById('form-prompt-id') as HTMLInputElement;
  const id = idInput ? idInput.value.trim() : '';
  const title = (document.getElementById('form-title') as HTMLInputElement)?.value.trim() || '';
  const tool = (document.getElementById('form-tool') as HTMLSelectElement)?.value || 'ChatGPT';
  const category = (document.getElementById('form-category') as HTMLSelectElement)?.value || 'AI Art';
  let manualUrl = (document.getElementById('form-image-url') as HTMLInputElement)?.value.trim() || '';
  if (manualUrl && !userFormImages.includes(manualUrl)) {
    userFormImages.push(manualUrl);
  }
  const promptText = (document.getElementById('form-prompt-text') as HTMLTextAreaElement)?.value.trim() || '';
  const negative = (document.getElementById('form-negative-prompt') as HTMLTextAreaElement)?.value.trim() || '';
  const tagsRaw = (document.getElementById('form-tags') as HTMLInputElement)?.value.trim() || '';
  const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
  const featured = (document.getElementById('form-featured') as HTMLInputElement)?.checked || false;
  const trending = (document.getElementById('form-trending') as HTMLInputElement)?.checked || false;

  if (!title || !promptText) {
    showToast('Title and Prompt text are required');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save Prompt'; }
    return;
  }

  // Upload image file to Cloudinary if file was selected and not yet uploaded
  const fileInput = document.getElementById('form-image-file') as HTMLInputElement;
  if (fileInput?.files && fileInput.files.length > 0 && userFormImages.length === 0) {
    try {
      showToast('Uploading prompt images...', 'info');
      for (let i = 0; i < fileInput.files.length; i++) {
        const uploadedUrl = await uploadToCloudinary(fileInput.files[i]);
        if (uploadedUrl) userFormImages.push(uploadedUrl);
      }
    } catch (err: any) {
      showToast(`Image upload failed: ${err.message}`, 'error');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save Prompt'; }
      return;
    }
  }

  const finalImages = [...userFormImages];
  const primaryImage = finalImages[0] || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=600&q=80';
  const status = (currentUserRole === 'admin' || user.email === 'gangareddynaredla24925@gmail.com' || user.email === 'localride369@gmail.com') ? 'approved' : 'pending';

  try {
    if (id) {
      await updateDoc(doc(db, 'prompts', id), {
        title, tool, category,
        image: primaryImage,
        images: finalImages,
        prompt: promptText, negative, tags, featured, trending,
        updatedAt: serverTimestamp()
      });
      showToast('Prompt updated successfully!');
    } else {
      try {
        await addDoc(collection(db, 'prompts'), {
          title, tool, category,
          image: primaryImage,
          images: finalImages,
          prompt: promptText, negative, tags, featured, trending,
          status,
          views: 0, likes: 0, downloads: 0, copyCount: 0,
          creator: user.displayName || user.email?.split('@')[0] || 'PromptVerse Creator',
          creatorId: user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
        showToast(status === 'approved' ? 'Prompt published!' : 'Prompt submitted for review!');
      } catch (innerErr: any) {
        if (status === 'approved' && innerErr?.message?.toLowerCase().includes('permission')) {
          await addDoc(collection(db, 'prompts'), {
            title, tool, category,
            image: primaryImage,
            images: finalImages,
            prompt: promptText, negative, tags, featured, trending,
            status: 'pending',
            views: 0, likes: 0, downloads: 0, copyCount: 0,
            creator: user.displayName || user.email?.split('@')[0] || 'PromptVerse Creator',
            creatorId: user.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
          showToast('Prompt submitted for review! Admin will review it shortly.');
        } else {
          throw innerErr;
        }
      }
    }

    closeModal('add-prompt-modal');
    loadUserPrompts();
  } catch (err: any) {
    console.error('Submission error:', err);
    showToast(`Submission failed: ${err.message}`);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Prompt';
    }
  }
}

function editUserPrompt(id: string) {
  const p = userPrompts.find(x => x.id === id);
  if (!p) return;
  openAddPromptModal();
  const titleEl = document.getElementById('add-modal-title');
  if (titleEl) titleEl.innerText = 'Edit Prompt';
  
  (document.getElementById('form-prompt-id') as HTMLInputElement).value = p.id;
  (document.getElementById('form-title') as HTMLInputElement).value = p.title || '';
  (document.getElementById('form-tool') as HTMLSelectElement).value = p.tool || 'ChatGPT';
  (document.getElementById('form-category') as HTMLSelectElement).value = p.category || '';
  (document.getElementById('form-image-url') as HTMLInputElement).value = '';
  (document.getElementById('form-prompt-text') as HTMLTextAreaElement).value = p.prompt || '';
  (document.getElementById('form-negative-prompt') as HTMLTextAreaElement).value = p.negative || '';
  (document.getElementById('form-tags') as HTMLInputElement).value = (p.tags || []).join(', ');

  userFormImages = (p.images && Array.isArray(p.images) && p.images.length > 0)
    ? [...p.images]
    : (p.image ? [p.image] : []);
  renderUserFormImages();
}

function deleteUserPromptConfirm(id: string) {
  if (confirm('Are you sure you want to delete this prompt submission?')) {
    deleteDoc(doc(db, 'prompts', id))
      .then(() => {
        showToast('Prompt deleted successfully');
        loadUserPrompts();
      })
      .catch((err) => {
        showToast(`Failed to delete: ${err.message}`);
      });
  }
}

// =============================================================================
// BLOG CMS RENDERERS
// =============================================================================

async function loadBlogs() {
  const grid = document.getElementById('blog-posts-grid');
  const homeFeaturedGrid = document.getElementById('homepage-featured-blogs');
  try {
    const q = query(collection(db, 'blogs'), orderBy('timestamp', 'desc'));
    const snap = await getDocs(q);
    const allPosts = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
    
    // Filter client-side for published or scheduled posts whose date has passed
    const now = new Date();
    const posts = allPosts.filter((p: any) => {
      if (p.status === 'published') return true;
      if (p.status === 'scheduled' && p.publishDate) {
        const pubDate = p.publishDate.seconds ? new Date(p.publishDate.seconds * 1000) : new Date(p.publishDate);
        return pubDate <= now;
      }
      return false;
    });
    
    // Render on main blog page grid
    if (grid) {
      if (posts.length === 0) {
        grid.innerHTML = `<div class="col-span-full text-center text-slate-400 py-12">No blog posts available.</div>`;
      } else {
        grid.innerHTML = posts.map((p: any) => {
          const hasImg = !!p.featuredImage;
          const imgTag = hasImg
            ? `<img src="${p.featuredImage}" class="w-full h-44 object-cover" width="400" height="176" onerror="this.style.display='none'; this.nextElementSibling.classList.remove('hidden');" />`
            : '';
          const placeholderDiv = `<div class="${hasImg ? 'hidden' : ''} w-full h-44 bg-blue-50 flex items-center justify-center text-blue-400"><svg xmlns="http://www.w3.org/2000/svg" class="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg></div>`;
          return `
            <div onclick="viewBlogPostDetail('${p.id}')" class="bg-white rounded-2xl border border-slate-200 shadow-card hover:shadow-card-hover transition duration-300 overflow-hidden cursor-pointer flex flex-col justify-between">
              <div>
                <div class="relative w-full overflow-hidden bg-slate-50">
                  ${imgTag}
                  ${placeholderDiv}
                </div>
                <div class="p-4 space-y-2">
                  <span class="px-2 py-0.5 rounded bg-blue-50 text-blue-600 text-[10px] font-bold uppercase tracking-wider">${p.category || 'Tutorial'}</span>
                  <h3 class="font-bold text-sm text-slate-900 line-clamp-2">${p.title}</h3>
                  <p class="text-xs text-slate-500 line-clamp-3">${p.summary || ''}</p>
                </div>
              </div>
              <div class="p-4 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-400 font-semibold">
                <span class="flex items-center gap-1"><i data-lucide="user" class="w-3.5 h-3.5 text-slate-400"></i> By ${p.author || 'PromptVerse team'}</span>
                <span class="flex items-center gap-1"><i data-lucide="clock" class="w-3.5 h-3.5 text-slate-400"></i> ${p.readingTime || '5 min read'}</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // Render on homepage sidebar featured blogs widget (top 3)
    if (homeFeaturedGrid) {
      const featured = posts.slice(0, 3);
      if (featured.length === 0) {
        homeFeaturedGrid.innerHTML = `<div class="text-slate-400 text-[11px] text-center py-2">No featured articles yet.</div>`;
      } else {
        homeFeaturedGrid.innerHTML = featured.map((p: any) => {
          const imgHtml = p.featuredImage
            ? `<img src="${p.featuredImage}" class="w-10 h-10 rounded-lg object-cover shrink-0" onerror="this.style.display='none'; this.nextElementSibling.classList.remove('hidden');" />`
            : '';
          const placeholderHtml = `<div class="${p.featuredImage ? 'hidden' : ''} w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0 text-blue-400"><svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg></div>`;
          return `
            <div onclick="viewBlogPostDetail('${p.id}')" class="flex items-center gap-3 p-2 rounded-xl border border-slate-100 hover:border-blue-200 hover:bg-blue-50/30 cursor-pointer transition">
              <div class="relative overflow-hidden shrink-0">
                ${imgHtml}
                ${placeholderHtml}
              </div>
              <div class="min-w-0">
                <h4 class="font-bold text-xs text-slate-900 truncate" title="${p.title}">${p.title}</h4>
                <span class="text-[9px] text-slate-400 font-medium">${p.category || 'Tutorial'} &middot; ${p.readingTime || '5 min read'}</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch (err) {
    if (grid) grid.innerHTML = `<div class="col-span-full text-center text-rose-500 py-8">Failed to load blog posts.</div>`;
    if (homeFeaturedGrid) homeFeaturedGrid.innerHTML = `<div class="text-[10px] text-center text-rose-500 py-2">Failed to load articles.</div>`;
  }
}

async function viewBlogPostDetail(id: string) {
  navigateTo('blog-detail');
  const contentEl = document.getElementById('blog-detail-content');
  const relatedEl = document.getElementById('blog-related-posts-container');
  if (!contentEl) return;
  
  contentEl.innerHTML = `<div class="text-center py-12 text-slate-400"><i data-lucide="loader-2" class="w-8 h-8 animate-spin mx-auto mb-2 text-blue-500"></i> Loading post...</div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
  
  try {
    const d = await getDoc(doc(db, 'blogs', id));
    if (!d.exists()) {
      contentEl.innerHTML = `<div class="text-center py-12 text-slate-400">Post not found.</div>`;
      return;
    }
    const p = d.data() as any;

    // SEO optimizations: set Page Title & Meta tags dynamically
    document.title = `${p.seoTitle || p.title} | PromptVerse Blog`;
    let metaDesc = document.querySelector('meta[name="description"]');
    if (!metaDesc) {
      metaDesc = document.createElement('meta');
      metaDesc.setAttribute('name', 'description');
      document.head.appendChild(metaDesc);
    }
    metaDesc.setAttribute('content', p.seoDesc || p.summary || '');

    let metaKeywords = document.querySelector('meta[name="keywords"]');
    if (!metaKeywords) {
      metaKeywords = document.createElement('meta');
      metaKeywords.setAttribute('name', 'keywords');
      document.head.appendChild(metaKeywords);
    }
    metaKeywords.setAttribute('content', p.seoKeywords || p.category || '');

    const displayDate = p.publishDate?.seconds 
      ? new Date(p.publishDate.seconds * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      : p.timestamp?.seconds ? new Date(p.timestamp.seconds * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';

    contentEl.innerHTML = `
      <div class="space-y-4">
        <span class="px-2.5 py-1 rounded bg-blue-50 text-blue-600 text-[11px] font-bold uppercase tracking-wider">${p.category || 'AI News'}</span>
        <h1 class="text-2xl sm:text-3xl font-extrabold text-slate-900">${p.title}</h1>
        <div class="flex items-center gap-3 text-xs text-slate-400 font-bold">
          <span>By <strong>${p.author || 'Admin'}</strong></span>
          <span>&middot;</span>
          <span>${p.readingTime || '5 min read'}</span>
          <span>&middot;</span>
          <span>${displayDate}</span>
        </div>
        ${p.featuredImage ? `<img src="${p.featuredImage}" class="w-full rounded-2xl max-h-96 object-cover border" onerror="this.remove()" />` : ''}
        <div class="prose prose-slate max-w-none text-slate-700 text-xs sm:text-sm leading-relaxed pt-4">
          ${p.contentHTML || ''}
        </div>
      </div>
    `;

    // Render Related Articles Sidebar Widget (filter posts by same category/tags excluding current post)
    if (relatedEl) {
      try {
        const relatedSnap = await getDocs(query(collection(db, 'blogs'), orderBy('timestamp', 'desc')));
        const allRelated = relatedSnap.docs.map(docDoc => ({ id: docDoc.id, ...docDoc.data() as any }));
        const now = new Date();
        const filteredRelated = allRelated.filter(item => {
          if (item.id === id) return false;
          if (item.status === 'published') return true;
          if (item.status === 'scheduled' && item.publishDate) {
            const pubDate = item.publishDate.seconds ? new Date(item.publishDate.seconds * 1000) : new Date(item.publishDate);
            return pubDate <= now;
          }
          return false;
        }).filter(item => item.category === p.category).slice(0, 4);

        if (filteredRelated.length === 0) {
          relatedEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-4">No related articles found.</div>`;
        } else {
          relatedEl.innerHTML = filteredRelated.map(item => `
            <div onclick="viewBlogPostDetail('${item.id}')" class="flex items-center gap-3 p-2 rounded-xl border border-slate-100 hover:border-blue-200 hover:bg-blue-50/30 cursor-pointer transition">
              <img src="${item.featuredImage || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=150&q=80'}" class="w-10 h-10 rounded-lg object-cover shrink-0" onerror="this.src='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=150&q=80'" />
              <div class="min-w-0">
                <h5 class="font-bold text-xs text-slate-900 truncate" title="${item.title}">${item.title}</h5>
                <span class="text-[9px] text-slate-400 font-medium">${item.category || 'Tutorial'} &middot; ${item.readingTime || '5 min read'}</span>
              </div>
            </div>
          `).join('');
        }
      } catch {
        relatedEl.innerHTML = `<div class="text-xs text-slate-400 text-center py-4">Failed to load related articles.</div>`;
      }
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch (err) {
    contentEl.innerHTML = `<div class="text-center py-12 text-rose-500">Failed to load post details.</div>`;
  }
}

// =============================================================================
// DOCUMENTATION / FAQ & STATIC PAGES
// =============================================================================

async function loadDocs() {
  const container = document.getElementById('docs-content');
  
  // High quality default legal contents as production fallbacks
  const legalDefaults: Record<string, { title: string; contentHTML: string }> = {
    privacy: {
      title: 'Privacy Policy',
      contentHTML: `
        <div class="space-y-4">
          <p>Last Updated: August 2026</p>
          <p>Welcome to PromptsOne ("we", "our", or "us"). We respect your privacy and are committed to protecting your personal data. This privacy policy describes how we collect, store, use, and process your information when you use our website <strong>https://promptsone.com/</strong>.</p>
          
          <h3 class="text-sm font-bold text-slate-800">1. Information We Collect</h3>
          <p>We collect information to provide better services to all our users:</p>
          <ul class="list-disc pl-5 space-y-1">
            <li><strong>Identity & Account Data:</strong> When you register using Firebase Authentication (Google Sign-In or Email/Password), we collect your name, email address, profile picture, and UID.</li>
            <li><strong>Interactive User Content:</strong> Custom AI prompts, categories, negative parameters, and tags you submit or save to bookmarks.</li>
            <li><strong>Technical & Engagement Metrics:</strong> Views, likes, download actions, copy actions, search queries, and technical metadata logged to Firestore.</li>
          </ul>

          <h3 class="text-sm font-bold text-slate-800">2. Cookies and Storage</h3>
          <p>We use essential cookies and browser local storage strictly to store session tokens and preserve Firebase Authentication states. Optional analytical scripts (GA4) may use tracking cookies to measure search volume and user engagement.</p>

          <h3 class="text-sm font-bold text-slate-800">3. Media Assets Uploads</h3>
          <p>Any prompt graphics or sponsor logos uploaded via our interface are transferred to and stored securely on high-speed global cloud CDN storage.</p>

          <h3 class="text-sm font-bold text-slate-800">4. Sharing and Disclosure</h3>
          <p>We do not sell your personal information. Prompts and creative data published with "approved" status are public and accessible to anyone visiting the site.</p>
        </div>
      `
    },
    terms: {
      title: 'Terms of Service',
      contentHTML: `
        <div class="space-y-4">
          <p>Last Updated: August 2026</p>
          <p>Welcome to PromptsOne. By accessing or using our platform at <strong>https://promptsone.com/</strong>, you agree to comply with and be bound by these Terms of Service.</p>
          
          <h3 class="text-sm font-bold text-slate-800">1. Use License</h3>
          <p>All prompts, modifiers, and prompt engineering blueprints published on PromptsOne are licensed under open-source parameters. You may copy, modify, and use these prompts for personal or commercial creative projects using AI generation engines like Midjourney, ChatGPT, Flux, and Claude.</p>
          
          <h3 class="text-sm font-bold text-slate-800">2. User Submissions</h3>
          <p>By submitting prompts to our platform, you warrant that the text and associated image assets do not violate any copyrights, trademarks, or intellectual property rights. You grant us a non-exclusive, worldwide, royalty-free license to host, display, and distribute your submissions.</p>

          <h3 class="text-sm font-bold text-slate-800">3. Accounts and Restrictions</h3>
          <p>You are responsible for safeguarding your Firebase credentials. We reserve the right to remove any submissions or restrict access to accounts that post illegal content, spam, or malicious text strings.</p>
        </div>
      `
    },
    cookies: {
      title: 'Cookie Policy',
      contentHTML: `
        <div class="space-y-4">
          <p>Last Updated: August 2026</p>
          <p>This Cookie Policy explains how PromptVerse AI uses cookies and similar technologies to recognize you when you visit our platform.</p>

          <h3 class="text-sm font-bold text-slate-800">1. What are Cookies?</h3>
          <p>Cookies are small data files placed on your computer or mobile device. We use them strictly to provide essential session tracking and authenticate user requests securely against Firebase Cloud Services.</p>

          <h3 class="text-sm font-bold text-slate-800">2. Types of Cookies We Use</h3>
          <ul class="list-disc pl-5 space-y-1">
            <li><strong>Essential Cookies:</strong> Critical for Firebase Authentication and maintaining secure sign-in states. The platform will not function properly without these.</li>
            <li><strong>Analytical Cookies:</strong> Placed by Google Analytics (GA4) or Microsoft Clarity to collect aggregated visitor behavior data and search performance metrics.</li>
          </ul>
        </div>
      `
    },
    about: {
      title: 'About Us',
      contentHTML: `
        <div class="space-y-4">
          <p>PromptVerse AI is a premium prompt engineering repository and search hub designed to make high-quality artificial intelligence creation accessible to everyone.</p>
          <p>Our database contains curated, production-ready prompts, negative exclusions, and parameters optimized for systems like ChatGPT, Midjourney, Flux, Claude, Ideogram, and Leonardo AI. Join our community of creators today!</p>
        </div>
      `
    }
  };

  try {
    const snap = await getDocs(collection(db, 'staticPages'));
    const pages = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
    
    // Inject fetched page content or use default values if pages are not found or empty
    const pageKeys: Array<'about' | 'privacy' | 'terms' | 'cookies'> = ['about', 'privacy', 'terms', 'cookies'];
    pageKeys.forEach(key => {
      const el = document.getElementById(`${key}-content-area`);
      if (el) {
        const found = pages.find(p => p.id === key);
        const title = found ? found.title : legalDefaults[key].title;
        const html = found ? found.contentHTML : legalDefaults[key].contentHTML;
        el.innerHTML = `<h1 class="text-2xl font-bold text-slate-900 mb-2">${title}</h1><div class="prose max-w-none text-slate-600">${html}</div>`;
      }
    });

    if (container) {
      const faqPages = pages.filter((p: any) => p.id.startsWith('faq_') || p.category === 'faq' || p.category === 'help');
      if (faqPages.length === 0) {
        container.innerHTML = `
          <div class="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm space-y-2">
            <h3 class="font-bold text-sm text-slate-900">How do I copy prompts?</h3>
            <p class="text-xs text-slate-500">Simply hover over any prompt card and click the 'Copy' button to copy it to your clipboard.</p>
          </div>
          <div class="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm space-y-2">
            <h3 class="font-bold text-sm text-slate-900">Can I submit my own prompts?</h3>
            <p class="text-xs text-slate-500">Yes! Sign in using Google or Email, go to your Creator Workspace Dashboard, and submit your prompt for review.</p>
          </div>
        `;
      } else {
        container.innerHTML = faqPages.map((p: any) => `
          <div class="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm space-y-2">
            <h3 class="font-bold text-sm text-slate-900">${p.title}</h3>
            <div class="text-xs text-slate-500 leading-relaxed">${p.contentHTML}</div>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    // Fail-safe defaults on error
    const pageKeys: Array<'about' | 'privacy' | 'terms' | 'cookies'> = ['about', 'privacy', 'terms', 'cookies'];
    pageKeys.forEach(key => {
      const el = document.getElementById(`${key}-content-area`);
      if (el) {
        el.innerHTML = `<h1 class="text-2xl font-bold text-slate-900 mb-2">${legalDefaults[key].title}</h1><div class="prose max-w-none text-slate-600">${legalDefaults[key].contentHTML}</div>`;
      }
    });
  }
}

// =============================================================================
// CONTACT FORM SUBMISSIONS
// =============================================================================

async function handleContactSubmit(e: Event) {
  e.preventDefault();
  const name = (document.getElementById('contact-name') as HTMLInputElement).value.trim();
  const email = (document.getElementById('contact-email') as HTMLInputElement).value.trim();
  const subject = (document.getElementById('contact-subject') as HTMLInputElement).value.trim();
  const message = (document.getElementById('contact-message') as HTMLInputElement).value.trim();
  
  if (!name || !email || !subject || !message) {
    showToast('All fields are required');
    return;
  }
  
  try {
    await addDoc(collection(db, 'contactSubmissions'), {
      name, email, subject, message,
      status: 'new',
      notes: '',
      timestamp: serverTimestamp()
    });
    showToast('Your message has been sent successfully!');
    (e.target as HTMLFormElement).reset();
  } catch (err: any) {
    showToast(`Failed to send message: ${err.message}`);
  }
}

// =============================================================================
// DYNAMIC THIRD-PARTY TRACKING INTEGRATIONS
// =============================================================================

async function injectThirdPartyScripts() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'site'));
    if (!snap.exists()) return;
    const data = snap.data();
    
    // 1. Google Analytics (GA4)
    if (data.ga4Id) {
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${data.ga4Id}`;
      document.head.appendChild(script);
      
      const inlineScript = document.createElement('script');
      inlineScript.innerHTML = `
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', '${data.ga4Id}');
      `;
      document.head.appendChild(inlineScript);
    }

    // 2. Microsoft Clarity
    if (data.clarityId) {
      const clarityScript = document.createElement('script');
      clarityScript.innerHTML = `
        (function(c,l,a,r,i,t,y){
            c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
            t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
            y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
        })(window, document, "clarity", "script", "${data.clarityId}");
      `;
      document.head.appendChild(clarityScript);
    }

    // 3. Meta Pixel
    if (data.metaPixelId) {
      const pixelScript = document.createElement('script');
      pixelScript.innerHTML = `
        !function(f,b,e,v,n,t,s)
        {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
        n.callMethod.apply(n,arguments):n.queue.push(arguments)};
        if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
        n.queue=[];t=b.createElement(e);t.async=!0;
        t.src=v;s=b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t,s)}(window, document,'script',
        'https://connect.facebook.net/en_US/fbevents.js');
        fbq('init', '${data.metaPixelId}');
        fbq('track', 'PageView');
      `;
      document.head.appendChild(pixelScript);
    }
  } catch (err) {
    console.warn('Failed to load tracking scripts:', err);
  }
}



// =============================================================================
// RENDER ALL — CACHE-BASED (called on auth/bookmark changes, NOT on page load)
// =============================================================================

function renderAll() {
  renderCategoryPills();
  renderAIToolsList();
  renderTrendingPromptsFromCache();
  renderGalleryFromCache();
  renderPopularSearches();
  renderCollections();
  populateFormCategoryOptions();
  loadBlogs();
  renderGalleryTagPills();
}

function renderGalleryTagPills() {
  const container = document.getElementById('gallery-tag-pills');
  if (!container) return;
  container.innerHTML = `
    <span class="text-[11px] font-bold text-[#5a7260] shrink-0 flex items-center gap-1 pr-1">
      <i data-lucide="trending-up" class="w-3.5 h-3.5 text-[#2d8a45]"></i> Trending:
    </span>
    ${activeTrendingHashtags.map(tag => `
      <button onclick="quickSearch('${tag.replace('#', '')}')" class="shrink-0 px-3 py-1 rounded-full bg-white hover:bg-[#e8f5ec] hover:text-[#1a5c2a] hover:border-[#2d8a45]/40 border border-[#dde8df] text-[#5a7260] font-bold text-[11px] transition shadow-xs">
        ${tag}
      </button>
    `).join('')}
  `;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// CATEGORY PILLS
// =============================================================================

function renderCategoryPills() {
  const container = document.getElementById('categories-container');
  if (!container) return;
  container.innerHTML = categories.map(cat => `
    <button onclick="quickSearch('${cat.name}')" class="shrink-0 px-4 py-2.5 rounded-2xl bg-slate-50 hover:bg-blue-50 hover:border-blue-200 border border-slate-200/80 text-slate-700 hover:text-blue-600 font-semibold text-xs flex items-center gap-2 transition duration-200 shadow-sm">
      <div class="w-6 h-6 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
        <i data-lucide="${cat.icon || 'folder'}" class="w-3.5 h-3.5"></i>
      </div>
      <span>${cat.name}</span>
    </button>
  `).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// AI TOOLS LIST
// =============================================================================

function renderAIToolsList() {
  const tools = [
    { name: 'ChatGPT', icon: 'bot', color: 'text-emerald-600' },
    { name: 'Gemini', icon: 'sparkles', color: 'text-blue-600' },
    { name: 'Claude', icon: 'star', color: 'text-purple-600' },
    { name: 'Midjourney', icon: 'compass', color: 'text-indigo-600' },
    { name: 'Flux', icon: 'zap', color: 'text-amber-500' },
    { name: 'Ideogram', icon: 'type', color: 'text-rose-500' },
    { name: 'Leonardo AI', icon: 'palette', color: 'text-violet-600' }
  ];

  const container = document.getElementById('ai-tools-list');
  if (!container) return;
  container.innerHTML = tools.map(t => `
    <button onclick="filterByTool('${t.name}')" class="w-full text-left px-3 py-2 rounded-xl text-xs font-semibold ${currentToolFilter === t.name ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-100'} flex items-center justify-between transition group">
      <div class="flex items-center gap-2.5">
        <i data-lucide="${t.icon}" class="w-4 h-4 ${t.color}"></i>
        <span>${t.name}</span>
      </div>
      <i data-lucide="chevron-right" class="w-3.5 h-3.5 text-slate-300 group-hover:text-slate-600"></i>
    </button>
  `).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// PROMPT GALLERY CARD
// =============================================================================

function renderPromptsGallery(promptsToRender: PromptItem[]) {
  const container = document.getElementById('prompts-grid');
  if (!container) return;
  if (promptsToRender.length === 0) {
    renderEmptyState(container, 'No prompts found');
    return;
  }
  container.innerHTML = promptsToRender.map(p => createPromptCardHTML(p)).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function optimizeImageUrl(url: string): string {
  if (!url) return '';
  if (url.includes('cloudinary.com') && !url.includes('/f_auto,q_auto/')) {
    return url.replace('/upload/', '/upload/f_auto,q_auto/');
  }
  return url;
}

function createPromptCardHTML(p: PromptItem): string {
  const isBookmarked = bookmarks && bookmarks.includes(p.id);
  const imgUrl = optimizeImageUrl(p.image);
  const creatorClean = (p.creator || 'Creator').replace(/\d+$/, '').replace(/[._-]+/g, ' ');
  const creatorDisplay = creatorClean.charAt(0).toUpperCase() + creatorClean.slice(1).toLowerCase();
  const imageCount = (p.images && Array.isArray(p.images) && p.images.length > 0) ? p.images.length : (p.image ? 1 : 0);

  return `
    <div class="bg-white rounded-2xl border border-[#dde8df] shadow-card hover:shadow-card-hover hover:-translate-y-1 transition duration-300 overflow-hidden group flex flex-col justify-between cursor-pointer" onclick="openPromptDetail('${p.id}')">
      <div>
        <div class="relative w-full h-56 sm:h-64 overflow-hidden bg-[#f4f7f5] border-b border-[#dde8df] group/img">
          <img src="${imgUrl}" alt="${p.title}" 
               class="w-full h-full object-cover object-center block group-hover/img:scale-105 transition-transform duration-500 opacity-0" 
               loading="lazy" 
               onload="this.classList.remove('opacity-0');"
               onerror="this.src='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=600&q=80'; this.classList.remove('opacity-0');" />
          <div class="absolute top-2.5 left-2.5 z-20 flex items-center gap-1.5 flex-wrap">
            <span class="px-2 py-0.5 rounded-md bg-black/70 text-white font-bold text-[10px] backdrop-blur-md border border-white/10 shadow-sm flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-[#f5c518] animate-pulse"></span> ${p.tool}
            </span>
            <span class="px-2 py-0.5 rounded-md bg-[#fff9e6] text-[#1a5c2a] border border-[#f5c518]/30 font-bold text-[10px] backdrop-blur-md shadow-sm">
              ${p.category}
            </span>
          </div>
          <button onclick="event.stopPropagation(); toggleBookmarkCard('${p.id}', event)" class="absolute top-2.5 right-2.5 z-20 p-1.5 rounded-lg bg-white/90 hover:bg-white text-slate-700 shadow-sm transition backdrop-blur-sm" title="Bookmark Prompt">
            <i data-lucide="bookmark" class="w-3.5 h-3.5 ${isBookmarked ? 'text-[#f5c518] fill-[#f5c518]' : 'text-slate-400'}"></i>
          </button>
          ${imageCount > 1 ? `
            <div class="absolute bottom-2.5 right-2.5 z-20 px-2 py-0.5 rounded-md bg-black/75 text-white font-extrabold text-[10px] backdrop-blur-md border border-white/10 flex items-center gap-1 shadow-sm">
              <i data-lucide="layers" class="w-3 h-3 text-[#f5c518]"></i> ${imageCount}
            </div>
          ` : ''}
        </div>
        <div class="p-3.5 space-y-2.5">
          <h3 class="font-bold text-xs text-[#1a2e1e] line-clamp-1 group-hover:text-[#2d8a45] transition tracking-tight">${p.title}</h3>
          
          <!-- Engineered Prompt Preview Box -->
          <div class="relative rounded-xl bg-[#f4f7f5] border border-[#dde8df] p-2.5 group-hover:border-[#2d8a45]/40 group-hover:bg-[#e8f5ec]/30 transition-all">
            <div class="flex items-center justify-between mb-1">
              <span class="text-[9px] font-extrabold uppercase tracking-wider text-[#5a7260] flex items-center gap-1">
                <i data-lucide="terminal" class="w-2.5 h-2.5 text-[#2d8a45]"></i> Prompt
              </span>
              <span class="text-[9px] font-semibold text-[#9ab09e] font-mono">${(p.prompt || '').length} chars</span>
            </div>
            <p class="text-[11.5px] text-[#1a2e1e] font-mono line-clamp-2 leading-relaxed tracking-tight select-all">${p.prompt}</p>
          </div>
        </div>
      </div>
      <div class="px-3.5 pb-3.5 pt-2 flex items-center justify-between border-t border-[#dde8df] text-xs">
        <span class="text-[#5a7260] font-medium text-[11px] truncate max-w-[130px]">By ${creatorDisplay}</span>
        <button onclick="copyPromptText('${p.id}', event)" class="btn by px-3 py-1 rounded-lg text-[11px] flex items-center gap-1.5 transition shadow-sm active:scale-95" title="Copy Prompt">
          <i data-lucide="copy" class="w-3 h-3"></i> Copy
        </button>
      </div>
    </div>
  `;
}

// =============================================================================
// SIDEBAR WIDGETS (HOME PAGE) — Firestore-driven
// =============================================================================

async function renderPopularSearches() {
  const container = document.getElementById('popular-searches-list');
  if (!container) return;
  try {
    // Try to load from Firestore searchAnalytics collection (top search terms)
    const snap = await getDocs(query(
      collection(db, 'searchAnalytics'),
      orderBy('count', 'desc'),
      limit(6)
    ));
    if (!snap.empty) {
      const searches = snap.docs.map(d => d.data().query as string).filter(Boolean);
      if (searches.length > 0) {
        container.innerHTML = searches.map((s, idx) => `
          <div onclick="quickSearch('${s.replace(/'/g, "\\'")}')"
               class="flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 cursor-pointer transition">
            <div class="flex items-center gap-3">
              <span class="w-5 h-5 rounded-full bg-slate-100 text-slate-500 text-xs font-bold flex items-center justify-center">${idx + 1}</span>
              <span class="font-semibold text-slate-700 text-xs">${s}</span>
            </div>
            <i data-lucide="trending-up" class="w-3.5 h-3.5 text-emerald-500"></i>
          </div>
        `).join('');
        if (typeof lucide !== 'undefined') lucide.createIcons();
        return;
      }
    }
  } catch (_) { /* no analytics yet */ }
  // Empty state if no search data
  container.innerHTML = `
    <div class="py-4 text-center text-slate-400">
      <i data-lucide="search" class="w-6 h-6 mx-auto mb-1"></i>
      <p class="text-xs">No search data yet</p>
    </div>
  `;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function renderCollections() {
  const container = document.getElementById('featured-collections-list');
  if (!container) return;
  try {
    const snap = await getDocs(query(
      collection(db, 'collections'),
      orderBy('order', 'asc'),
      limit(4)
    ));
    if (!snap.empty) {
      container.innerHTML = snap.docs.map(d => {
        const c = d.data() as any;
        const imgHtml = c.imageUrl
          ? `<img src="${c.imageUrl}" class="w-10 h-10 rounded-lg object-cover shrink-0" loading="lazy" />`
          : `<div class="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0"><i data-lucide="layers" class="w-5 h-5 text-blue-400"></i></div>`;
        const count = c.promptCount ? `${c.promptCount} Prompts` : '';
        return `
          <div onclick="quickSearch('${(c.name || '').replace(/'/g, "\\'")}')"
               class="flex items-center gap-3 p-2 rounded-xl border border-slate-100 hover:border-blue-200 hover:bg-blue-50/30 cursor-pointer transition">
            ${imgHtml}
            <div>
              <h4 class="font-bold text-xs text-slate-900">${c.name || ''}</h4>
              ${count ? `<span class="text-[10px] text-slate-400 font-medium">${count}</span>` : ''}
            </div>
          </div>
        `;
      }).join('');
      if (typeof lucide !== 'undefined') lucide.createIcons();
      return;
    }
  } catch (_) { /* collections not loaded */ }
  container.innerHTML = `
    <div class="py-4 text-center text-slate-400">
      <i data-lucide="layers" class="w-6 h-6 mx-auto mb-1"></i>
      <p class="text-xs">No collections yet</p>
    </div>
  `;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// SEARCH & FILTER
// =============================================================================

function quickSearch(queryStr: string) {
  const heroInput = document.getElementById('hero-search-input') as HTMLInputElement;
  if (heroInput) heroInput.value = queryStr;
  executeSearch();
}

function executeSearch() {
  const heroInput = document.getElementById('hero-search-input') as HTMLInputElement;
  const queryStr = heroInput ? heroInput.value.trim() : '';
  navigateTo('search');
  const mainInput = document.getElementById('main-search-page-input') as HTMLInputElement;
  if (mainInput) mainInput.value = queryStr;
  triggerSearchFilter();
}

function triggerSearchFilter() {
  const mainInput = document.getElementById('main-search-page-input') as HTMLInputElement;
  const catSelect = document.getElementById('search-category-select') as HTMLSelectElement;
  const toolSelect = document.getElementById('search-tool-select') as HTMLSelectElement;

  const queryStr = mainInput ? mainInput.value.toLowerCase().trim() : '';
  const catVal = catSelect ? catSelect.value : 'all';
  const toolVal = toolSelect ? toolSelect.value : 'all';

  // Search across all cached prompts (home cache, deduplicated)
  const searchPool = dedupePrompts([...prompts]);

  const scored = searchPool
    .filter(p => {
      const matchesCat = catVal === 'all' || p.category === catVal;
      const matchesTool = toolVal === 'all' || p.tool === toolVal;
      const matchesStatus = p.status === 'approved' || currentUserRole === 'admin';
      let matchesText = true;
      if (queryStr) {
        const allText = [
          p.title, p.prompt, p.category, p.tool,
          ...(p.tags || []),
          ...(p.seasonalTags || [])
        ].join(' ').toLowerCase();
        matchesText = allText.includes(queryStr);
      }
      return matchesCat && matchesTool && matchesStatus && matchesText;
    })
    .map(p => ({ ...p, _score: computeRankScore(p, queryStr) }))
    .sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

  const countEl = document.getElementById('search-results-count');
  if (countEl) {
    countEl.innerText = `Showing ${scored.length} result${scored.length !== 1 ? 's' : ''}${queryStr ? ` for "${queryStr}"` : ''}`;
  }

  const grid = document.getElementById('search-results-grid');
  if (scored.length === 0) {
    renderEmptyState(
      grid,
      queryStr ? `No results for "${queryStr}"` : 'No prompts match your filters',
      'Try different keywords, clear filters, or browse all categories'
    );
  } else {
    if (grid) grid.innerHTML = scored.map(p => createPromptCardHTML(p)).join('');
    
    // Inject sponsored ads & AdSense units below search results
    renderSearchAds();
    setupAdObservers();
    
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

function filterByTool(toolName: string) {
  currentToolFilter = toolName;
  renderAIToolsList(); // Update active highlight
  renderGalleryFromCache();
  updateLoadMoreButton();
}

async function filterBySort(sortType: string) {
  currentSortType = sortType;
  currentToolFilter = 'all'; // Reset tool filter on sort change
  // Sync the tool filter dropdown in gallery UI
  const toolFilterSelect = document.getElementById('tool-filter-select') as HTMLSelectElement;
  if (toolFilterSelect) toolFilterSelect.value = 'all';
  await loadInitialPrompts(); // Re-query Firestore with new sort
}

// =============================================================================
// PROMPT DETAIL PAGE & MULTI-IMAGE CAROUSEL
// =============================================================================

let currentDetailImages: string[] = [];
let currentDetailImageIndex = 0;

function updateDetailCarouselDisplay() {
  if (currentDetailImages.length === 0) return;
  const currentImg = optimizeImageUrl(currentDetailImages[currentDetailImageIndex] || currentDetailImages[0]);
  const setSrc = (id: string, src: string) => { const el = document.getElementById(id) as HTMLImageElement; if (el) el.src = src; };
  setSrc('detail-image', currentImg);
  setSrc('detail-image-bg', currentImg);

  const prevBtn = document.getElementById('carousel-prev-btn');
  const nextBtn = document.getElementById('carousel-next-btn');
  const counterEl = document.getElementById('detail-carousel-counter');
  const thumbsContainer = document.getElementById('detail-carousel-thumbs');

  if (currentDetailImages.length > 1) {
    if (prevBtn) prevBtn.classList.remove('hidden');
    if (nextBtn) nextBtn.classList.remove('hidden');
    if (counterEl) {
      counterEl.classList.remove('hidden');
      counterEl.textContent = `${currentDetailImageIndex + 1} / ${currentDetailImages.length}`;
    }
    if (thumbsContainer) {
      thumbsContainer.innerHTML = currentDetailImages.map((img, idx) => `
        <button type="button" onclick="setDetailImageIndex(${idx})" class="w-12 h-12 rounded-xl overflow-hidden border-2 transition shrink-0 ${idx === currentDetailImageIndex ? 'border-[#2d8a45] shadow-md scale-105' : 'border-slate-200 opacity-60 hover:opacity-100'}">
          <img src="${optimizeImageUrl(img)}" alt="Thumb ${idx + 1}" class="w-full h-full object-cover" />
        </button>
      `).join('');
    }
  } else {
    if (prevBtn) prevBtn.classList.add('hidden');
    if (nextBtn) nextBtn.classList.add('hidden');
    if (counterEl) counterEl.classList.add('hidden');
    if (thumbsContainer) thumbsContainer.innerHTML = '';
  }
}

function prevDetailImage(e?: Event) {
  if (e) e.stopPropagation();
  if (currentDetailImages.length <= 1) return;
  currentDetailImageIndex = (currentDetailImageIndex - 1 + currentDetailImages.length) % currentDetailImages.length;
  updateDetailCarouselDisplay();
}

function nextDetailImage(e?: Event) {
  if (e) e.stopPropagation();
  if (currentDetailImages.length <= 1) return;
  currentDetailImageIndex = (currentDetailImageIndex + 1) % currentDetailImages.length;
  updateDetailCarouselDisplay();
}

function setDetailImageIndex(idx: number) {
  if (idx < 0 || idx >= currentDetailImages.length) return;
  currentDetailImageIndex = idx;
  updateDetailCarouselDisplay();
}

function openCurrentFullscreenImage() {
  const currentImg = currentDetailImages[currentDetailImageIndex] || currentDetailImages[0];
  if (currentImg) {
    window.open(currentImg, '_blank');
  }
}

async function openPromptDetail(id: string, updateHash = true) {
  // Look up in cache first (fast path)
  let p = findPromptById(id);

  // If not in cache, fetch directly from Firestore
  if (!p) {
    try {
      const docSnap = await getDoc(doc(db, 'prompts', id));
      if (docSnap.exists()) {
        p = { id: docSnap.id, ...docSnap.data() } as PromptItem;
      }
    } catch (err) {
      console.warn('Could not fetch prompt from Firestore:', err);
    }
  }

  if (!p) {
    showToast('Prompt not found');
    return;
  }

  currentSelectedPrompt = p;

  // Increment views asynchronously (fire-and-forget)
  updateDoc(doc(db, 'prompts', p.id), { views: increment(1) })
    .then(() => { if (p) p.views = (p.views || 0) + 1; })
    .catch(() => {});

  if (updateHash) window.location.hash = '#prompt/' + p.id;

  navigateTo('details');

  // Dynamic SEO metadata for current prompt
  document.title = `${p.title} — PromptsOne AI`;
  const canonicalEl = document.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
  const promptUrl = `https://promptsone.com/#prompt/${p.id}`;
  if (canonicalEl) canonicalEl.href = promptUrl;
  const ogTitle = document.querySelector("meta[property='og:title']");
  if (ogTitle) ogTitle.setAttribute('content', `${p.title} — PromptsOne`);
  const ogUrl = document.querySelector("meta[property='og:url']");
  if (ogUrl) ogUrl.setAttribute('content', promptUrl);
  const ogDesc = document.querySelector("meta[property='og:description']");
  const cleanSnippet = (p.prompt || '').slice(0, 150).replace(/"/g, "'");
  if (ogDesc) ogDesc.setAttribute('content', cleanSnippet);
  const metaDesc = document.querySelector("meta[name='description']");
  if (metaDesc) metaDesc.setAttribute('content', `${p.title}: ${cleanSnippet}`);
  const ogImg = document.querySelector("meta[property='og:image']");
  if (ogImg && p.image) ogImg.setAttribute('content', p.image);

  // Dynamic Prompt Schema.org Structured Data
  let promptLd = document.getElementById('prompt-dynamic-ld') as HTMLScriptElement | null;
  if (!promptLd) {
    promptLd = document.createElement('script');
    promptLd.id = 'prompt-dynamic-ld';
    promptLd.type = 'application/ld+json';
    document.head.appendChild(promptLd);
  }
  promptLd.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    "name": p.title,
    "description": cleanSnippet,
    "image": p.image,
    "author": {
      "@type": "Person",
      "name": p.creator
    },
    "keywords": [p.tool, p.category, ...(p.tags || [])].join(', '),
    "url": promptUrl
  });

  // Setup multi-image gallery state
  const allImages = (p.images && Array.isArray(p.images) && p.images.length > 0)
    ? p.images.filter(Boolean)
    : (p.image ? [p.image] : []);
  currentDetailImages = allImages;
  currentDetailImageIndex = 0;
  updateDetailCarouselDisplay();

  // Populate all detail page elements
  const set = (id: string, val: string) => { const el = document.getElementById(id); if (el) el.innerText = val; };
  const setHTML = (id: string, val: string) => { const el = document.getElementById(id); if (el) el.innerHTML = val; };

  set('detail-breadcrumb-category', p.category);
  set('detail-breadcrumb-title', p.title);
  set('detail-tool-text', p.tool);
  set('detail-category-badge', p.category);
  set('detail-title', p.title);
  set('detail-creator-name', p.creator);
  set('detail-creator-avatar', p.creator.charAt(0).toUpperCase());

  setHTML('detail-views', `<i data-lucide="eye" class="w-3.5 h-3.5 text-blue-500"></i> ${formatNumber(p.views)}`);
  setHTML('detail-likes', `<i data-lucide="heart" class="w-3.5 h-3.5 text-rose-500"></i> ${formatNumber(p.likes)}`);
  setHTML('detail-downloads', `<i data-lucide="download" class="w-3.5 h-3.5 text-emerald-500"></i> ${formatNumber(p.downloads || 0)}`);
  set('detail-generate-text', `Generate in ${p.tool}`);

  // Tags — use real tags + auto-generated fallback
  const tagsContainer = document.getElementById('detail-tags-container');
  if (tagsContainer) {
    const allTags = [
      ...(p.tags || []).map(t => `#${t}`),
      ...(p.seasonalTags || []).map(t => `#${t}`),
      `#${p.tool}`,
      `#${p.category.replace(/\s+/g, '')}`,
      '#PromptVerse'
    ].filter(Boolean).slice(0, 6);
    tagsContainer.innerHTML = allTags.map(t => `
      <span onclick="quickSearch('${t.replace('#', '')}')" class="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-blue-50 hover:text-blue-600 text-slate-600 font-bold text-[11px] cursor-pointer transition">${t}</span>
    `).join('');
  }

  set('detail-full-prompt', p.prompt);
  set('detail-char-count', `${p.prompt.length} chars`);
  set('detail-negative-text', p.negative || 'blurry, distorted facial features, low resolution, bad anatomy, cropped limbs, text watermark, draft quality, overexposed noise');

  // Output samples — render all available image variations with full uncropped fit
  const outputSamplesEl = document.getElementById('detail-output-samples');
  if (outputSamplesEl) {
    if (currentDetailImages.length > 0) {
      outputSamplesEl.innerHTML = currentDetailImages.map((img, idx) => `
        <div onclick="setDetailImageIndex(${idx})" class="group relative rounded-2xl overflow-hidden bg-[#f4f7f5] shadow-sm h-64 sm:h-72 cursor-pointer border-2 transition ${idx === currentDetailImageIndex ? 'border-[#2d8a45] shadow-md scale-[1.01]' : 'border-[#dde8df] hover:border-[#2d8a45]/50'}">
          <img src="${optimizeImageUrl(img)}" alt="${p.title} variation ${idx + 1}" class="w-full h-full object-cover object-center group-hover:scale-105 transition duration-500" loading="lazy" />
          <span class="absolute bottom-2 left-2 z-20 px-2.5 py-0.5 rounded-md bg-black/75 text-white text-[10px] font-bold backdrop-blur-md border border-white/10 flex items-center gap-1">
            <i data-lucide="image" class="w-3 h-3 text-[#f5c518]"></i> Variation ${idx + 1}
          </span>
        </div>
      `).join('');
    } else {
      outputSamplesEl.innerHTML = `
        <div class="col-span-full rounded-2xl bg-slate-100 aspect-square flex items-center justify-center text-slate-300">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
      `;
    }
  }

  setHTML('detail-tips-list', `
    <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-emerald-500 shrink-0 mt-0.5"></i> Best optimized for <strong>${p.tool}</strong> engine. High prompt adherence rate.</li>
    <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-emerald-500 shrink-0 mt-0.5"></i> Use aspect ratio parameter <strong>--ar 16:9</strong> for horizontal poster, or <strong>--ar 4:5</strong> for mobile feeds.</li>
    <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-emerald-500 shrink-0 mt-0.5"></i> Add descriptive lighting keywords like <em>'cinematic volumetric morning sunlight'</em> or <em>'hyper-detailed raytracing'</em> for maximal depth.</li>
  `);

  set('mobile-sticky-title', p.title);
  set('mobile-sticky-tool', p.tool);

  // Related, Recommendations & Sidebars
  renderRelatedPromptsAsync(p);
  renderRecommendationSections(p);
  renderSidebarWidgets();

  // Render detail page dynamic ads & sponsored content
  renderDetailPageAds();
  setupAdObservers();

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// BOOKMARKS & LIKES
// =============================================================================

async function toggleBookmarkCard(id: string, e?: Event) {
  if (e) e.stopPropagation();
  if (!currentUser) {
    showToast('Please sign in to save prompts to your account');
    openAuthModal('login');
    return;
  }
  const isBookmarked = bookmarks.includes(id);
  const bookmarkRef = doc(db, 'users', currentUser.uid, 'bookmarks', id);
  try {
    if (isBookmarked) {
      await deleteDoc(bookmarkRef);
      showToast('Removed from Bookmarks');
    } else {
      await setDoc(bookmarkRef, { promptId: id, createdAt: serverTimestamp() });
      showToast('Saved to Cloud Bookmarks!');
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${currentUser.uid}/bookmarks/${id}`);
  }
}

async function toggleLikeCard(id: string, e?: Event) {
  if (e) e.stopPropagation();
  if (!currentUser) {
    showToast('Please sign in to like prompts');
    openAuthModal('login');
    return;
  }

  const isLiked = userLikes.includes(id);
  const likeRef = doc(db, 'users', currentUser.uid, 'likes', id);
  const promptRef = doc(db, 'prompts', id);

  try {
    if (isLiked) {
      await deleteDoc(likeRef);
      await updateDoc(promptRef, { likes: increment(-1) }).catch(() => {});
      const p = findPromptById(id);
      if (p) p.likes = Math.max(0, (p.likes || 1) - 1);
      showToast('Unliked prompt');
    } else {
      await setDoc(likeRef, { promptId: id, createdAt: serverTimestamp() });
      await updateDoc(promptRef, { likes: increment(1) }).catch(() => {});
      const p = findPromptById(id);
      if (p) p.likes = (p.likes || 0) + 1;
      showToast('Liked prompt! ❤️');
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${currentUser.uid}/likes/${id}`);
  }
}

async function toggleLikeCurrent() {
  if (!currentSelectedPrompt) return;
  await toggleLikeCard(currentSelectedPrompt.id);
  const countEl = document.getElementById('modal-like-count');
  if (countEl) countEl.innerText = formatNumber(currentSelectedPrompt.likes || 0);
  const detailLikes = document.getElementById('detail-likes');
  if (detailLikes) detailLikes.innerHTML = `<i data-lucide="heart" class="w-3.5 h-3.5 text-rose-500"></i> ${formatNumber(currentSelectedPrompt.likes || 0)}`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function downloadCurrentPrompt() {
  if (currentSelectedPrompt) {
    downloadPrompt(currentSelectedPrompt.id);
  }
}

function downloadPrompt(id: string, e?: Event) {
  if (e) e.stopPropagation();
  const p = findPromptById(id);
  if (!p) return;

  const content = `==================================================
PROMPTVERSE AI — ENGINEERED PROMPT
==================================================
Title: ${p.title}
AI Tool: ${p.tool}
Category: ${p.category}
Creator: ${p.creator}
URL: ${window.location.origin}/#prompt/${p.id}

PROMPT TEXT:
${p.prompt}

NEGATIVE PROMPT:
${p.negative || 'None specified'}

TAGS:
${(p.tags || []).join(', ')}
==================================================`;

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(p.title || 'prompt').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_prompt.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  // Increment download count in Firestore
  updateDoc(doc(db, 'prompts', p.id), { downloads: increment(1) }).catch(() => {});
  p.downloads = (p.downloads || 0) + 1;
  const detailDownloads = document.getElementById('detail-downloads');
  if (detailDownloads) detailDownloads.innerHTML = `<i data-lucide="download" class="w-3.5 h-3.5 text-emerald-500"></i> ${formatNumber(p.downloads)}`;
  showToast('Prompt downloaded!');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// FORM OPTIONS POPULATOR
// =============================================================================

function populateFormCategoryOptions() {
  const select = document.getElementById('form-category') as HTMLSelectElement;
  const searchCatSelect = document.getElementById('search-category-select') as HTMLSelectElement;
  
  const names = new Set<string>();
  categories.forEach(c => { if (c.name) names.add(c.name); });
  DEFAULT_CATEGORIES.forEach(c => names.add(c.name));
  const sorted = Array.from(names).sort();
  const optionsHtml = sorted.map(name => `<option value="${name}">${name}</option>`).join('');

  if (select) {
    const cur = select.value;
    select.innerHTML = optionsHtml;
    if (cur) select.value = cur;
  }
  if (searchCatSelect) {
    const curSearch = searchCatSelect.value;
    searchCatSelect.innerHTML = `<option value="all">All Categories</option>` + optionsHtml;
    if (curSearch) searchCatSelect.value = curSearch;
  }
}

// =============================================================================
// AUTH HANDLERS
// =============================================================================

function showAuthError(msg: string) {
  const banner = document.getElementById('auth-error-banner');
  const txt = document.getElementById('auth-error-text');
  if (banner && txt) {
    txt.textContent = msg;
    banner.classList.remove('hidden');
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
  showToast(msg, 'error');
}

function clearAuthError() {
  const banner = document.getElementById('auth-error-banner');
  if (banner) banner.classList.add('hidden');
}

function switchAuthTab(tab: 'login' | 'signup') {
  clearAuthError();
  const loginBtn = document.getElementById('auth-tab-btn-login');
  const signupBtn = document.getElementById('auth-tab-btn-signup');
  const loginForm = document.getElementById('auth-login-form');
  const signupForm = document.getElementById('auth-signup-form');
  const title = document.getElementById('auth-title');
  const subtitle = document.getElementById('auth-subtitle');

  if (tab === 'login') {
    if (loginBtn) {
      loginBtn.className = 'py-2 rounded-xl transition bg-white text-blue-600 shadow-sm';
    }
    if (signupBtn) {
      signupBtn.className = 'py-2 rounded-xl transition text-slate-600 hover:text-slate-900';
    }
    if (loginForm) loginForm.classList.remove('hidden');
    if (signupForm) signupForm.classList.add('hidden');
    if (title) title.innerText = 'Welcome Back to PromptsOne';
    if (subtitle) subtitle.innerText = 'Sign in to access your saved prompts & bookmarks';
  } else {
    if (signupBtn) {
      signupBtn.className = 'py-2 rounded-xl transition bg-white text-emerald-600 shadow-sm';
    }
    if (loginBtn) {
      loginBtn.className = 'py-2 rounded-xl transition text-slate-600 hover:text-slate-900';
    }
    if (signupForm) signupForm.classList.remove('hidden');
    if (loginForm) loginForm.classList.add('hidden');
    if (title) title.innerText = 'Create Free Account';
    if (subtitle) subtitle.innerText = 'Register with your name, email & password in seconds';
  }
}

function openAuthModal(type: 'login' | 'signup' = 'login') {
  clearAuthError();
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.remove('hidden');
  switchAuthTab(type);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function handleGoogleSignIn() {
  clearAuthError();
  try {
    showToast('Connecting with Google...', 'info');
    await signInWithPopup(auth, googleProvider);
    closeModal('auth-modal');
    showToast('Signed in with Google!');
  } catch (error: any) {
    showAuthError(`Google Sign-In: ${error.message || error}`);
  }
}

async function handleSignInSubmit(e: Event) {
  e.preventDefault();
  clearAuthError();

  const emailInput = document.getElementById('auth-login-email') as HTMLInputElement;
  const passInput = document.getElementById('auth-login-password') as HTMLInputElement;
  const btn = document.getElementById('auth-login-btn') as HTMLButtonElement;

  const email = emailInput ? emailInput.value.trim() : '';
  const password = passInput ? passInput.value : '';

  if (!email || !password) {
    showAuthError('Please enter both your email address and password');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<svg class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Signing In...';
  }

  try {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      showToast('Welcome back! Signed in successfully.');
      closeModal('auth-modal');
      return;
    } catch (loginErr: any) {
      // If user not found or invalid credential, seamlessly try auto-creating account if password is valid
      if (loginErr.code === 'auth/invalid-credential' || loginErr.code === 'auth/user-not-found') {
        if (password.length >= 6) {
          try {
            const cred = await createUserWithEmailAndPassword(auth, email, password);
            const derivedName = email.split('@')[0].replace(/[._-]+/g, ' ');
            const formattedName = derivedName.charAt(0).toUpperCase() + derivedName.slice(1);
            try {
              await updateProfile(cred.user, { displayName: formattedName });
              await syncUserDoc(cred.user);
            } catch (_) {}
            showToast(`Welcome! Account created for ${email}`, 'success');
            closeModal('auth-modal');
            return;
          } catch (autoCreateErr: any) {
            // If email already in use, then password was indeed incorrect for existing account
            if (autoCreateErr.code === 'auth/email-already-in-use') {
              showAuthError('Incorrect password for this account. Please verify your password or sign in with Google.');
              return;
            }
            throw autoCreateErr;
          }
        } else {
          showAuthError('Invalid credentials. Password must be at least 6 characters.');
          return;
        }
      } else if (loginErr.code === 'auth/wrong-password') {
        showAuthError('Incorrect password for this account. Please re-enter your password.');
        return;
      } else if (loginErr.code === 'auth/too-many-requests') {
        showAuthError('Too many failed attempts. Please wait a minute or continue with Google.');
        return;
      } else {
        throw loginErr;
      }
    }
  } catch (err: any) {
    showAuthError(err.message || 'Unable to sign in. Please check your credentials or try Google Sign-In.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="log-in" class="w-3.5 h-3.5"></i> Sign In';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

async function handleSignUpSubmit(e: Event) {
  e.preventDefault();
  clearAuthError();

  const nameInput = document.getElementById('auth-signup-name') as HTMLInputElement;
  const emailInput = document.getElementById('auth-signup-email') as HTMLInputElement;
  const passInput = document.getElementById('auth-signup-password') as HTMLInputElement;
  const confirmInput = document.getElementById('auth-signup-confirm-password') as HTMLInputElement;
  const btn = document.getElementById('auth-signup-btn') as HTMLButtonElement;

  const fullName = nameInput ? nameInput.value.trim() : '';
  const email = emailInput ? emailInput.value.trim() : '';
  const password = passInput ? passInput.value : '';
  const confirmPass = confirmInput ? confirmInput.value : '';

  if (!fullName) {
    showAuthError('Please enter your full name');
    return;
  }
  if (!email || !password) {
    showAuthError('Please enter your email and password');
    return;
  }
  if (password.length < 6) {
    showAuthError('Password must be at least 6 characters long');
    return;
  }
  if (password !== confirmPass) {
    showAuthError('Passwords do not match. Please verify your password confirmation.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<svg class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Creating Account...';
  }

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    try {
      await updateProfile(cred.user, { displayName: fullName });
      await syncUserDoc(cred.user);
    } catch (_) {}
    showToast(`Account created! Welcome, ${fullName}!`, 'success');
    closeModal('auth-modal');
  } catch (err: any) {
    if (err.code === 'auth/email-already-in-use') {
      showAuthError('An account already exists with this email. Please switch to "Sign In".');
      switchAuthTab('login');
      const loginEmail = document.getElementById('auth-login-email') as HTMLInputElement;
      if (loginEmail) loginEmail.value = email;
    } else {
      showAuthError(err.message || 'Registration failed. Please check your details.');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="user-plus" class="w-3.5 h-3.5"></i> Create Free Account';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

// Fallback compatibility
async function handleEmailAuthSubmit(e: Event) {
  handleSignInSubmit(e);
}

async function handleUserLogout() {
  try {
    await firebaseSignOut(auth);
    showToast('Signed out successfully');
    navigateTo('home');
  } catch (err) {
    console.error('Logout error:', err);
  }
}

function closeModal(modalId: string) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('hidden');
}

// =============================================================================
// TOAST
// =============================================================================

function showToast(msg: string, type: 'success' | 'error' | 'info' | 'warning' = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  const iconName = type === 'error' ? 'alert-circle' : type === 'warning' ? 'alert-triangle' : type === 'info' ? 'info' : 'check-circle-2';
  const iconColor = type === 'error' ? 'text-rose-400' : type === 'warning' ? 'text-amber-400' : type === 'info' ? 'text-blue-400' : 'text-emerald-400';
  toast.className = 'bg-slate-900 text-white px-4 py-2.5 rounded-xl text-xs font-bold shadow-2xl flex items-center gap-2 border border-slate-700 pointer-events-auto';
  toast.innerHTML = `<i data-lucide="${iconName}" class="w-4 h-4 ${iconColor}"></i> <span>${msg}</span>`;
  container.appendChild(toast);
  if (typeof lucide !== 'undefined') lucide.createIcons();
  setTimeout(() => { toast.remove(); }, 3500);
}

// =============================================================================
// TYPEWRITER
// =============================================================================

let typewriterPhrases = [
  "Create a Ganesh Chaturthi gold poster with volumetric lights...",
  "Diwali festival celebration vector greeting with oil lamps...",
  "Hyperrealistic cyberpunk city in heavy rain, 8k resolution...",
  "Modern luxury real estate flyer mockup, minimal architecture...",
  "Cute 3D Pixar style character standing in enchanted forest...",
  "High conversion SaaS landing page hero prompt for ChatGPT..."
];
let typewriterIndex = 0;
let charIndex = 0;
let isDeleting = false;
let typewriterSpeed = 80;

function initTypewriter() {
  const el = document.getElementById('hero-typewriter-text');
  if (!el) return;

  // Respect user's accessibility preference — no animation if motion is reduced
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.innerText = typewriterPhrases[0];
    return;
  }

  const currentPhrase = typewriterPhrases[typewriterIndex];
  if (isDeleting) { charIndex--; typewriterSpeed = 40; }
  else { charIndex++; typewriterSpeed = 70; }
  el.innerText = currentPhrase.substring(0, charIndex);
  if (!isDeleting && charIndex === currentPhrase.length) { isDeleting = true; typewriterSpeed = 2200; }
  else if (isDeleting && charIndex === 0) {
    isDeleting = false;
    typewriterIndex = (typewriterIndex + 1) % typewriterPhrases.length;
    typewriterSpeed = 400;
  }
  setTimeout(initTypewriter, typewriterSpeed);
}


// =============================================================================
// UI HELPERS
// =============================================================================

function scrollToSection(sectionId: string) {
  if (activeView !== 'home') navigateTo('home');
  setTimeout(() => {
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }, 100);
}

function toggleMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (menu) menu.classList.toggle('hidden');
}

function openAiAssistantModal() {
  const modal = document.getElementById('ai-assistant-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeAiAssistantModal() {
  const modal = document.getElementById('ai-assistant-modal');
  if (modal) modal.classList.add('hidden');
}

function generateAiPromptAssist() {
  const ideaEl = document.getElementById('ai-assist-idea') as HTMLInputElement;
  const toolEl = document.getElementById('ai-assist-tool') as HTMLSelectElement;
  const styleEl = document.getElementById('ai-assist-style') as HTMLSelectElement;
  const idea = ideaEl ? ideaEl.value.trim() : '';
  const tool = toolEl ? toolEl.value : 'Midjourney v6.1';
  const style = styleEl ? styleEl.value : 'Photorealistic 8k';
  if (!idea) { showToast('Please enter your concept idea'); return; }
  const generatedPrompt = `High quality ${style} rendering of ${idea}. Masterpiece, hyperdetailed, volumetric lighting, octanerender, 8k resolution, award winning visuals, cinematic depth of field, vivid color accuracy --v 6.1 --ar 16:9`;
  closeAiAssistantModal();
  openAddPromptModal();
  const titleInput = document.getElementById('form-title') as HTMLInputElement;
  const toolInput = document.getElementById('form-tool') as HTMLSelectElement;
  const textInput = document.getElementById('form-prompt-text') as HTMLTextAreaElement;
  if (titleInput) titleInput.value = `${idea.slice(0, 30)} (${style})`;
  if (toolInput) toolInput.value = tool.includes('Midjourney') ? 'Midjourney' : tool.includes('ChatGPT') ? 'ChatGPT' : 'Flux';
  if (textInput) textInput.value = generatedPrompt;
  showToast('AI Prompt generated! Review and save to gallery.');
}

function handleLiveSearchInput(query: string) {
  const autocompleteEl = document.getElementById('search-autocomplete');
  const resultsEl = document.getElementById('autocomplete-results');
  if (!autocompleteEl || !resultsEl) return;
  if (!query || query.trim().length === 0) {
    autocompleteEl.classList.add('hidden');
    return;
  }
  const q = query.toLowerCase().trim();
  const matches = prompts
    .filter(p => {
      const allText = [p.title, p.prompt, p.category, p.tool, ...(p.tags || [])].join(' ').toLowerCase();
      return allText.includes(q) && (p.status === 'approved' || currentUserRole === 'admin');
    })
    .map(p => ({ ...p, _score: computeRankScore(p, q) }))
    .sort((a, b) => (b._score ?? 0) - (a._score ?? 0))
    .slice(0, 5);

  if (matches.length === 0) {
    resultsEl.innerHTML = `<div class="px-4 py-3 text-xs text-slate-400 font-medium">No matching prompts found</div>`;
  } else {
    resultsEl.innerHTML = matches.map(p => `
      <div onclick="openPromptDetail('${p.id}'); document.getElementById('search-autocomplete').classList.add('hidden');" class="px-4 py-2.5 hover:bg-slate-50 cursor-pointer flex items-center justify-between border-b border-slate-100 last:border-0 transition">
        <div class="flex items-center gap-3">
          <img src="${p.image}" class="w-8 h-8 rounded-lg object-cover" loading="lazy" />
          <div>
            <p class="text-xs font-bold text-slate-800 line-clamp-1">${p.title}</p>
            <p class="text-[10px] text-slate-400 font-medium">${p.tool} • ${p.category}</p>
          </div>
        </div>
        <i data-lucide="chevron-right" class="w-4 h-4 text-slate-300"></i>
      </div>
    `).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
  autocompleteEl.classList.remove('hidden');
}

function resetSearchFilters() {
  const mainInput = document.getElementById('main-search-page-input') as HTMLInputElement;
  const catSelect = document.getElementById('search-category-select') as HTMLSelectElement;
  const toolSelect = document.getElementById('search-tool-select') as HTMLSelectElement;
  if (mainInput) mainInput.value = '';
  if (catSelect) catSelect.value = 'all';
  if (toolSelect) toolSelect.value = 'all';
  triggerSearchFilter();
  showToast('Search filters cleared');
}

function toggleSelectAllAdminPrompts(checked: boolean) {
  document.querySelectorAll('.admin-select-cb').forEach((cb: any) => { cb.checked = checked; });
}

function openPromptModal(id: string) {
  let p = findPromptById(id);
  if (!p && prompts.length > 0) p = prompts[0];
  if (!p) return;
  currentSelectedPrompt = p;
  const setSrc = (id: string, src: string) => { const el = document.getElementById(id) as HTMLImageElement; if (el) el.src = src; };
  const set = (id: string, val: string) => { const el = document.getElementById(id); if (el) el.innerText = val; };
  setSrc('modal-image', p.image);
  set('modal-tool', p.tool);
  set('modal-category', p.category);
  set('modal-title', p.title);
  set('modal-prompt-text', p.prompt);
  set('modal-negative-prompt', p.negative || 'None specified');
  set('modal-creator-name', p.creator);
  set('modal-creator-avatar', p.creator ? p.creator.charAt(0).toUpperCase() : 'C');
  set('modal-like-count', formatNumber(p.likes || 0));
  const modal = document.getElementById('prompt-modal');
  if (modal) modal.classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function copyModalPrompt() {
  if (currentSelectedPrompt) {
    navigator.clipboard.writeText(currentSelectedPrompt.prompt);
    updateDoc(doc(db, 'prompts', currentSelectedPrompt.id), { copyCount: increment(1) }).catch(() => {});
    incrementCopiedTodayCounter();
    showToast('Prompt copied to clipboard!');
  }
}

function toggleBookmarkCurrent() {
  if (currentSelectedPrompt) toggleBookmarkCard(currentSelectedPrompt.id);
}

// =============================================================================
// SEASONAL THEME
// =============================================================================

function getSeasonalKeywords(themeKey: string): string[] {
  const theme = EVENT_THEMES[themeKey];
  if (!theme || !theme.chips) return [];
  return theme.chips.map(c => c.query.toLowerCase());
}

function applyThemeUI(themeKey: string) {
  const theme = EVENT_THEMES[themeKey];
  if (!theme) return;

  const heroSec = document.getElementById('hero-section');
  if (heroSec) heroSec.className = `relative pt-8 pb-12 lg:pt-12 lg:pb-16 overflow-hidden transition-all duration-700 ${theme.bgClass}`;

  const badge = document.getElementById('hero-event-badge');
  if (badge) badge.innerText = theme.badge;

  document.querySelectorAll('.event-theme-btn').forEach(btn => {
    btn.className = 'event-theme-btn px-3 py-1 rounded-full text-slate-600 hover:text-slate-900 transition flex items-center gap-1 font-semibold';
  });
  const activeBtn = document.getElementById(`event-btn-${themeKey}`);
  if (activeBtn) activeBtn.className = 'event-theme-btn px-3 py-1 rounded-full transition flex items-center gap-1 bg-blue-600 text-white shadow-sm font-bold';

  const chipsContainer = document.getElementById('hero-popular-chips');
  if (chipsContainer && theme.chips) {
    chipsContainer.innerHTML = theme.chips.map(c => `
      <button onclick="quickSearch('${c.query}')" class="px-3 py-1.5 rounded-full bg-white hover:bg-slate-100 text-slate-800 font-medium border border-slate-200/90 shadow-sm transition transform hover:scale-105 flex items-center gap-1">
        ${c.text}
      </button>
    `).join('');
  }
}

function setEventTheme(themeKey: string) {
  const theme = EVENT_THEMES[themeKey];
  if (!theme) return;
  currentEventTheme = themeKey;
  applyThemeUI(themeKey);
  // Re-rank gallery and trending with new seasonal boost
  renderGalleryFromCache();
  renderTrendingPromptsFromCache();
  showToast(`${themeKey === 'ai_core' ? '⚡ AI Core' : themeKey.charAt(0).toUpperCase() + themeKey.slice(1)} theme active`);
}

function switchAdminTab(tabName: string) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('bg-white', 'text-blue-600', 'shadow-sm'));
  const activeTab = document.getElementById(`admin-tab-${tabName}`);
  if (activeTab) activeTab.classList.add('bg-white', 'text-blue-600', 'shadow-sm');
  document.getElementById('admin-panel-prompts')?.classList.add('hidden');
  document.getElementById('admin-panel-categories')?.classList.add('hidden');
  document.getElementById('admin-panel-analytics')?.classList.add('hidden');
  document.getElementById(`admin-panel-${tabName}`)?.classList.remove('hidden');

  // Render tab-specific content on switch
  if (tabName === 'analytics') renderAdminAnalytics();
  if (tabName === 'categories') renderAdminCategoriesPanel();
}

// =============================================================================
// ADMIN ANALYTICS — Real Firestore-derived metrics
// =============================================================================

function renderAdminAnalytics() {
  const displayPrompts = adminAllPrompts.length > 0 ? adminAllPrompts : prompts;
  if (displayPrompts.length === 0) return;

  // Summary cards
  const summaryEl = document.getElementById('admin-analytics-summary');
  if (summaryEl) {
    const total = displayPrompts.length;
    const totalViews = displayPrompts.reduce((s, p) => s + (p.views || 0), 0);
    const totalLikes = displayPrompts.reduce((s, p) => s + (p.likes || 0), 0);
    const totalCopies = displayPrompts.reduce((s, p) => s + (p.copyCount || 0), 0);
    const featured = displayPrompts.filter(p => p.featured).length;
    const trending = displayPrompts.filter(p => p.trending).length;

    summaryEl.innerHTML = [
      { label: 'Total Prompts', val: total, color: 'text-slate-900' },
      { label: 'Total Views', val: formatNumber(totalViews), color: 'text-blue-600' },
      { label: 'Total Likes', val: formatNumber(totalLikes), color: 'text-rose-500' },
      { label: 'Total Copies', val: formatNumber(totalCopies), color: 'text-amber-600' },
      { label: 'Featured', val: featured, color: 'text-yellow-600' },
      { label: 'Trending', val: trending, color: 'text-orange-600' },
      { label: 'Approved', val: displayPrompts.filter(p => p.status === 'approved').length, color: 'text-emerald-600' },
      { label: 'Pending', val: displayPrompts.filter(p => p.status === 'pending').length, color: 'text-amber-600' },
    ].map(s => `
      <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <span class="text-[10px] text-slate-500 font-bold uppercase tracking-wider">${s.label}</span>
        <div class="text-2xl font-extrabold ${s.color} mt-1">${s.val}</div>
      </div>
    `).join('');
  }

  // Top 5 prompts by views
  const topViewsEl = document.getElementById('admin-top-prompts-views');
  if (topViewsEl) {
    const topByViews = [...displayPrompts]
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 5);

    topViewsEl.innerHTML = topByViews.map((p, i) => `
      <div class="px-4 py-2.5 flex items-center gap-3">
        <span class="w-5 h-5 rounded-full bg-slate-100 text-slate-500 font-extrabold text-[10px] flex items-center justify-center shrink-0">${i + 1}</span>
        <img src="${p.image}" alt="" class="w-8 h-8 rounded-lg object-cover shrink-0" loading="lazy" width="32" height="32" />
        <div class="flex-1 min-w-0">
          <div class="font-bold text-slate-800 truncate">${p.title}</div>
          <div class="text-[10px] text-slate-400">${p.tool} \u00b7 ${p.category}</div>
        </div>
        <div class="text-right shrink-0">
          <div class="font-extrabold text-blue-600">${formatNumber(p.views || 0)}</div>
          <div class="text-[10px] text-slate-400">views</div>
        </div>
      </div>
    `).join('');
  }

  // Tool distribution
  const toolDistEl = document.getElementById('admin-tool-distribution');
  if (toolDistEl) {
    const toolCounts: Record<string, number> = {};
    displayPrompts.forEach(p => { toolCounts[p.tool] = (toolCounts[p.tool] || 0) + 1; });
    const maxTool = Math.max(...Object.values(toolCounts));
    const sorted = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

    toolDistEl.innerHTML = sorted.map(([tool, count]) => `
      <div class="flex items-center gap-2 text-[11px]">
        <span class="w-24 font-semibold text-slate-700 truncate shrink-0">${tool}</span>
        <div class="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
          <div class="h-full bg-blue-500 rounded-full transition-all" style="width:${Math.round((count / maxTool) * 100)}%"></div>
        </div>
        <span class="font-bold text-slate-600 shrink-0 w-6 text-right">${count}</span>
      </div>
    `).join('');
  }

  // Category distribution
  const catDistEl = document.getElementById('admin-category-distribution');
  if (catDistEl) {
    const catCounts: Record<string, number> = {};
    displayPrompts.forEach(p => { catCounts[p.category] = (catCounts[p.category] || 0) + 1; });
    const maxCat = Math.max(...Object.values(catCounts));
    const sorted = Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

    catDistEl.innerHTML = sorted.map(([cat, count]) => `
      <div class="flex items-center gap-2 text-[11px]">
        <span class="w-24 font-semibold text-slate-700 truncate shrink-0">${cat}</span>
        <div class="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
          <div class="h-full bg-indigo-500 rounded-full transition-all" style="width:${Math.round((count / maxCat) * 100)}%"></div>
        </div>
        <span class="font-bold text-slate-600 shrink-0 w-6 text-right">${count}</span>
      </div>
    `).join('');
  }

  // Recent activity (last 10 by createdAt)
  const recentEl = document.getElementById('admin-recent-activity');
  if (recentEl) {
    const recent = [...displayPrompts]
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
      .slice(0, 10);

    if (recent.length === 0) {
      recentEl.innerHTML = `<div class="px-4 py-6 text-center text-slate-400 text-xs">No activity data available</div>`;
    } else {
      recentEl.innerHTML = recent.map(p => {
        const date = p.createdAt?.seconds
          ? new Date(p.createdAt.seconds * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
          : 'Unknown date';
        const statusColor = p.status === 'approved' ? 'text-emerald-600 bg-emerald-50' : p.status === 'rejected' ? 'text-rose-600 bg-rose-50' : 'text-amber-600 bg-amber-50';
        return `
          <div class="px-4 py-2.5 flex items-center gap-3">
            <img src="${p.image}" alt="" class="w-8 h-8 rounded-lg object-cover shrink-0" loading="lazy" width="32" height="32" />
            <div class="flex-1 min-w-0">
              <div class="font-bold text-slate-800 truncate">${p.title}</div>
              <div class="text-[10px] text-slate-400">${p.tool} \u00b7 ${p.category} \u00b7 ${date}</div>
            </div>
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${statusColor}">${p.status || 'pending'}</span>
          </div>
        `;
      }).join('');
    }
  }
}

// =============================================================================
// ADMIN CATEGORIES PANEL — Live list with delete
// =============================================================================

function renderAdminCategoriesPanel() {
  const listEl = document.getElementById('admin-categories-list');
  if (!listEl) return;

  if (categories.length === 0) {
    listEl.innerHTML = `<div class="col-span-full text-center text-sm text-slate-400 py-8">No categories yet. Add one above.</div>`;
    return;
  }

  listEl.innerHTML = categories.map(c => `
    <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
          <i data-lucide="${c.icon || 'folder'}" class="w-4 h-4"></i>
        </div>
        <div>
          <div class="font-bold text-slate-800 text-sm">${c.name}</div>
          <div class="text-[10px] text-slate-400">${c.count || 0} prompts</div>
        </div>
      </div>
      <button onclick="deleteCategoryAdmin('${c.id}')" aria-label="Delete ${c.name} category" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>
    </div>
  `).join('');

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// ADMIN FEATURED / TRENDING TOGGLES
// =============================================================================

function renderAdminTable() {
  // Stub function to prevent compilation/runtime error in app.ts
}

async function toggleFeaturedAdmin(id: string) {
  const p = findPromptById(id);
  if (!p) return;
  const newVal = !p.featured;
  try {
    await updateDoc(doc(db, 'prompts', id), { featured: newVal, updatedAt: serverTimestamp() });
    // Update local cache
    const target = adminAllPrompts.find(x => x.id === id) || prompts.find(x => x.id === id);
    if (target) target.featured = newVal;
    renderAdminTable();
    showToast(newVal ? '⭐ Prompt marked as Featured' : 'Featured removed');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `prompts/${id}`);
  }
}

async function toggleTrendingAdmin(id: string) {
  const p = findPromptById(id);
  if (!p) return;
  const newVal = !p.trending;
  try {
    await updateDoc(doc(db, 'prompts', id), { trending: newVal, updatedAt: serverTimestamp() });
    const target = adminAllPrompts.find(x => x.id === id) || prompts.find(x => x.id === id);
    if (target) target.trending = newVal;
    renderAdminTable();
    showToast(newVal ? '🔥 Prompt marked as Trending' : 'Trending removed');
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `prompts/${id}`);
  }
}


function copyAiAssistPrompt() {
  const outputTextEl = document.getElementById('ai-assist-output-text');
  if (outputTextEl && outputTextEl.innerText) {
    navigator.clipboard.writeText(outputTextEl.innerText);
    showToast('AI engineered prompt copied to clipboard!');
  } else {
    showToast('No generated prompt to copy yet');
  }
}

// =============================================================================
// RELATED PROMPTS — MULTI-FACTOR RELEVANCE SCORING
// =============================================================================

async function renderRelatedPromptsAsync(currentPrompt: PromptItem) {
  const container = document.getElementById('detail-related-prompts-grid');
  if (!container) return;
  renderLoadingSkeleton(container, 3);

  try {
    // Fetch same-category approved prompts
    const catQ = query(
      collection(db, 'prompts'),
      where('status', '==', 'approved'),
      where('category', '==', currentPrompt.category),
      limit(10)
    );
    const catSnap = await getDocs(catQ);
    let candidates = catSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem))
      .filter(p => p.id !== currentPrompt.id);

    // Also fetch same-tool prompts if we need more candidates
    if (candidates.length < 4) {
      try {
        const toolQ = query(
          collection(db, 'prompts'),
          where('status', '==', 'approved'),
          where('tool', '==', currentPrompt.tool),
          limit(6)
        );
        const toolSnap = await getDocs(toolQ);
        const toolCandidates = toolSnap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem))
          .filter(p => p.id !== currentPrompt.id && !candidates.some(c => c.id === p.id));
        candidates = [...candidates, ...toolCandidates];
      } catch { /* use what we have */ }
    }

    // Extend with local cache if still thin
    const seenIds = new Set([currentPrompt.id, ...candidates.map(c => c.id)]);
    const cacheExtras = prompts.filter(p => !seenIds.has(p.id) && p.status === 'approved');
    candidates = dedupePrompts([...candidates, ...cacheExtras]).slice(0, 20);

    // Score by multi-factor relevance
    const seasonalKeywords = getSeasonalKeywords(currentEventTheme);
    const currentTags = [...(currentPrompt.tags || []), ...(currentPrompt.seasonalTags || [])];

    const scored = candidates.map(p => {
      let score = 0;
      if (p.category === currentPrompt.category) score += 100; // Same category
      if (p.tool === currentPrompt.tool) score += 80;          // Same AI tool

      // Shared tags / seasonal tags overlap
      const pTags = [...(p.tags || []), ...(p.seasonalTags || [])];
      const sharedTagCount = currentTags.filter(t => pTags.includes(t)).length;
      score += sharedTagCount * 40;

      // Seasonal keyword match
      const textToSearch = `${p.title} ${p.category} ${p.prompt} ${pTags.join(' ')}`.toLowerCase();
      const seasonalMatchCount = seasonalKeywords.filter(k => textToSearch.includes(k)).length;
      if (seasonalMatchCount > 0) score += 60 + (seasonalMatchCount - 1) * 20;

      // Popularity boost (normalized, so viral prompts are slightly preferred)
      score += Math.min(50, computeBaseScore(p) / 200);

      return { ...p, _score: score };
    }).sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

    const top3 = scored.slice(0, 3);
    if (top3.length === 0) {
      renderEmptyState(container, 'No related prompts found', 'Explore other categories for inspiration');
      return;
    }
    container.innerHTML = top3.map(p => createPromptCardHTML(p)).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();

  } catch (err) {
    console.warn('Related prompts Firestore query failed — using cache:', err);
    renderRelatedPromptsFromCache(currentPrompt);
  }
}

function renderRelatedPromptsFromCache(currentPrompt: PromptItem) {
  const container = document.getElementById('detail-related-prompts-grid');
  if (!container) return;

  const candidates = dedupePrompts([...prompts])
    .filter(p => p.id !== currentPrompt.id && p.status === 'approved');

  const scored = candidates.map(p => {
    let score = 0;
    if (p.category === currentPrompt.category) score += 100;
    if (p.tool === currentPrompt.tool) score += 80;
    score += computeRankScore(p, '') * 0.01;
    return { ...p, _score: score };
  }).sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

  const top3 = scored.slice(0, 3);
  if (top3.length === 0) {
    renderEmptyState(container, 'No related prompts found');
    return;
  }
  container.innerHTML = top3.map(p => createPromptCardHTML(p)).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// RECOMMENDATION SECTIONS — CANONICAL RANKING
// =============================================================================

function renderRecommendationSections(currentPrompt: PromptItem) {
  const allAvailable = dedupePrompts([...prompts])
    .filter(p => p.id !== currentPrompt.id && (p.status === 'approved' || currentUserRole === 'admin'));

  const fillSection = (id: string, items: PromptItem[], emptyMsg: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (items.length === 0) {
      renderEmptyState(el, emptyMsg);
    } else {
      el.innerHTML = items.map(p => createPromptCardHTML(p)).join('');
    }
  };

  // Trending Today — trending flag + full rank score
  const trending = allAvailable
    .filter(p => p.trending)
    .map(p => ({ ...p, _score: computeRankScore(p, '') }))
    .sort((a, b) => (b._score ?? 0) - (a._score ?? 0))
    .slice(0, 3);
  const trendingItems = trending.length > 0 ? trending :
    allAvailable.map(p => ({ ...p, _score: computeRankScore(p, '') }))
      .sort((a, b) => (b._score ?? 0) - (a._score ?? 0)).slice(0, 3);
  fillSection('rec-trending-today', trendingItems, 'No trending prompts yet');

  // People Also Viewed — highest views
  const byViews = [...allAvailable].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3);
  fillSection('rec-people-viewed', byViews, 'No view data yet');

  // Recently Added — by createdAt timestamp desc
  const byRecent = [...allAvailable]
    .sort((a, b) => ((b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)))
    .slice(0, 3);
  const recentItems = byRecent.length > 0 ? byRecent : [...allAvailable].slice(0, 3);
  fillSection('rec-recently-added', recentItems, 'No recent prompts');

  // Recommended For You — full canonical ranking
  const recommended = allAvailable
    .map(p => ({ ...p, _score: computeRankScore(p, '') }))
    .sort((a, b) => (b._score ?? 0) - (a._score ?? 0))
    .slice(0, 3);
  fillSection('rec-recommended-for-you', recommended, 'No recommendations yet');

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// SIDEBAR WIDGETS (DETAIL PAGE) — Firestore-driven
// =============================================================================

async function renderSidebarWidgets() {
  // 1. Trending Categories — from in-memory Firestore cache
  const catContainer = document.getElementById('sidebar-trending-categories');
  if (catContainer) {
    if (categories.length > 0) {
      catContainer.innerHTML = categories.slice(0, 5).map(c => `
        <div onclick="quickSearch('${c.name.replace(/'/g, "\\'")}')"
             class="flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 cursor-pointer transition">
          <div class="flex items-center gap-2.5">
            <div class="w-6 h-6 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <i data-lucide="${c.icon || 'folder'}" class="w-3.5 h-3.5"></i>
            </div>
            <span class="text-xs font-bold text-slate-800">${c.name}</span>
          </div>
          ${c.count > 0 ? `<span class="text-[10px] font-semibold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">${c.count}+</span>` : ''}
        </div>
      `).join('');
    } else {
      catContainer.innerHTML = `<div class="py-4 text-center text-slate-400"><i data-lucide="folder" class="w-6 h-6 mx-auto mb-1"></i><p class="text-xs">No categories yet</p></div>`;
    }
  }

  // 2. Popular AI Tools — from Firestore aiTools collection
  const toolsContainer = document.getElementById('sidebar-popular-tools');
  if (toolsContainer) {
    try {
      const toolsSnap = await getDocs(query(collection(db, 'aiTools'), orderBy('name'), limit(6)));
      if (!toolsSnap.empty) {
        toolsContainer.innerHTML = toolsSnap.docs.map(d => {
          const t = d.data() as any;
          // Count matching prompts from in-memory cache
          const matchCount = prompts.filter(p => p.tool === t.name).length;
          return `
            <div onclick="quickSearch('${(t.name || '').replace(/'/g, "\\'")}')"
                 class="flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 cursor-pointer transition">
              <div class="flex items-center gap-2.5">
                <i data-lucide="${t.icon || 'cpu'}" class="w-4 h-4 text-blue-600"></i>
                <span class="text-xs font-bold text-slate-800">${t.name}</span>
              </div>
              ${matchCount > 0 ? `<span class="text-[10px] font-semibold text-slate-400">${matchCount} prompts</span>` : ''}
            </div>
          `;
        }).join('');
      } else {
        toolsContainer.innerHTML = `<div class="py-4 text-center text-slate-400"><i data-lucide="cpu" class="w-6 h-6 mx-auto mb-1"></i><p class="text-xs">No AI tools configured</p></div>`;
      }
    } catch (_) {
      toolsContainer.innerHTML = `<div class="py-3 text-center text-slate-400 text-xs">Tools unavailable</div>`;
    }
  }

  // 3. Top Creators — derived from real Firestore prompt data only
  const creatorsContainer = document.getElementById('sidebar-top-creators');
  if (creatorsContainer) {
    const creatorMap: Record<string, number> = {};
    dedupePrompts([...prompts, ...adminAllPrompts]).forEach(p => {
      if (p.creator) creatorMap[p.creator] = (creatorMap[p.creator] || 0) + (p.likes || 0);
    });
    const topCreators = Object.entries(creatorMap)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, likes]) => ({ name, likes }));
    if (topCreators.length > 0) {
      creatorsContainer.innerHTML = topCreators.map(c => `
        <div class="flex items-center justify-between p-2 rounded-2xl bg-slate-50/60 border border-slate-100">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-extrabold text-xs flex items-center justify-center shadow-sm">
              ${c.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <h4 class="text-xs font-bold text-slate-900">${c.name}</h4>
              <p class="text-[10px] text-slate-400 font-medium">${formatNumber(c.likes)} likes</p>
            </div>
          </div>
        </div>
      `).join('');
    } else {
      creatorsContainer.innerHTML = `<div class="py-4 text-center text-slate-400"><i data-lucide="users" class="w-6 h-6 mx-auto mb-1"></i><p class="text-xs">No creators yet</p></div>`;
    }
  }

  // 4. & 5. Collections — from Firestore, split by category type
  const renderCollectionSidebar = async (containerId: string, categoryFilter?: string) => {
    const containerEl = document.getElementById(containerId);
    if (!containerEl) return;
    try {
      let q = categoryFilter
        ? query(collection(db, 'collections'), where('category', '==', categoryFilter), orderBy('order', 'asc'), limit(3))
        : query(collection(db, 'collections'), orderBy('order', 'asc'), limit(3));
      const snap = await getDocs(q);
      if (!snap.empty) {
        containerEl.innerHTML = snap.docs.map(d => {
          const col = d.data() as any;
          const imgHtml = col.imageUrl
            ? `<img src="${col.imageUrl}" class="w-9 h-9 rounded-lg object-cover shrink-0" loading="lazy" />`
            : `<div class="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0"><i data-lucide="layers" class="w-4 h-4 text-blue-400"></i></div>`;
          const count = col.promptCount ? `${col.promptCount} Prompts` : '';
          return `
            <div onclick="quickSearch('${(col.name || '').replace(/'/g, "\\'")}')"
                 class="flex items-center gap-3 p-2 rounded-xl hover:bg-slate-50 cursor-pointer transition border border-slate-100">
              ${imgHtml}
              <div>
                <h5 class="text-xs font-bold text-slate-900">${col.name || ''}</h5>
                ${count ? `<p class="text-[10px] text-slate-400 font-medium">${count}</p>` : ''}
              </div>
            </div>
          `;
        }).join('');
        if (typeof lucide !== 'undefined') lucide.createIcons();
        return;
      }
    } catch (_) {}
    containerEl.innerHTML = `<div class="py-4 text-center text-slate-400"><i data-lucide="layers" class="w-6 h-6 mx-auto mb-1"></i><p class="text-xs">No collections yet</p></div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  };

  await renderCollectionSidebar('sidebar-festival-collections', 'Festivals');
  await renderCollectionSidebar('sidebar-business-collections', 'Business');

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// WINDOW GLOBAL FUNCTIONS (for inline onclick handlers in index.html)
// =============================================================================

function attachWindowGlobalFunctions() {
  const w = window as any;
  w.quickSearch = quickSearch;
  w.executeSearch = executeSearch;
  w.triggerSearchFilter = triggerSearchFilter;
  w.filterByTool = filterByTool;
  w.filterBySort = filterBySort;
  w.copyAiAssistPrompt = copyAiAssistPrompt;
  w.openPromptDetail = openPromptDetail;
  w.openPromptModal = openPromptModal;
  w.toggleBookmarkCard = toggleBookmarkCard;
  w.toggleBookmarkCurrentDetail = toggleBookmarkCard;
  w.toggleBookmarkCurrent = toggleBookmarkCurrent;
  w.toggleLikeCard = toggleLikeCard;
  w.toggleLikeCurrent = toggleLikeCurrent;
  w.downloadPrompt = downloadPrompt;
  w.downloadCurrentPrompt = downloadCurrentPrompt;
  w.navigateTo = navigateTo;
  w.scrollToSection = scrollToSection;
  w.toggleMobileMenu = toggleMobileMenu;
  w.handleLiveSearchInput = handleLiveSearchInput;
  w.loadMorePrompts = loadMorePrompts;
  w.resetSearchFilters = resetSearchFilters;
  w.copyModalPrompt = copyModalPrompt;
  w.openAuthModal = openAuthModal;
  w.switchAuthTab = switchAuthTab;
  w.handleSignInSubmit = handleSignInSubmit;
  w.handleSignUpSubmit = handleSignUpSubmit;
  w.handleGoogleSignIn = handleGoogleSignIn;
  w.handleEmailAuthSubmit = handleEmailAuthSubmit;
  w.handleUserLogout = handleUserLogout;
  w.toggleUserDropdownMenu = toggleUserDropdownMenu;
  w.closeUserDropdownMenu = closeUserDropdownMenu;
  w.closeModal = closeModal;
  w.showToast = showToast;
  w.openUserSubmitModal = openUserSubmitModal;
  w.openAddPromptModal = openAddPromptModal;
  w.handleSavePromptForm = handleSavePromptForm;
  w.handleUserImageUpload = handleUserMultiImageUpload;
  w.uploadUserImageButton = uploadUserMultiImageButton;
  w.handleUserMultiImageUpload = handleUserMultiImageUpload;
  w.uploadUserMultiImageButton = uploadUserMultiImageButton;
  w.addUserImageUrl = addUserImageUrl;
  w.removeUserFormImage = removeUserFormImage;
  w.editUserPrompt = editUserPrompt;
  w.deleteUserPromptConfirm = deleteUserPromptConfirm;
  w.handleContactSubmit = handleContactSubmit;
  w.loadBlogs = loadBlogs;
  w.viewBlogPostDetail = viewBlogPostDetail;
  w.setEventTheme = setEventTheme;

  // Carousel & Image Gallery methods
  w.prevDetailImage = prevDetailImage;
  w.nextDetailImage = nextDetailImage;
  w.setDetailImageIndex = setDetailImageIndex;
  w.openCurrentFullscreenImage = openCurrentFullscreenImage;

  // Copy prompt text from any card — also increments copyCount and copiedToday
  w.copyPromptText = (id: string, e?: Event) => {
    if (e) e.stopPropagation();
    const p = findPromptById(id);
    if (p) {
      navigator.clipboard.writeText(p.prompt);
      updateDoc(doc(db, 'prompts', p.id), { copyCount: increment(1) }).catch(() => {});
      incrementCopiedTodayCounter();
      showToast('Prompt copied!');
    }
  };

  // Copy full prompt from detail page — also increments copyCount and copiedToday
  w.copyCurrentDetailPrompt = () => {
    if (currentSelectedPrompt) {
      navigator.clipboard.writeText(currentSelectedPrompt.prompt);
      updateDoc(doc(db, 'prompts', currentSelectedPrompt.id), { copyCount: increment(1) }).catch(() => {});
      incrementCopiedTodayCounter();
      showToast('Prompt copied to clipboard!');
    }
  };

  w.shareCurrentDetailPrompt = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(window.location.href);
      showToast('Shareable link copied!');
    }
  };

  w.goBackFromPrompt = goBackFromPrompt;
  w.shareOnWhatsApp = shareOnWhatsApp;
  w.renderGalleryTagPills = renderGalleryTagPills;

  // Deep Link AI Generator with Auto Prompt Copy
  w.generateInAITool = () => {
    if (!currentSelectedPrompt) return;
    const promptText = currentSelectedPrompt.prompt;
    const tool = (currentSelectedPrompt.tool || '').toLowerCase();
    
    // Copy the prompt to clipboard
    if (navigator.clipboard) {
      navigator.clipboard.writeText(promptText);
      updateDoc(doc(db, 'prompts', currentSelectedPrompt.id), { copyCount: increment(1) }).catch(() => {});
      incrementCopiedTodayCounter();
    }
    
    let url = 'https://chatgpt.com/';
    if (tool.includes('chatgpt') || tool.includes('gpt')) {
      url = `https://chatgpt.com/?q=${encodeURIComponent(promptText)}`;
    } else if (tool.includes('midjourney')) {
      url = 'https://www.midjourney.com/explore';
    } else if (tool.includes('gemini')) {
      url = 'https://gemini.google.com/app';
    } else if (tool.includes('claude')) {
      url = 'https://claude.ai/new';
    } else if (tool.includes('flux')) {
      url = 'https://flux.ai/generate';
    } else if (tool.includes('ideogram')) {
      url = 'https://ideogram.ai/create';
    } else if (tool.includes('leonardo')) {
      url = 'https://leonardo.ai';
    }
    
    showToast(`Prompt copied to clipboard! Opening ${currentSelectedPrompt.tool}...`, 'success');
    window.open(url, '_blank');
  };
}

// Attach immediately on module load so inline onclick handlers work before DOMContentLoaded
attachWindowGlobalFunctions();
