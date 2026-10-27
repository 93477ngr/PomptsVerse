import { 
  auth, 
  db, 
  handleFirestoreError, 
  OperationType, 
  syncUserDoc, 
  getUserRole, 
  uploadToCloudinary,
  optimizeCloudinaryUrl,
  testConnection 
} from './firebase';
import { 
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
import {
  escapeHtml,
  escapeAttr,
  safeUrl,
  sanitizeHtml,
  getElementSafe
} from './utils/dom';
import {
  initRouter,
  navigateTo,
  navigateToPath,
  isPromptAlreadyViewedInSession,
  markPromptViewedInSession,
  updateHeadMetadata,
  RouteState
} from './router';
import {
  handleGoogleAuth,
  checkRedirectAuthResult,
  loginWithEmail,
  registerWithEmail,
  requestPasswordReset,
  logoutUser
} from './auth';

import { createIcons, icons } from 'lucide';

// Debounced icon refresh
let iconRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshIcons() {
  if (iconRefreshTimer) clearTimeout(iconRefreshTimer);
  iconRefreshTimer = setTimeout(() => {
    try {
      createIcons({ icons });
    } catch {
      /* ignore icon refresh errors */
    }
  }, 50);
}

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
  copyCount?: number;
  creator: string;
  creatorId?: string;
  featured: boolean;
  trending: boolean;
  status: 'approved' | 'pending' | 'rejected' | 'draft';
  rankScore?: number;
  baseScore?: number;
  seasonalTags?: string[];
  tags?: string[];
  createdAt?: any;
  updatedAt?: any;
  _score?: number;
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

let prompts: PromptItem[] = [];
let categories: CategoryItem[] = [];
let bookmarks: string[] = [];
let userLikes: string[] = [];
let currentSelectedPrompt: PromptItem | null = null;
let activeView = 'home';
let currentUser: User | null = null;
let currentUserRole: 'admin' | 'user' = 'user';
let isAuthLoading = true;
let authModalMode: 'login' | 'signup' = 'login';

let unsubscribeBookmarks: (() => void) | null = null;
let unsubscribeLikes: (() => void) | null = null;
let unsubscribePrompts: (() => void) | null = null;

// Pagination & Filters
let lastVisibleDoc: QueryDocumentSnapshot<DocumentData> | null = null;
let isLoadingMore = false;
let hasMorePrompts = true;
let isInitialLoading = true;
const HOME_PAGE_LIMIT = 100; // Load up to 100 approved prompts into live memory
const LOAD_MORE_LIMIT = 24;
let currentSortType = 'popular';
let currentToolFilter = 'all';
let currentCategoryFilter = 'all';

const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80';

async function incrementCopiedTodayCounter() {
  try {
    const statsRef = doc(db, 'siteConfigs', 'stats');
    await setDoc(statsRef, { copiedToday: increment(1) }, { merge: true });
  } catch (_) {
    /* silent */
  }
}

// =============================================================================
// INITIALIZATION
// =============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  // Check redirect login results for mobile Google auth
  checkRedirectAuthResult().catch(() => {});

  testConnection();
  setupAuthListener();

  // Initialize History API Router
  initRouter(handleRouteStateChange);

  // Load configs, categories & real-time prompts
  loadCategoriesListener();
  loadInitialPrompts();
  loadTrendingPrompts();

  // Init delegated event listeners
  setupDelegatedClickListeners();
  setupFormEventListeners();

  // Initialize Ads
  initAdsSystem().catch(err => console.warn('[Ads Notice]', err));

  // Ambient cursor glow — fine pointer devices only
  if (window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)').matches) {
    document.addEventListener('mousemove', (e) => {
      const glow = getElementSafe('cursor-glow');
      if (glow) {
        glow.style.transform = `translate(${e.clientX - 120}px, ${e.clientY - 120}px)`;
      }
    });
  }

  attachWindowGlobalFunctions();
});

// =============================================================================
// ROUTER CALLBACK
// =============================================================================

function handleRouteStateChange(route: RouteState) {
  activeView = route.view;

  // Protect dashboard route
  if (activeView === 'dashboard' && !currentUser && !isAuthLoading) {
    showToast('Please sign in to access your Creator Workspace');
    openAuthModal('login');
    navigateTo('home', { push: false });
    return;
  }

  // Update active view panel visibility
  document.querySelectorAll('.view-panel').forEach(panel => {
    panel.classList.add('hidden');
  });

  const activePanel = getElementSafe(`view-${activeView}`);
  if (activePanel) {
    activePanel.classList.remove('hidden');
  } else {
    const notFoundPanel = getElementSafe('view-notFound');
    if (notFoundPanel) notFoundPanel.classList.remove('hidden');
  }

  // Update active nav button styles
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.remove('bg-[#e8f5ec]', 'text-[#1a5c2a]', 'font-bold');
    btn.classList.add('text-[#5a7260]');
  });
  const currentNav = getElementSafe(`nav-${activeView}`);
  if (currentNav) {
    currentNav.classList.add('bg-[#e8f5ec]', 'text-[#1a5c2a]', 'font-bold');
    currentNav.classList.remove('text-[#5a7260]');
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Handle route-specific data rendering
  if (activeView === 'details' && route.params.id) {
    openPromptDetailById(route.params.id);
  } else if (activeView === 'search') {
    if (route.query.q) {
      const mainInput = getElementSafe<HTMLInputElement>('main-search-page-input');
      if (mainInput) mainInput.value = route.query.q;
    }
    triggerSearchFilter();
    renderSearchAds();
  } else if (activeView === 'dashboard') {
    renderUserDashboardSubmissions();
  } else if (activeView === 'blog') {
    loadBlogsList();
  } else if (activeView === 'blog-detail' && route.params.slug) {
    loadBlogDetail(route.params.slug);
  } else if (activeView === 'docs') {
    renderDocsFAQ();
  }

  refreshIcons();
}

// =============================================================================
// AUTHENTICATION LISTENER & UI
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
      if (unsubscribeBookmarks) { unsubscribeBookmarks(); unsubscribeBookmarks = null; }
      if (unsubscribeLikes) { unsubscribeLikes(); unsubscribeLikes = null; }
    }

    renderAuthUI();
    renderGalleryFromCache();
    if (activeView === 'dashboard') renderUserDashboardSubmissions();
  });
}

function renderAuthUI() {
  const container = getElementSafe('navbar-auth-section');
  if (!container) return;

  if (isAuthLoading) {
    container.innerHTML = `<div class="w-20 h-8 bg-[#e8f5ec] rounded-lg animate-pulse"></div>`;
    return;
  }

  if (currentUser) {
    const initial = (currentUser.displayName || currentUser.email || 'U').charAt(0).toUpperCase();
    container.innerHTML = `
      <div class="flex items-center gap-2">
        <a href="/dashboard" data-nav="/dashboard" class="px-3 py-1.5 text-xs font-bold text-[#1a5c2a] bg-[#e8f5ec] hover:bg-[#cce8d4] rounded-lg transition flex items-center gap-1.5">
          <i data-lucide="plus-circle" class="w-3.5 h-3.5"></i> Workspace
        </a>
        ${currentUserRole === 'admin' ? `
          <a href="/admin" target="_blank" class="px-3 py-1.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition flex items-center gap-1.5">
            <i data-lucide="shield" class="w-3.5 h-3.5"></i> Admin
          </a>
        ` : ''}
        <div class="relative group">
          <button class="w-9 h-9 rounded-full bg-[#1a5c2a] text-white font-extrabold text-sm flex items-center justify-center shadow-xs">
            ${escapeHtml(initial)}
          </button>
          <div class="absolute right-0 mt-2 w-48 bg-white rounded-2xl shadow-xl border border-[#dde8df] py-2 hidden group-hover:block z-50">
            <div class="px-4 py-2 border-b border-[#dde8df]">
              <p class="text-xs font-bold text-[#1a2e1e] truncate">${escapeHtml(currentUser.displayName || 'User')}</p>
              <p class="text-[10px] text-[#5a7260] truncate">${escapeHtml(currentUser.email || '')}</p>
            </div>
            <a href="/dashboard" data-nav="/dashboard" class="block px-4 py-2 text-xs text-[#1a2e1e] hover:bg-[#e8f5ec] font-semibold">My Submissions</a>
            <button id="auth-logout-btn" class="w-full text-left px-4 py-2 text-xs text-rose-600 hover:bg-rose-50 font-semibold">Sign Out</button>
          </div>
        </div>
      </div>
    `;

    const logoutBtn = getElementSafe('auth-logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogoutAction);
  } else {
    container.innerHTML = `
      <button id="nav-login-btn" class="px-3.5 py-2 text-sm font-semibold text-[#5a7260] hover:text-[#1a2e1e] hover:bg-[#e8f5ec]/60 rounded-lg transition">
        Login
      </button>
      <button id="nav-signup-btn" class="px-4 py-2 text-sm font-bold text-white bg-[#2d8a45] hover:bg-[#1a5c2a] rounded-lg shadow-sm shadow-[#2d8a45]/30 transition flex items-center gap-1.5 btn-shimmer">
        Sign Up
      </button>
    `;

    const loginBtn = getElementSafe('nav-login-btn');
    const signupBtn = getElementSafe('nav-signup-btn');
    if (loginBtn) loginBtn.addEventListener('click', () => openAuthModal('login'));
    if (signupBtn) signupBtn.addEventListener('click', () => openAuthModal('signup'));
  }

  refreshIcons();
}

async function handleLogoutAction() {
  await logoutUser();
  showToast('Signed out successfully');
  navigateTo('home');
}

// =============================================================================
// FIRESTORE DATA FETCHING — Real-Time Approved Prompts Engine
// =============================================================================

function loadInitialPrompts() {
  isInitialLoading = true;

  const grid = getElementSafe('prompts-grid');
  renderLoadingSkeleton(grid, 12);

  if (unsubscribePrompts) {
    unsubscribePrompts();
    unsubscribePrompts = null;
  }

  const q = query(
    collection(db, 'prompts'),
    where('status', '==', 'approved'),
    orderBy('createdAt', 'desc'),
    limit(HOME_PAGE_LIMIT)
  );

  // Subscribe to real-time updates so admin/dashboard additions show immediately!
  unsubscribePrompts = onSnapshot(q, (snapshot) => {
    isInitialLoading = false;
    if (snapshot.empty) {
      prompts = [];
      renderEmptyState(grid, 'No approved prompts found', 'Be the first to submit or approve an engineered prompt!');
      return;
    }
    prompts = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem));
    lastVisibleDoc = snapshot.docs[snapshot.docs.length - 1] ?? null;
    hasMorePrompts = snapshot.docs.length >= HOME_PAGE_LIMIT;

    updateLoadMoreButton();
    renderGalleryFromCache();
    if (activeView === 'search') triggerSearchFilter();
  }, (err) => {
    console.warn('[Firestore Query Notice] Falling back to standard query:', err);
    const fallbackQ = query(collection(db, 'prompts'), where('status', '==', 'approved'), limit(HOME_PAGE_LIMIT));
    getDocs(fallbackQ).then(fallbackSnap => {
      isInitialLoading = false;
      prompts = fallbackSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem));
      updateLoadMoreButton();
      renderGalleryFromCache();
      if (activeView === 'search') triggerSearchFilter();
    }).catch(fallbackErr => {
      console.error('Fallback query error:', fallbackErr);
      isInitialLoading = false;
    });
  });
}

function loadCategoriesListener() {
  onSnapshot(collection(db, 'categories'), (snapshot) => {
    if (snapshot.empty) return;
    categories = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as CategoryItem[];
    
    renderCategoryPills();
    populateCategoryDropdowns();
  }, (err) => {
    console.warn('Categories listener notice:', err);
  });
}

function populateCategoryDropdowns() {
  const optionsHtml = categories.map(c => `<option value="${escapeAttr(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  
  const searchSelect = getElementSafe<HTMLSelectElement>('search-category-select');
  const formSelect = getElementSafe<HTMLSelectElement>('form-category');

  if (searchSelect) {
    searchSelect.innerHTML = `<option value="all">All Categories</option>` + optionsHtml;
  }
  if (formSelect) {
    formSelect.innerHTML = optionsHtml;
  }
}

function loadTrendingPrompts() {
  const container = getElementSafe('trending-prompts-container');
  if (!container) return;

  const q = query(collection(db, 'prompts'), where('status', '==', 'approved'), where('trending', '==', true), limit(6));
  getDocs(q).then(snapshot => {
    if (snapshot.empty) return;
    const trendingList = snapshot.docs.map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem));
    renderTrendingPromptsUI(container, trendingList);
  }).catch(() => {});
}

function renderTrendingPromptsUI(container: HTMLElement, list: PromptItem[]) {
  container.innerHTML = list.map(p => `
    <div class="bg-white rounded-2xl border border-[#dde8df] shadow-card hover:shadow-card-hover transition duration-300 overflow-hidden group cursor-pointer flex flex-col justify-between" data-prompt-id="${escapeAttr(p.id)}">
      <div>
        <div class="relative w-full h-48 overflow-hidden bg-[#1a2e1e] flex items-center justify-center">
          <img src="${escapeAttr(safeUrl(p.image))}" alt="" class="absolute inset-0 w-full h-full object-cover blur-xl opacity-30 pointer-events-none" aria-hidden="true" />
          <img src="${escapeAttr(safeUrl(p.image))}" alt="${escapeAttr(p.title)}" class="relative z-10 w-full h-full object-cover group-hover:scale-105 transition duration-500" loading="lazy" draggable="false" />
          <span class="absolute top-2 left-2 z-20 px-2 py-0.5 rounded bg-white/90 font-bold text-[10px] text-[#1a2e1e]">${escapeHtml(p.tool)}</span>
        </div>
        <div class="p-3">
          <h4 class="font-bold text-xs text-[#1a2e1e] line-clamp-1">${escapeHtml(p.title)}</h4>
        </div>
      </div>
      <div class="p-3 pt-0 flex items-center justify-between text-[11px] text-[#5a7260]">
        <span><i data-lucide="eye" class="inline w-3 h-3 text-[#2d8a45]"></i> ${p.views || 0}</span>
        <span class="text-[#d95d1e]"><i data-lucide="heart" class="inline w-3 h-3"></i> ${p.likes || 0}</span>
      </div>
    </div>
  `).join('');
  refreshIcons();
}

function listenToUserBookmarks(uid: string) {
  if (unsubscribeBookmarks) unsubscribeBookmarks();
  unsubscribeBookmarks = onSnapshot(collection(db, 'users', uid, 'bookmarks'), (snapshot) => {
    bookmarks = snapshot.docs.map(d => d.id);
  }, () => {});
}

function listenToUserLikes(uid: string) {
  if (unsubscribeLikes) unsubscribeLikes();
  unsubscribeLikes = onSnapshot(collection(db, 'users', uid, 'likes'), (snapshot) => {
    userLikes = snapshot.docs.map(d => d.id);
  }, () => {});
}

// =============================================================================
// GALLERY RENDERING & CARDS
// =============================================================================

function renderGalleryFromCache() {
  const grid = getElementSafe('prompts-grid');
  if (!grid) return;

  let pool = [...prompts];

  // Tool filter
  if (currentToolFilter !== 'all') {
    pool = pool.filter(p => p.tool.toLowerCase().trim() === currentToolFilter.toLowerCase().trim());
  }

  // Category filter
  if (currentCategoryFilter !== 'all') {
    pool = pool.filter(p => p.category.toLowerCase().trim() === currentCategoryFilter.toLowerCase().trim());
  }

  // Sorting
  if (currentSortType === 'newest') {
    pool.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  } else if (currentSortType === 'likes') {
    pool.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  } else if (currentSortType === 'trending') {
    pool.sort((a, b) => (b.trending ? 1 : 0) - (a.trending ? 1 : 0) || (b.likes || 0) - (a.likes || 0));
  } else {
    pool.sort((a, b) => (b.views || 0) - (a.views || 0));
  }

  if (pool.length === 0) {
    renderEmptyState(
      grid, 
      currentCategoryFilter !== 'all' ? `No prompts found in "${currentCategoryFilter}" category` : 'No matching prompts found', 
      'Try selecting "All Categories" or adjusting your search filters'
    );
    return;
  }

  grid.innerHTML = pool.map(p => createPromptCardHTML(p)).join('');
  injectFeedAds('prompts-grid', 8);
  setupAdObservers();
  refreshIcons();
}

export function createPromptCardHTML(p: PromptItem): string {
  const isBookmarked = bookmarks.includes(p.id);
  const isLiked = userLikes.includes(p.id);

  return `
    <div class="bg-white rounded-2xl overflow-hidden border border-[#dde8df] shadow-card hover:shadow-card-hover transition-all duration-300 group flex flex-col justify-between relative" data-prompt-id="${escapeAttr(p.id)}" tabindex="0" role="link">
      <a href="/prompt/${escapeAttr(p.id)}" data-nav="/prompt/${escapeAttr(p.id)}" class="block flex-1">
        <div class="relative aspect-[4/3] overflow-hidden bg-[#1a2e1e] flex items-center justify-center">
          <img src="${escapeAttr(safeUrl(p.image))}" alt="" class="absolute inset-0 w-full h-full object-cover blur-xl opacity-30 pointer-events-none" aria-hidden="true" />
          <img src="${escapeAttr(safeUrl(p.image))}" alt="${escapeAttr(p.title)}" 
               class="relative z-10 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
               loading="lazy" 
               draggable="false" 
               onerror="this.onerror=null; this.src='${FALLBACK_IMAGE}';" />
          <span class="absolute top-2 left-2 z-20 px-2.5 py-0.5 rounded-md bg-white/90 backdrop-blur-md text-[#1a2e1e] font-bold text-[10px] shadow-sm">
            ${escapeHtml(p.tool)}
          </span>
          ${p.trending ? `<span class="absolute top-2 right-2 z-20 px-2 py-0.5 rounded-md bg-[#d95d1e] text-white font-bold text-[10px]">🔥 Hot</span>` : ''}
        </div>
        <div class="p-3.5 space-y-1.5">
          <div class="flex items-center justify-between text-[10px] text-[#5a7260]">
            <span class="font-bold text-[#1a5c2a] uppercase tracking-wider">${escapeHtml(p.category)}</span>
            <span>By ${escapeHtml(p.creator || 'PromptsOne')}</span>
          </div>
          <h3 class="font-extrabold text-xs text-[#1a2e1e] leading-snug line-clamp-2 group-hover:text-[#2d8a45] transition">${escapeHtml(p.title)}</h3>
          
          <!-- Styled Prompt Monospace Preview Text -->
          <div class="bg-[#f8fafc] p-2.5 rounded-xl border border-[#dde8df] shadow-xs group-hover:border-[#2d8a45]/40 transition">
            <p class="text-[11px] font-mono text-[#1a2e1e] font-medium leading-relaxed line-clamp-2 select-all">${escapeHtml(p.prompt)}</p>
          </div>
        </div>
      </a>
      
      <div class="p-3.5 pt-0 flex items-center justify-between border-t border-[#dde8df]/60 mt-1 text-xs">
        <div class="flex items-center gap-3 text-[11px] font-semibold text-[#5a7260]">
          <span class="flex items-center gap-1"><i data-lucide="eye" class="w-3.5 h-3.5 text-[#2d8a45]"></i> ${p.views || 0}</span>
          <button data-action="like" data-id="${escapeAttr(p.id)}" class="flex items-center gap-1 hover:text-[#d95d1e] transition ${isLiked ? 'text-[#d95d1e] font-bold' : ''}">
            <i data-lucide="heart" class="w-3.5 h-3.5 ${isLiked ? 'fill-current' : ''}"></i> ${p.likes || 0}
          </button>
        </div>
        <div class="flex items-center gap-1.5">
          <button data-action="bookmark" data-id="${escapeAttr(p.id)}" title="Bookmark" class="p-1.5 rounded-lg hover:bg-[#e8f5ec] text-[#5a7260] transition ${isBookmarked ? 'text-[#f5c518]' : ''}">
            <i data-lucide="bookmark" class="w-3.5 h-3.5 ${isBookmarked ? 'fill-current' : ''}"></i>
          </button>
          <button data-action="copy" data-id="${escapeAttr(p.id)}" title="Copy Prompt" class="px-2.5 py-1 bg-[#2d8a45] hover:bg-[#1a5c2a] text-white font-bold text-[11px] rounded-lg transition flex items-center gap-1">
            <i data-lucide="copy" class="w-3 h-3"></i> Copy
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderCategoryPills() {
  const container = getElementSafe('categories-container');
  if (!container) return;

  if (categories.length === 0) {
    container.innerHTML = `<div class="text-xs text-[#5a7260]">Loading categories...</div>`;
    return;
  }

  const allPillActive = currentCategoryFilter === 'all';

  container.innerHTML = `
    <button data-category-pill="all" class="px-3.5 py-2 rounded-xl border text-xs font-bold transition flex items-center gap-1.5 shrink-0 ${allPillActive ? 'bg-[#2d8a45] text-white border-[#2d8a45] shadow-xs' : 'bg-[#f4f7f5] text-[#1a2e1e] border-[#dde8df] hover:bg-[#e8f5ec]'}" >
      <i data-lucide="layout-grid" class="w-3.5 h-3.5"></i> All Prompts
    </button>
    ${categories.map(c => {
      const isActive = currentCategoryFilter.toLowerCase().trim() === c.name.toLowerCase().trim();
      return `
        <button data-category-pill="${escapeAttr(c.name)}" class="px-3.5 py-2 rounded-xl border text-xs font-bold transition flex items-center gap-2 shrink-0 ${isActive ? 'bg-[#2d8a45] text-white border-[#2d8a45] shadow-xs' : 'bg-[#f4f7f5] text-[#1a2e1e] border-[#dde8df] hover:bg-[#e8f5ec]'}" >
          <i data-lucide="${escapeAttr(c.icon || 'folder')}" class="w-3.5 h-3.5"></i>
          ${escapeHtml(c.name)}
        </button>
      `;
    }).join('')}
  `;

  refreshIcons();
}

function renderLoadingSkeleton(container: HTMLElement | null, count = 8) {
  if (!container) return;
  container.innerHTML = Array.from({ length: count }).map(() => `
    <div class="bg-white rounded-2xl p-4 border border-[#dde8df] space-y-3 animate-pulse">
      <div class="w-full h-40 bg-[#e8f5ec] rounded-xl"></div>
      <div class="h-4 bg-[#e8f5ec] rounded w-3/4"></div>
      <div class="h-3 bg-[#e8f5ec] rounded w-1/2"></div>
    </div>
  `).join('');
}

function renderEmptyState(container: HTMLElement | null, title: string, subtitle = '') {
  if (!container) return;
  container.innerHTML = `
    <div class="col-span-full py-12 text-center space-y-2">
      <div class="w-12 h-12 rounded-full bg-[#e8f5ec] text-[#2d8a45] flex items-center justify-center mx-auto text-lg font-bold">!</div>
      <h3 class="text-sm font-bold text-[#1a2e1e]">${escapeHtml(title)}</h3>
      ${subtitle ? `<p class="text-xs text-[#5a7260]">${escapeHtml(subtitle)}</p>` : ''}
    </div>
  `;
}

function updateLoadMoreButton() {
  const btn = getElementSafe('load-more-btn');
  if (!btn) return;
  if (!hasMorePrompts || currentToolFilter !== 'all' || currentCategoryFilter !== 'all') {
    btn.classList.add('hidden');
  } else {
    btn.classList.remove('hidden');
    btn.innerHTML = 'Load More Prompts';
  }
}

// =============================================================================
// PROMPT DETAILS VIEW ENGINE
// =============================================================================

async function openPromptDetailById(id: string) {
  let p = prompts.find(x => x.id === id);

  if (!p) {
    try {
      const snap = await getDoc(doc(db, 'prompts', id));
      if (snap.exists()) {
        p = { id: snap.id, ...(snap.data() as any) } as PromptItem;
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `prompts/${id}`);
    }
  }

  if (!p || (p.status !== 'approved' && currentUserRole !== 'admin' && p.creatorId !== currentUser?.uid)) {
    showToast('Prompt not found or unavailable');
    navigateTo('home', { push: false });
    return;
  }

  currentSelectedPrompt = p;

  // Single view increment guard per session
  if (!isPromptAlreadyViewedInSession(p.id)) {
    markPromptViewedInSession(p.id);
    p.views = (p.views || 0) + 1;
    updateDoc(doc(db, 'prompts', p.id), { views: increment(1) }).catch(() => {});
  }

  updateHeadMetadata('details', `${p.title} — PromptsOne`, p.prompt.slice(0, 160), p.image);

  // Populate Details DOM
  const setTxt = (id: string, val: string) => {
    const el = getElementSafe(id);
    if (el) el.innerText = val;
  };

  setTxt('detail-breadcrumb-title', p.title);
  setTxt('detail-breadcrumb-category', p.category);
  setTxt('detail-title', p.title);
  setTxt('detail-tool-text', p.tool);
  setTxt('detail-creator-name', p.creator || 'PromptsOne Creator');
  setTxt('detail-views', String(p.views || 0));
  setTxt('detail-likes', String(p.likes || 0));
  setTxt('detail-downloads', String(p.downloads || 0));
  setTxt('detail-full-prompt', p.prompt);
  setTxt('detail-negative-text', p.negative || 'None specified');
  setTxt('detail-char-count', `${p.prompt.length} chars`);

  const mainImg = getElementSafe<HTMLImageElement>('detail-image');
  const bgImg = getElementSafe<HTMLImageElement>('detail-image-bg');
  if (mainImg) mainImg.src = safeUrl(p.image);
  if (bgImg) bgImg.src = safeUrl(p.image);

  renderDetailTags(p);
  renderRelatedPrompts(p);
  setupDetailViewButtons(p);

  renderDetailPageAds();
  refreshIcons();
}

function getToolWebsiteUrl(toolName: string): string {
  const t = (toolName || '').toLowerCase().trim();
  if (t.includes('chatgpt') || t.includes('gpt')) return 'https://chatgpt.com';
  if (t.includes('midjourney')) return 'https://www.midjourney.com';
  if (t.includes('flux')) return 'https://fal.ai/models/flux';
  if (t.includes('gemini')) return 'https://gemini.google.com';
  if (t.includes('claude')) return 'https://claude.ai';
  if (t.includes('ideogram')) return 'https://ideogram.ai';
  if (t.includes('leonardo')) return 'https://leonardo.ai';
  if (t.includes('sora')) return 'https://sora.com';
  return 'https://chatgpt.com';
}

function downloadPromptFile(p: PromptItem) {
  const content = `Title: ${p.title}\nTool: ${p.tool}\nCategory: ${p.category}\nCreator: ${p.creator || 'PromptsOne'}\n\nPROMPT:\n${p.prompt}\n\nNEGATIVE PROMPT:\n${p.negative || 'None'}\n\nDownloaded from PromptsOne (https://promptsone.com)`;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${p.title.replace(/[^a-zA-Z0-9_\-]/g, '_')}_prompt.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  p.downloads = (p.downloads || 0) + 1;
  const el = getElementSafe('detail-downloads');
  if (el) el.innerText = String(p.downloads);
  updateDoc(doc(db, 'prompts', p.id), { downloads: increment(1) }).catch(() => {});
  showToast('Prompt file downloaded!');
}

function renderDetailTags(p: PromptItem) {
  const container = getElementSafe('detail-tags-container');
  if (!container) return;
  if (!p.tags || p.tags.length === 0) {
    container.innerHTML = `<span class="text-xs text-[#9ab09e]">No tags</span>`;
    return;
  }
  container.innerHTML = p.tags.map(t => `
    <span class="px-2.5 py-1 bg-[#fff9e6] border border-[#fae8a8] text-[#8c6e00] font-bold text-[11px] rounded-lg">#${escapeHtml(t)}</span>
  `).join('');
}

function renderRelatedPrompts(currentPrompt: PromptItem) {
  const grid = getElementSafe('detail-related-prompts-grid');
  if (!grid) return;

  let related = prompts.filter(p => p.id !== currentPrompt.id && p.status === 'approved' && (p.category === currentPrompt.category || p.tool === currentPrompt.tool));
  if (related.length < 3) {
    const extra = prompts.filter(p => p.id !== currentPrompt.id && p.status === 'approved' && !related.some(r => r.id === p.id));
    related = [...related, ...extra];
  }
  related = related.slice(0, 3);

  if (related.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-xs text-[#5a7260]">No related prompts found.</div>`;
    return;
  }

  grid.innerHTML = related.map(p => createPromptCardHTML(p)).join('');
  refreshIcons();
}

function setupDetailViewButtons(p: PromptItem) {
  const copyBtn = getElementSafe('detail-copy-btn');
  const oneClickCopyBtn = getElementSafe('detail-one-click-copy-btn');
  const likeBtn = getElementSafe('detail-like-btn');
  const bookmarkBtn = getElementSafe('detail-bookmark-btn');
  const waBtn = getElementSafe('detail-whatsapp-btn');
  const downloadBtn = getElementSafe('detail-download-btn');
  const shareBtn = getElementSafe('detail-share-btn');
  const generateBtn = getElementSafe('detail-generate-btn');
  const generateText = getElementSafe('detail-generate-text');

  if (generateText) generateText.innerText = `Generate in ${p.tool || 'AI Tool'}`;

  const doCopy = () => {
    navigator.clipboard.writeText(p.prompt).then(() => {
      p.copyCount = (p.copyCount || 0) + 1;
      updateDoc(doc(db, 'prompts', p.id), { copyCount: increment(1) }).catch(() => {});
      incrementCopiedTodayCounter();
      showToast('Prompt copied to clipboard!');
    }).catch(() => {
      showToast('Failed to copy to clipboard');
    });
  };

  if (copyBtn) copyBtn.onclick = doCopy;
  if (oneClickCopyBtn) oneClickCopyBtn.onclick = doCopy;

  if (likeBtn) {
    const isLiked = userLikes.includes(p.id);
    likeBtn.className = `px-3 py-2.5 ${isLiked ? 'bg-[#d95d1e] text-white border-[#d95d1e]' : 'bg-[#fff2eb] hover:bg-[#ffe5d9] text-[#d95d1e] border-[#fcdad0]'} border font-bold text-xs rounded-2xl flex items-center justify-center gap-1.5 transition`;
    likeBtn.onclick = async () => {
      await toggleLikeCard(p.id);
      const updatedIsLiked = userLikes.includes(p.id);
      p.likes = (p.likes || 0) + (updatedIsLiked ? 1 : -1);
      if (p.likes < 0) p.likes = 0;
      const el = getElementSafe('detail-likes');
      if (el) el.innerText = String(p.likes);
      likeBtn.className = `px-3 py-2.5 ${updatedIsLiked ? 'bg-[#d95d1e] text-white border-[#d95d1e]' : 'bg-[#fff2eb] hover:bg-[#ffe5d9] text-[#d95d1e] border-[#fcdad0]'} border font-bold text-xs rounded-2xl flex items-center justify-center gap-1.5 transition`;
    };
  }

  if (bookmarkBtn) {
    const isSaved = bookmarks.includes(p.id);
    bookmarkBtn.className = `px-3 py-2.5 ${isSaved ? 'bg-[#f5c518] text-[#1a5c2a] border-[#f5c518]' : 'bg-[#fff9e6] hover:bg-[#fff2cc] text-[#8c6e00] border-[#fae8a8]'} border font-bold text-xs rounded-2xl flex items-center justify-center gap-1.5 transition`;
    bookmarkBtn.onclick = async () => {
      await toggleBookmarkCard(p.id);
      const updatedIsSaved = bookmarks.includes(p.id);
      bookmarkBtn.className = `px-3 py-2.5 ${updatedIsSaved ? 'bg-[#f5c518] text-[#1a5c2a] border-[#f5c518]' : 'bg-[#fff9e6] hover:bg-[#fff2cc] text-[#8c6e00] border-[#fae8a8]'} border font-bold text-xs rounded-2xl flex items-center justify-center gap-1.5 transition`;
    };
  }

  if (waBtn) {
    waBtn.onclick = () => {
      const text = `*${p.title}*\n\nPrompt: ${p.prompt}\n\nView on PromptsOne: ${window.location.href}`;
      window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank');
    };
  }

  if (downloadBtn) {
    downloadBtn.onclick = () => downloadPromptFile(p);
  }

  if (shareBtn) {
    shareBtn.onclick = () => {
      if (navigator.share) {
        navigator.share({
          title: p.title,
          text: p.prompt.slice(0, 100),
          url: window.location.href
        }).catch(() => {});
      } else {
        navigator.clipboard.writeText(window.location.href).then(() => {
          showToast('Prompt URL copied to clipboard!');
        });
      }
    };
  }

  if (generateBtn) {
    generateBtn.onclick = () => {
      const url = getToolWebsiteUrl(p.tool);
      window.open(url, '_blank');
    };
  }
}

// =============================================================================
// FORM & CRUD EVENT HANDLERS — Phase 1.3
// =============================================================================

function setupFormEventListeners() {
  const crudForm = getElementSafe<HTMLFormElement>('prompt-crud-form');
  if (crudForm) {
    crudForm.addEventListener('submit', handleSavePromptForm);
  }

  const contactForm = getElementSafe<HTMLFormElement>('contact-form');
  if (contactForm) {
    contactForm.addEventListener('submit', handleContactFormSubmit);
  }

  const authForm = getElementSafe<HTMLFormElement>('email-auth-form');
  if (authForm) {
    authForm.addEventListener('submit', handleEmailAuthFormSubmit);
  }

  const googleAuthBtn = getElementSafe('google-auth-btn');
  if (googleAuthBtn) {
    googleAuthBtn.addEventListener('click', handleGoogleAuthAction);
  }

  const authTabLogin = getElementSafe('auth-tab-login');
  const authTabSignup = getElementSafe('auth-tab-signup');
  if (authTabLogin) authTabLogin.addEventListener('click', () => switchAuthModalMode('login'));
  if (authTabSignup) authTabSignup.addEventListener('click', () => switchAuthModalMode('signup'));

  const forgotBtn = getElementSafe('forgot-password-btn');
  if (forgotBtn) forgotBtn.addEventListener('click', handleForgotPasswordAction);

  const closeAuthBtn = getElementSafe('close-auth-modal-btn');
  if (closeAuthBtn) closeAuthBtn.addEventListener('click', () => closeModal('auth-modal'));

  const closePromptModalBtn = getElementSafe('close-add-prompt-modal-btn');
  const cancelPromptModalBtn = getElementSafe('cancel-add-prompt-btn');
  if (closePromptModalBtn) closePromptModalBtn.addEventListener('click', () => closeModal('add-prompt-modal'));
  if (cancelPromptModalBtn) cancelPromptModalBtn.addEventListener('click', () => closeModal('add-prompt-modal'));

  const mobileToggle = getElementSafe('mobile-menu-toggle');
  if (mobileToggle) mobileToggle.addEventListener('click', toggleMobileMenu);

  const loadMoreBtn = getElementSafe('load-more-btn');
  if (loadMoreBtn) loadMoreBtn.addEventListener('click', handleLoadMoreAction);

  const resetSearchBtn = getElementSafe('reset-search-btn');
  if (resetSearchBtn) resetSearchBtn.addEventListener('click', resetSearchFilters);

  const toolFilterSelect = getElementSafe<HTMLSelectElement>('tool-filter-select');
  if (toolFilterSelect) {
    toolFilterSelect.addEventListener('change', (e) => {
      currentToolFilter = (e.target as HTMLSelectElement).value;
      renderGalleryFromCache();
    });
  }

  const sortSelect = getElementSafe<HTMLSelectElement>('sort-select');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      currentSortType = (e.target as HTMLSelectElement).value;
      renderGalleryFromCache();
    });
  }

  const searchInput = getElementSafe<HTMLInputElement>('hero-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => handleLiveSearchInput((e.target as HTMLInputElement).value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = searchInput.value.trim();
        if (q) navigateTo('search', { query: q });
      }
    });
  }

  const heroSearchBtn = getElementSafe('hero-search-submit');
  if (heroSearchBtn) {
    heroSearchBtn.addEventListener('click', () => {
      const q = searchInput ? searchInput.value.trim() : '';
      if (q) navigateTo('search', { query: q });
    });
  }

  const searchInputPage = getElementSafe<HTMLInputElement>('main-search-page-input');
  if (searchInputPage) {
    searchInputPage.addEventListener('input', triggerSearchFilter);
  }

  const searchCatSelect = getElementSafe<HTMLSelectElement>('search-category-select');
  if (searchCatSelect) {
    searchCatSelect.addEventListener('change', triggerSearchFilter);
  }

  const searchToolSelect = getElementSafe<HTMLSelectElement>('search-tool-select');
  if (searchToolSelect) {
    searchToolSelect.addEventListener('change', triggerSearchFilter);
  }
}

async function handleSavePromptForm(e: Event) {
  e.preventDefault();

  if (!currentUser) {
    showToast('Please sign in to submit a prompt');
    openAuthModal('login');
    return;
  }

  const promptIdInput = getElementSafe<HTMLInputElement>('form-prompt-id');
  const titleInput = getElementSafe<HTMLInputElement>('form-title');
  const toolInput = getElementSafe<HTMLSelectElement>('form-tool');
  const categoryInput = getElementSafe<HTMLSelectElement>('form-category');
  const textInput = getElementSafe<HTMLTextAreaElement>('form-prompt-text');
  const negativeInput = getElementSafe<HTMLTextAreaElement>('form-negative-prompt');
  const tagsInput = getElementSafe<HTMLInputElement>('form-tags');
  const imageUrlInput = getElementSafe<HTMLInputElement>('form-image-url');
  const imageFileInput = getElementSafe<HTMLInputElement>('form-image-file');
  const submitBtn = getElementSafe<HTMLButtonElement>('save-prompt-submit-btn');

  if (!titleInput || !textInput || !toolInput || !categoryInput) return;

  const title = titleInput.value.trim();
  const promptText = textInput.value.trim();
  const tool = toolInput.value;
  const category = categoryInput.value;
  const negative = negativeInput ? negativeInput.value.trim() : '';
  const tagsRaw = tagsInput ? tagsInput.value.trim() : '';
  const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim().slice(0, 30)).filter(Boolean).slice(0, 10) : [];

  // Validation
  if (title.length < 5 || title.length > 120) {
    showToast('Title must be between 5 and 120 characters');
    return;
  }
  if (promptText.length < 10 || promptText.length > 5000) {
    showToast('Prompt text must be between 10 and 5000 characters');
    return;
  }
  if (negative.length > 1000) {
    showToast('Negative prompt must be 1000 characters or less');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="flex items-center gap-2 justify-center"><i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Saving...</span>`;
    refreshIcons();
  }

  try {
    let imageUrl = imageUrlInput ? imageUrlInput.value.trim() : '';
    if (imageFileInput && imageFileInput.files && imageFileInput.files[0]) {
      imageUrl = await uploadToCloudinary(imageFileInput.files[0]);
    }
    if (!imageUrl) imageUrl = FALLBACK_IMAGE;

    const id = promptIdInput ? promptIdInput.value.trim() : '';

    if (id) {
      // Edit existing pending/draft prompt
      const promptRef = doc(db, 'prompts', id);
      await updateDoc(promptRef, {
        title,
        prompt: promptText,
        negative,
        tool,
        category,
        image: imageUrl,
        tags,
        updatedAt: serverTimestamp()
      });
      showToast('Prompt updated successfully!');
    } else {
      // Create new prompt (admin creations are auto-approved; normal user submissions are pending)
      const initialStatus = currentUserRole === 'admin' ? 'approved' : 'pending';
      await addDoc(collection(db, 'prompts'), {
        title,
        prompt: promptText,
        negative,
        tool,
        category,
        image: imageUrl,
        tags,
        creator: currentUser.displayName || currentUser.email?.split('@')[0] || 'PromptVerse Creator',
        creatorId: currentUser.uid,
        status: initialStatus,
        featured: false,
        trending: false,
        views: 0,
        likes: 0,
        downloads: 0,
        copyCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      showToast(initialStatus === 'approved' ? 'Prompt published successfully!' : 'Prompt submitted for review! It will appear after approval.');
    }

    closeModal('add-prompt-modal');
    if (activeView === 'dashboard') renderUserDashboardSubmissions();
  } catch (err: any) {
    console.error('Error saving prompt:', err);
    showToast(`Failed to save prompt: ${err.message || err}`);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Save Prompt';
    }
  }
}

// Delegated click listener for prompt cards & buttons
function setupDelegatedClickListeners() {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Category pills click on Home or Search page
    const catPill = target.closest('[data-category-pill]') as HTMLElement;
    if (catPill) {
      const cat = catPill.dataset.categoryPill || 'all';
      currentCategoryFilter = cat;
      
      if (activeView === 'search') {
        const searchSelect = getElementSafe<HTMLSelectElement>('search-category-select');
        if (searchSelect) searchSelect.value = cat;
        triggerSearchFilter();
      } else {
        renderGalleryFromCache();
        renderCategoryPills();
      }
      return;
    }

    // Card Action buttons
    const actionBtn = target.closest('[data-action]') as HTMLElement;
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      const id = actionBtn.dataset.id;
      if (!id) return;

      if (action === 'copy') {
        const p = prompts.find(x => x.id === id);
        if (p) {
          navigator.clipboard.writeText(p.prompt);
          updateDoc(doc(db, 'prompts', id), { copyCount: increment(1) }).catch(() => {});
          incrementCopiedTodayCounter();
          showToast('Prompt copied to clipboard!');
        }
      } else if (action === 'bookmark') {
        toggleBookmarkCard(id);
      } else if (action === 'like') {
        toggleLikeCard(id);
      }
      return;
    }
  });
}

async function toggleBookmarkCard(id: string) {
  if (!currentUser) {
    showToast('Please sign in to bookmark prompts');
    openAuthModal('login');
    return;
  }
  const ref = doc(db, 'users', currentUser.uid, 'bookmarks', id);
  if (bookmarks.includes(id)) {
    await deleteDoc(ref).catch(() => {});
    showToast('Bookmark removed');
  } else {
    await setDoc(ref, { timestamp: serverTimestamp() }).catch(() => {});
    showToast('Prompt saved to bookmarks!');
  }
}

async function toggleLikeCard(id: string) {
  if (!currentUser) {
    showToast('Please sign in to like prompts');
    openAuthModal('login');
    return;
  }
  const ref = doc(db, 'users', currentUser.uid, 'likes', id);
  const pRef = doc(db, 'prompts', id);

  if (userLikes.includes(id)) {
    await deleteDoc(ref).catch(() => {});
    showToast('Like removed');
  } else {
    await setDoc(ref, { timestamp: serverTimestamp() }).catch(() => {});
    await updateDoc(pRef, { likes: increment(1) }).catch(() => {});
    showToast('Liked prompt!');
  }
}

// =============================================================================
// AUTHENTICATION MODAL & ACTIONS — Phase 2
// =============================================================================

function openAuthModal(mode: 'login' | 'signup' = 'login') {
  authModalMode = mode;
  switchAuthModalMode(mode);
  const modal = getElementSafe('auth-modal');
  if (modal) modal.classList.remove('hidden');
}

function switchAuthModalMode(mode: 'login' | 'signup') {
  authModalMode = mode;
  const loginTab = getElementSafe('auth-tab-login');
  const signupTab = getElementSafe('auth-tab-signup');
  const nameField = getElementSafe('signup-name-field');
  const submitBtn = getElementSafe('auth-submit-btn');

  if (mode === 'signup') {
    if (loginTab) loginTab.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold text-[#5a7260]';
    if (signupTab) signupTab.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold text-[#1a2e1e] bg-white shadow-xs';
    if (nameField) nameField.classList.remove('hidden');
    if (submitBtn) submitBtn.innerText = 'Create Account';
  } else {
    if (signupTab) signupTab.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold text-[#5a7260]';
    if (loginTab) loginTab.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold text-[#1a2e1e] bg-white shadow-xs';
    if (nameField) nameField.classList.add('hidden');
    if (submitBtn) submitBtn.innerText = 'Sign In';
  }
}

async function handleGoogleAuthAction() {
  try {
    await handleGoogleAuth();
    showToast('Signed in with Google!');
    closeModal('auth-modal');
  } catch (err: any) {
    showAuthError(err.message);
  }
}

async function handleEmailAuthFormSubmit(e: Event) {
  e.preventDefault();
  const emailInput = getElementSafe<HTMLInputElement>('auth-email-input');
  const passInput = getElementSafe<HTMLInputElement>('auth-password-input');
  const nameInput = getElementSafe<HTMLInputElement>('auth-name-input');
  const submitBtn = getElementSafe<HTMLButtonElement>('auth-submit-btn');

  if (!emailInput || !passInput) return;

  const email = emailInput.value.trim();
  const pass = passInput.value.trim();
  const name = nameInput ? nameInput.value.trim() : '';

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Processing...';
  }

  try {
    if (authModalMode === 'signup') {
      await registerWithEmail(name, email, pass);
      showToast('Account created! Please check your email to verify your address.');
    } else {
      await loginWithEmail(email, pass);
      showToast('Signed in successfully!');
    }
    closeModal('auth-modal');
  } catch (err: any) {
    showAuthError(err.message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = authModalMode === 'signup' ? 'Create Account' : 'Sign In';
    }
  }
}

async function handleForgotPasswordAction() {
  const emailInput = getElementSafe<HTMLInputElement>('auth-email-input');
  if (!emailInput || !emailInput.value.trim()) {
    showAuthError('Please enter your email address above to reset your password.');
    return;
  }
  try {
    await requestPasswordReset(emailInput.value.trim());
    showToast('Password reset link sent to your email.');
  } catch (err: any) {
    showAuthError(err.message);
  }
}

function showAuthError(msg: string) {
  const banner = getElementSafe('auth-error-banner');
  if (banner) {
    banner.innerText = msg;
    banner.classList.remove('hidden');
  } else {
    showToast(msg);
  }
}

function closeModal(id: string) {
  const modal = getElementSafe(id);
  if (modal) modal.classList.add('hidden');
}

// =============================================================================
// USER DASHBOARD
// =============================================================================

async function renderUserDashboardSubmissions() {
  const tbody = getElementSafe('user-prompts-tbody');
  const countEl = getElementSafe('user-prompt-count');
  if (!tbody || !currentUser) return;

  tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-[#5a7260]">Loading submissions...</td></tr>`;

  try {
    const q = query(collection(db, 'prompts'), where('creatorId', '==', currentUser.uid));
    const snap = await getDocs(q);
    const userPrompts = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem));

    if (countEl) countEl.innerText = `${userPrompts.length} prompts`;

    if (userPrompts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-[#5a7260]">You haven't submitted any prompts yet. Click "Submit New Prompt" above!</td></tr>`;
      return;
    }

    tbody.innerHTML = userPrompts.map(p => `
      <tr class="border-b border-[#dde8df] hover:bg-[#f4f7f5]">
        <td class="p-3 font-bold text-[#1a2e1e] flex items-center gap-2">
          <img src="${escapeAttr(safeUrl(p.image))}" class="w-8 h-8 rounded-lg object-cover" />
          <span class="truncate max-w-[200px]">${escapeHtml(p.title)}</span>
        </td>
        <td class="p-3 text-[#5a7260] font-medium">${escapeHtml(p.tool)}</td>
        <td class="p-3 text-[#5a7260] font-medium">${escapeHtml(p.category)}</td>
        <td class="p-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${p.status === 'approved' ? 'bg-emerald-100 text-emerald-800' : p.status === 'rejected' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}">
            ${escapeHtml(p.status)}
          </span>
        </td>
        <td class="p-3 text-[#5a7260]">${p.views || 0} / ${p.likes || 0}</td>
        <td class="p-3 text-right">
          ${p.status === 'pending' || p.status === 'draft' ? `
            <button onclick="window.editUserPrompt('${escapeAttr(p.id)}')" class="px-2 py-1 text-xs font-bold text-[#2d8a45] hover:bg-[#e8f5ec] rounded">Edit</button>
          ` : '<span class="text-[10px] text-[#9ab09e]">Published</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-rose-600">Failed to load submissions</td></tr>`;
  }
}

// =============================================================================
// MISC SEARCH & BLOG RENDERERS
// =============================================================================

function handleLiveSearchInput(queryStr: string) {
  const autocompleteEl = getElementSafe('search-autocomplete');
  const resultsEl = getElementSafe('autocomplete-results');
  if (!autocompleteEl || !resultsEl) return;

  if (!queryStr.trim()) {
    autocompleteEl.classList.add('hidden');
    return;
  }

  const q = queryStr.toLowerCase().trim();
  const matches = prompts.filter(p => 
    p.title.toLowerCase().includes(q) || 
    p.prompt.toLowerCase().includes(q) || 
    p.category.toLowerCase().includes(q) || 
    p.tool.toLowerCase().includes(q) ||
    (p.tags && p.tags.some(t => t.toLowerCase().includes(q)))
  ).slice(0, 5);

  if (matches.length === 0) {
    resultsEl.innerHTML = `<div class="px-4 py-3 text-xs text-[#5a7260]">No matching prompts found</div>`;
  } else {
    resultsEl.innerHTML = matches.map(p => `
      <div onclick="window.navigateTo('details', { id: '${p.id}' }); document.getElementById('search-autocomplete').classList.add('hidden');" class="px-4 py-2.5 hover:bg-[#e8f5ec] cursor-pointer flex items-center justify-between border-b border-[#dde8df] last:border-0 transition">
        <div class="flex items-center gap-3">
          <img src="${escapeAttr(safeUrl(p.image))}" class="w-8 h-8 rounded-lg object-cover" />
          <div>
            <p class="text-xs font-bold text-[#1a2e1e] line-clamp-1">${escapeHtml(p.title)}</p>
            <p class="text-[10px] text-[#5a7260]">${escapeHtml(p.tool)} • ${escapeHtml(p.category)}</p>
          </div>
        </div>
      </div>
    `).join('');
  }
  autocompleteEl.classList.remove('hidden');
}

function triggerSearchFilter() {
  const mainInput = getElementSafe<HTMLInputElement>('main-search-page-input');
  const catSelect = getElementSafe<HTMLSelectElement>('search-category-select');
  const toolSelect = getElementSafe<HTMLSelectElement>('search-tool-select');
  const resultsGrid = getElementSafe('search-results-grid');
  const countEl = getElementSafe('search-results-count');

  if (!resultsGrid) return;

  const q = mainInput ? mainInput.value.toLowerCase().trim() : '';
  const cat = catSelect ? catSelect.value : 'all';
  const tool = toolSelect ? toolSelect.value : 'all';

  const matches = prompts.filter(p => {
    const matchQ = !q || 
      p.title.toLowerCase().includes(q) || 
      p.prompt.toLowerCase().includes(q) || 
      p.category.toLowerCase().includes(q) || 
      p.tool.toLowerCase().includes(q) ||
      (p.tags && p.tags.some(t => t.toLowerCase().includes(q)));

    const matchCat = cat === 'all' || p.category.toLowerCase().trim() === cat.toLowerCase().trim();
    const matchTool = tool === 'all' || p.tool.toLowerCase().trim() === tool.toLowerCase().trim();
    return matchQ && matchCat && matchTool;
  });

  if (countEl) countEl.innerText = `Showing ${matches.length} results`;

  if (matches.length === 0) {
    renderEmptyState(resultsGrid, 'No search results found');
    return;
  }

  resultsGrid.innerHTML = matches.map(p => createPromptCardHTML(p)).join('');
  refreshIcons();
}

function resetSearchFilters() {
  const mainInput = getElementSafe<HTMLInputElement>('main-search-page-input');
  const catSelect = getElementSafe<HTMLSelectElement>('search-category-select');
  const toolSelect = getElementSafe<HTMLSelectElement>('search-tool-select');

  if (mainInput) mainInput.value = '';
  if (catSelect) catSelect.value = 'all';
  if (toolSelect) toolSelect.value = 'all';

  currentCategoryFilter = 'all';
  currentToolFilter = 'all';

  triggerSearchFilter();
  renderCategoryPills();
  renderGalleryFromCache();
  showToast('Filters cleared');
}

function handleLoadMoreAction() {
  showToast('Loading more prompts...');
}

function handleContactFormSubmit(e: Event) {
  e.preventDefault();
  const nameEl = getElementSafe<HTMLInputElement>('contact-name');
  const emailEl = getElementSafe<HTMLInputElement>('contact-email');
  const messageEl = getElementSafe<HTMLTextAreaElement>('contact-message');

  if (nameEl && emailEl && messageEl) {
    addDoc(collection(db, 'contactSubmissions'), {
      name: nameEl.value.trim(),
      email: emailEl.value.trim(),
      message: messageEl.value.trim(),
      timestamp: serverTimestamp()
    }).catch(() => {});

    showToast('Thank you! Your message has been sent.');
    nameEl.value = '';
    emailEl.value = '';
    messageEl.value = '';
  }
}

function loadBlogsList() {
  const grid = getElementSafe('blog-posts-grid');
  if (!grid) return;
  getDocs(query(collection(db, 'blogs'), where('status', '==', 'published'), limit(6))).then(snap => {
    if (snap.empty) {
      grid.innerHTML = `<div class="col-span-full text-center py-8 text-[#5a7260]">No blog posts published yet.</div>`;
      return;
    }
    grid.innerHTML = snap.docs.map(d => {
      const b = d.data() as any;
      return `
        <article class="bg-white rounded-2xl border border-[#dde8df] shadow-card overflow-hidden">
          <img src="${escapeAttr(safeUrl(b.imageUrl))}" class="w-full h-48 object-cover" />
          <div class="p-5 space-y-2">
            <h3 class="font-bold text-base text-[#1a2e1e]">${escapeHtml(b.title)}</h3>
            <p class="text-xs text-[#5a7260] line-clamp-3">${escapeHtml(b.summary || '')}</p>
            <a href="/blog/${escapeAttr(b.slug || d.id)}" data-nav="/blog/${escapeAttr(b.slug || d.id)}" class="inline-block pt-2 text-xs font-bold text-[#2d8a45]">Read Article →</a>
          </div>
        </article>
      `;
    }).join('');
  }).catch(() => {});
}

function loadBlogDetail(slug: string) {
  const content = getElementSafe('blog-detail-content');
  if (!content) return;
  getDocs(query(collection(db, 'blogs'), where('slug', '==', slug), limit(1))).then(snap => {
    if (snap.empty) {
      content.innerHTML = `<p class="text-center text-[#5a7260]">Blog post not found.</p>`;
      return;
    }
    const b = snap.docs[0].data() as any;
    content.innerHTML = `
      <h1 class="text-3xl font-extrabold text-[#1a2e1e]">${escapeHtml(b.title)}</h1>
      <p class="text-xs text-[#5a7260]">By ${escapeHtml(b.author || 'PromptsOne')} • ${b.publishedAt ? new Date(b.publishedAt.seconds * 1000).toLocaleDateString() : ''}</p>
      <img src="${escapeAttr(safeUrl(b.imageUrl))}" class="w-full h-72 object-cover rounded-2xl" />
      <div class="prose max-w-none text-sm text-[#1a2e1e] leading-relaxed">${sanitizeHtml(b.content || '')}</div>
    `;
  }).catch(() => {});
}

function renderDocsFAQ() {
  const docsContainer = getElementSafe('docs-content');
  if (!docsContainer) return;
  docsContainer.innerHTML = `
    <div class="bg-white p-5 rounded-2xl border border-[#dde8df] space-y-2">
      <h3 class="font-bold text-sm text-[#1a2e1e]">What is PromptsOne?</h3>
      <p class="text-xs text-[#5a7260]">PromptsOne is a search engine and gallery for engineered AI prompts for ChatGPT, Midjourney, Flux, Gemini, and Claude.</p>
    </div>
    <div class="bg-white p-5 rounded-2xl border border-[#dde8df] space-y-2">
      <h3 class="font-bold text-sm text-[#1a2e1e]">Can I use these prompts commercially?</h3>
      <p class="text-xs text-[#5a7260]">Yes, all public prompts are free to copy and use for personal or commercial generative AI projects.</p>
    </div>
  `;
}

function showToast(msg: string) {
  const container = getElementSafe('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'bg-[#1a2e1e] text-white px-4 py-2.5 rounded-xl text-xs font-bold shadow-2xl flex items-center gap-2 border border-[#1a5c2a] pointer-events-auto';
  toast.innerHTML = `<i data-lucide="check-circle-2" class="w-4 h-4 text-[#25D366]"></i> <span>${escapeHtml(msg)}</span>`;
  container.appendChild(toast);
  refreshIcons();
  setTimeout(() => { toast.remove(); }, 3000);
}

function toggleMobileMenu() {
  const menu = getElementSafe('mobile-menu');
  if (menu) menu.classList.toggle('hidden');
}

// =============================================================================
// GLOBAL EXPORTS FOR WINDOW HELPERS
// =============================================================================

function attachWindowGlobalFunctions() {
  const w = window as any;
  w.navigateTo = navigateTo;
  w.navigateToPath = navigateToPath;
  w.showToast = showToast;
  w.openAuthModal = openAuthModal;
  w.closeModal = closeModal;
  w.openUserSubmitModal = () => {
    const modal = getElementSafe('add-prompt-modal');
    if (modal) modal.classList.remove('hidden');
  };
  w.editUserPrompt = async (id: string) => {
    const p = prompts.find(x => x.id === id);
    if (!p) return;
    const idInput = getElementSafe<HTMLInputElement>('form-prompt-id');
    const titleInput = getElementSafe<HTMLInputElement>('form-title');
    const textInput = getElementSafe<HTMLTextAreaElement>('form-prompt-text');
    if (idInput) idInput.value = p.id;
    if (titleInput) titleInput.value = p.title;
    if (textInput) textInput.value = p.prompt;
    const modal = getElementSafe('add-prompt-modal');
    if (modal) modal.classList.remove('hidden');
  };
}

attachWindowGlobalFunctions();
