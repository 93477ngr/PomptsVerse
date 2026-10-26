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
}


// =============================================================================
// APP STATE
// =============================================================================

// Home page cache — approved prompts only, paginated from Firestore
let prompts: PromptItem[] = [];
let adminAllPrompts: PromptItem[] = [];

let categories: CategoryItem[] = [];
let bookmarks: string[] = [];
let userLikes: string[] = [];
let currentSelectedPrompt: PromptItem | null = null;
let activeView = 'home';
let currentUser: User | null = null;
let currentUserRole: 'admin' | 'user' = 'user';
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
        helpers.setProperty('og:site_name', data.brandName || 'PromptsOne');

        // Twitter Cards
        helpers.setMeta('twitter:card', data.twitterCard || 'summary_large_image');
        helpers.setMeta('twitter:title', data.ogTitle || data.seoTitle || '');
        helpers.setMeta('twitter:description', data.ogDescription || data.metaDescription || '');
        helpers.setMeta('twitter:image', data.ogImage || data.logoUrl || '');
        helpers.setMeta('twitter:url', canonicalVal);
        
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

    // 5. Contact Desk Settings
    const contactSettingsRef = doc(db, 'settings', 'contact');
    onSnapshot(contactSettingsRef, (snap) => {
      const setEl = (id: string, text: string) => { const el = document.getElementById(id); if (el) el.textContent = text; };
      const twitterEl = document.getElementById('footer-social-twitter') as HTMLAnchorElement;
      const linkedinEl = document.getElementById('footer-social-linkedin') as HTMLAnchorElement;
      const discordEl = document.getElementById('footer-social-discord') as HTMLAnchorElement;
      const iframe = document.getElementById('contact-page-map') as HTMLIFrameElement;
      const submitBtn = document.getElementById('contact-submit-btn') as HTMLButtonElement;

      if (snap.exists()) {
        const data = snap.data();
        setEl('footer-phone', data.phone || '');
        setEl('footer-email', data.email || '');
        setEl('footer-address', data.address || '');
        setEl('footer-hours', data.businessHours || '');

        if (twitterEl) twitterEl.href = data.twitter || '#';
        if (linkedinEl) linkedinEl.href = data.linkedin || '#';
        if (discordEl) discordEl.href = data.discord || '#';

        setEl('contact-page-phone', data.phone || '');
        setEl('contact-page-email', data.email || '');
        setEl('contact-page-address', data.address || '');
        setEl('contact-page-hours', data.businessHours || '');

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
        setEl('footer-phone', '');
        setEl('footer-email', '');
        setEl('footer-address', '');
        setEl('footer-hours', '');
        if (twitterEl) twitterEl.href = '#';
        if (linkedinEl) linkedinEl.href = '#';
        if (discordEl) discordEl.href = '#';
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'settings/contact');
    });
  } catch (err) {
    console.warn('Error loading site configs:', err);
  }
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

  let q;
  if (currentSortType === 'newest') {
    q = query(collection(db, 'prompts'), where('status', '==', 'approved'), orderBy('createdAt', 'desc'), limit(HOME_PAGE_LIMIT));
  } else if (currentSortType === 'likes') {
    q = query(collection(db, 'prompts'), where('status', '==', 'approved'), orderBy('likes', 'desc'), limit(HOME_PAGE_LIMIT));
  } else if (currentSortType === 'trending') {
    q = query(collection(db, 'prompts'), where('status', '==', 'approved'), where('trending', '==', true), orderBy('likes', 'desc'), limit(HOME_PAGE_LIMIT));
  } else {
    q = query(collection(db, 'prompts'), where('status', '==', 'approved'), orderBy('views', 'desc'), limit(HOME_PAGE_LIMIT));
  }

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
    hasMorePrompts = snapshot.docs.length === HOME_PAGE_LIMIT;

    updateLoadMoreButton();
    renderGalleryFromCache();
    renderTrendingPromptsFromCache();
    renderHeroVisualPanels(prompts);
    renderLiveAITrendsTicker(prompts);
  }, (err) => {
    console.warn('Initial prompts listener error, falling back:', err);
    const fallbackQ = query(collection(db, 'prompts'), where('status', '==', 'approved'), limit(HOME_PAGE_LIMIT));
    getDocs(fallbackQ).then(fallbackSnap => {
      isInitialLoading = false;
      if (fallbackSnap.empty) {
        prompts = [];
        renderEmptyState(document.getElementById('prompts-grid'), 'No prompts found in the database', 'Be the first to share a premium AI prompt!');
        return;
      }
      prompts = fallbackSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem));
      lastVisibleDoc = fallbackSnap.docs[fallbackSnap.docs.length - 1] ?? null;
      hasMorePrompts = fallbackSnap.docs.length === HOME_PAGE_LIMIT;
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
        <div class="relative w-full h-52 sm:h-56 overflow-hidden bg-slate-900 border-b border-slate-100 group/img flex items-center justify-center">
          <img src="${optimizeImageUrl(p.image)}" alt="" class="absolute inset-0 w-full h-full object-cover blur-xl opacity-30 pointer-events-none" />
          <img src="${optimizeImageUrl(p.image)}" alt="${p.title}" 
               class="relative z-10 w-full h-full object-cover object-top block group-hover/img:scale-105 transition-transform duration-500 opacity-0" 
               loading="lazy" 
               onload="this.classList.remove('opacity-0');"
               onerror="this.style.display='none';" />
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

function renderAuthUI() {
  const authContainer = document.getElementById('navbar-auth-section');
  if (!authContainer) return;

  if (currentUser) {
    const avatarLetter = (currentUser.displayName || currentUser.email || 'U').charAt(0).toUpperCase();
    const photoURL = currentUser.photoURL;
    const name = currentUser.displayName || currentUser.email?.split('@')[0] || 'Creator';

    authContainer.innerHTML = `
      <div class="flex items-center gap-2 sm:gap-2.5">
        <button onclick="navigateTo('dashboard')" class="px-2.5 sm:px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-200/80 text-xs font-bold rounded-xl transition flex items-center gap-1.5 shadow-sm">
          <i data-lucide="layout-dashboard" class="w-3.5 h-3.5"></i> <span class="hidden sm:inline">Dashboard</span>
        </button>
        <div class="flex items-center gap-2 px-2.5 sm:px-3 py-1.5 bg-white border border-slate-200/90 rounded-xl shadow-sm text-xs font-bold text-slate-800">
          ${photoURL 
            ? `<img src="${photoURL}" class="w-6 h-6 rounded-full object-cover border border-slate-200 shrink-0" alt="${name}" onerror="this.outerHTML='<div class=\\'w-6 h-6 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white flex items-center justify-center text-[10px] font-extrabold shrink-0\\'>${avatarLetter}</div>'" />` 
            : `<div class="w-6 h-6 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white flex items-center justify-center text-[10px] font-extrabold shrink-0 shadow-sm">${avatarLetter}</div>`
          }
          <span class="max-w-[70px] sm:max-w-[110px] truncate text-slate-900 font-bold">${name}</span>
        </div>
        <button onclick="handleUserLogout()" class="p-1.5 sm:p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition" title="Logout" aria-label="Logout">
          <i data-lucide="log-out" class="w-4 h-4"></i>
        </button>
      </div>
    `;
  } else {
    authContainer.innerHTML = `
      <button onclick="openAuthModal('login')" class="px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-extrabold text-xs rounded-xl shadow-md transition flex items-center gap-1.5">
        <i data-lucide="user" class="w-3.5 h-3.5"></i> Sign In / Join
      </button>
    `;
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// =============================================================================
// ROUTING & NAVIGATION
// =============================================================================

window.addEventListener('hashchange', handleHashRouting);

function handleHashRouting() {
  const hash = window.location.hash;
  if (hash.startsWith('#prompt/')) {
    const promptId = hash.replace('#prompt/', '');
    openPromptDetail(promptId, false);
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
  } else if (hash === '#home' || hash === '') {
    navigateTo('home');
  }
}

function navigateTo(viewName: string) {
  activeView = viewName;
  document.querySelectorAll('.view-panel').forEach(el => el.classList.add('hidden'));
  const targetView = document.getElementById(`view-${viewName}`);
  if (targetView) targetView.classList.remove('hidden');

  const stickyBar = document.getElementById('mobile-prompt-sticky-bar');
  if (stickyBar) {
    if (viewName === 'details') stickyBar.classList.remove('hidden');
    else stickyBar.classList.add('hidden');
  }

  // Update hash dynamically for deep link/refresh routing
  if (window.location.hash !== `#${viewName}` && !(viewName === 'home' && !window.location.hash)) {
    if (viewName === 'home') {
      window.history.pushState(null, '', window.location.pathname + window.location.search);
    } else {
      window.location.hash = `#${viewName}`;
    }
  }

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.remove('bg-blue-50', 'text-blue-600', 'font-semibold');
    btn.classList.add('text-slate-600');
  });
  const activeNavBtn = document.getElementById(`nav-${viewName}`);
  if (activeNavBtn) {
    activeNavBtn.classList.add('bg-blue-50', 'text-blue-600', 'font-semibold');
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
  }
}

function openUserSubmitModal() {
  if (!currentUser) {
    openAuthModal('login');
    return;
  }
  openAddPromptModal();
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
  (document.getElementById('form-image-url') as HTMLInputElement).value = p.image || '';
  (document.getElementById('form-prompt-text') as HTMLTextAreaElement).value = p.prompt || '';
  (document.getElementById('form-negative-prompt') as HTMLTextAreaElement).value = p.negative || '';
  (document.getElementById('form-tags') as HTMLInputElement).value = (p.tags || []).join(', ');
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
          <p>Any prompt graphics or sponsor logos uploaded via our interface are transferred to and stored securely on Cloudinary CDN services.</p>

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
  return `
    <div class="bg-white rounded-2xl border border-slate-200/90 shadow-card hover:shadow-card-hover hover:-translate-y-1 transition duration-300 overflow-hidden group flex flex-col justify-between cursor-pointer" onclick="openPromptDetail('${p.id}')">
      <div>
        <div class="relative w-full h-56 sm:h-64 overflow-hidden bg-slate-900 border-b border-slate-100 group/img flex items-center justify-center">
          <img src="${imgUrl}" alt="" class="absolute inset-0 w-full h-full object-cover blur-xl opacity-30 pointer-events-none" />
          <img src="${imgUrl}" alt="${p.title}" 
               class="relative z-10 w-full h-full object-cover object-top block group-hover/img:scale-105 transition-transform duration-500 opacity-0" 
               loading="lazy" 
               onload="this.classList.remove('opacity-0');"
               onerror="this.style.display='none';" />
          <div class="absolute top-2.5 left-2.5 z-20 flex items-center gap-1.5 flex-wrap">
            <span class="px-2 py-0.5 rounded-md bg-black/70 text-white font-bold text-[10px] backdrop-blur-md border border-white/10 shadow-sm flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span> ${p.tool}
            </span>
            <span class="px-2 py-0.5 rounded-md bg-white/90 text-slate-800 font-bold text-[10px] backdrop-blur-md shadow-sm">
              ${p.category}
            </span>
          </div>
          <button onclick="event.stopPropagation(); toggleBookmarkCard('${p.id}', event)" class="absolute top-2.5 right-2.5 z-20 p-1.5 rounded-lg bg-white/90 hover:bg-white text-slate-700 shadow-sm transition backdrop-blur-sm" title="Bookmark Prompt">
            <i data-lucide="bookmark" class="w-3.5 h-3.5 ${isBookmarked ? 'text-amber-500 fill-amber-500' : 'text-slate-400'}"></i>
          </button>
        </div>
        <div class="p-3.5 space-y-2">
          <h3 class="font-bold text-xs text-slate-900 line-clamp-1 group-hover:text-blue-600 transition">${p.title}</h3>
          <p class="text-[11px] text-slate-500 font-mono line-clamp-2 bg-slate-50 p-2 rounded-lg border border-slate-100/80">${p.prompt}</p>
        </div>
      </div>
      <div class="px-3.5 pb-3.5 pt-2 flex items-center justify-between border-t border-slate-100 text-xs">
        <span class="text-slate-400 font-medium text-[11px]">By ${p.creator}</span>
        <button onclick="copyPromptText('${p.id}', event)" class="px-2.5 py-1 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg font-bold text-[11px] flex items-center gap-1 transition" title="Copy Prompt">
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
// PROMPT DETAIL PAGE
// =============================================================================

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

  // Populate all detail page elements
  const set = (id: string, val: string) => { const el = document.getElementById(id); if (el) el.innerText = val; };
  const setHTML = (id: string, val: string) => { const el = document.getElementById(id); if (el) el.innerHTML = val; };
  const setSrc = (id: string, src: string) => { const el = document.getElementById(id) as HTMLImageElement; if (el) el.src = src; };

  set('detail-breadcrumb-category', p.category);
  set('detail-breadcrumb-title', p.title);
  setSrc('detail-image', p.image);
  setSrc('detail-image-bg', p.image);
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

  // Output samples — show complete uncropped image
  const outputSamplesEl = document.getElementById('detail-output-samples');
  if (outputSamplesEl) {
    const imgUrl = optimizeImageUrl(p.image);
    if (imgUrl) {
      outputSamplesEl.innerHTML = `
        <div class="group relative rounded-2xl overflow-hidden bg-slate-950 shadow-sm col-span-full h-80 flex items-center justify-center">
          <img src="${imgUrl}" alt="" class="absolute inset-0 w-full h-full object-cover blur-xl opacity-30 pointer-events-none" />
          <img src="${imgUrl}" alt="${p.title}" class="relative z-10 max-w-full max-h-full object-contain p-2 group-hover:scale-[1.02] transition duration-500" loading="lazy" />
          <span class="absolute bottom-2 left-2 z-20 px-2 py-0.5 rounded bg-black/60 text-white text-[10px] font-bold backdrop-blur-md">Sample Output</span>
        </div>
      `;
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
  const optionsHtml = categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  if (select) select.innerHTML = optionsHtml;
  if (searchCatSelect) searchCatSelect.innerHTML = `<option value="all">All Categories</option>` + optionsHtml;
}

// =============================================================================
// AUTH HANDLERS
// =============================================================================

function openAuthModal(type: 'login' | 'signup') {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.remove('hidden');
  const title = document.getElementById('auth-title');
  if (title) title.innerText = type === 'login' ? 'Login to PromptVerse' : 'Create Free Account';
}

async function handleGoogleSignIn() {
  try {
    showToast('Connecting with Google...');
    await signInWithPopup(auth, googleProvider);
    closeModal('auth-modal');
    showToast('Signed in with Google!');
  } catch (error: any) {
    console.error('Google Sign-In Error:', error);
    showToast(`Google Sign-In failed: ${error.message || error}`);
  }
}

async function handleEmailAuthSubmit(e: Event) {
  e.preventDefault();
  const emailInput = document.getElementById('auth-email-input') as HTMLInputElement;
  const passInput = document.getElementById('auth-password-input') as HTMLInputElement;
  const email = emailInput ? emailInput.value.trim() : '';
  const password = passInput ? passInput.value : '';
  if (!email || !password) { showToast('Please enter email and password'); return; }
  try {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      showToast('Logged in successfully!');
    } catch (loginErr: any) {
      if (loginErr.code === 'auth/user-not-found' || loginErr.code === 'auth/invalid-credential') {
        await createUserWithEmailAndPassword(auth, email, password);
        showToast('Account created and logged in!');
      } else { throw loginErr; }
    }
    closeModal('auth-modal');
  } catch (err: any) {
    console.error('Authentication Error:', err);
    showToast(`Authentication failed: ${err.message || err}`);
  }
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

function showToast(msg: string) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'bg-slate-900 text-white px-4 py-2.5 rounded-xl text-xs font-bold shadow-2xl flex items-center gap-2 border border-slate-700 pointer-events-auto';
  toast.innerHTML = `<i data-lucide="check-circle-2" class="w-4 h-4 text-emerald-400"></i> <span>${msg}</span>`;
  container.appendChild(toast);
  if (typeof lucide !== 'undefined') lucide.createIcons();
  setTimeout(() => { toast.remove(); }, 3000);
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
  w.handleGoogleSignIn = handleGoogleSignIn;
  w.handleEmailAuthSubmit = handleEmailAuthSubmit;
  w.handleUserLogout = handleUserLogout;
  w.closeModal = closeModal;
  w.showToast = showToast;
  w.openUserSubmitModal = openUserSubmitModal;
  w.openAddPromptModal = openAddPromptModal;
  w.editUserPrompt = editUserPrompt;
  w.deleteUserPromptConfirm = deleteUserPromptConfirm;
  w.handleContactSubmit = handleContactSubmit;
  w.loadBlogs = loadBlogs;
  w.viewBlogPostDetail = viewBlogPostDetail;
  w.setEventTheme = setEventTheme;

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

  w.generateInAITool = () => {
    if (!currentSelectedPrompt) return;
    const tool = currentSelectedPrompt.tool.toLowerCase();
    let url = 'https://chatgpt.com';
    if (tool.includes('midjourney')) url = 'https://www.midjourney.com';
    else if (tool.includes('gemini')) url = 'https://gemini.google.com';
    else if (tool.includes('claude')) url = 'https://claude.ai';
    else if (tool.includes('flux')) url = 'https://flux.ai';
    else if (tool.includes('ideogram')) url = 'https://ideogram.ai';
    else if (tool.includes('leonardo')) url = 'https://leonardo.ai';
    window.open(url, '_blank');
  };
}

// Attach immediately on module load so inline onclick handlers work before DOMContentLoaded
attachWindowGlobalFunctions();
