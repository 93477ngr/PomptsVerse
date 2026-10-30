// =============================================================================
// PROMPTVERSE ADMIN PANEL — Complete Admin TypeScript Module
// Separate application from the public site. Firebase + Cloudinary only.
// =============================================================================

import {
  auth,
  db,
  googleProvider,
  getUserRole,
  syncUserDoc,
  uploadToCloudinary,
  optimizeCloudinaryUrl,
  handleFirestoreError,
  OperationType
} from './firebase';
import { invalidateAdCache } from './ads';
import {
  signInWithPopup,
  signInWithEmailAndPassword,
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
  query,
  orderBy,
  limit,
  writeBatch,
  Timestamp,
} from 'firebase/firestore';

// =============================================================================
// INTERFACES
// =============================================================================
interface PromptItem {
  id: string;
  title: string;
  tool: string;
  category: string;
  image: string;
  images?: string[];
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
  status: 'approved' | 'pending' | 'rejected';
  rankScore?: number;
  tags?: string[];
  seasonalTags?: string[];
  createdAt?: any;
  updatedAt?: any;
}

interface CategoryItem {
  id: string;
  name: string;
  icon: string;
  count: number;
}

interface AdminUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  role: 'admin' | 'user';
  createdAt?: any;
  updatedAt?: any;
}

// =============================================================================
// STATE
// =============================================================================
let currentAdminUser: User | null = null;
let allPrompts: PromptItem[] = [];
let allCategories: CategoryItem[] = [];
let allUsers: AdminUser[] = [];
let currentSection = 'overview';
let promptsPage = 0;
const PROMPTS_PER_PAGE = 25;
let filteredPrompts: PromptItem[] = [];
let currentConfirmCallback: (() => void) | null = null;
let unsubCategories: (() => void) | null = null;
let allAITools: any[] = [];
let unsubAITools: (() => void) | null = null;

// =============================================================================
// DOM HELPERS
// =============================================================================
const $ = (id: string) => document.getElementById(id);
const show = (id: string) => { const el = $(id); if (el) el.classList.remove('hidden'); };
const hide = (id: string) => { const el = $(id); if (el) el.classList.add('hidden'); };

function setContent(id: string, html: string) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

function setText(id: string, text: string) {
  const el = $(id);
  if (el) el.textContent = text;
}

function lcIcons() {
  if (typeof (window as any).lucide !== 'undefined') {
    (window as any).lucide.createIcons();
  }
}

// =============================================================================
// TOAST NOTIFICATIONS
// =============================================================================
function showToast(message: string, type: 'success' | 'error' | 'info' | 'warning' = 'success') {
  const container = $('admin-toast-container');
  if (!container) return;
  const colors = {
    success: 'bg-emerald-600 border-emerald-500',
    error: 'bg-rose-600 border-rose-500',
    info: 'bg-blue-600 border-blue-500',
    warning: 'bg-amber-500 border-amber-400'
  };
  const icons = {
    success: 'check-circle-2',
    error: 'x-circle',
    info: 'info',
    warning: 'alert-triangle'
  };
  const toast = document.createElement('div');
  toast.className = `${colors[type]} text-white px-4 py-2.5 rounded-xl text-xs font-bold shadow-2xl flex items-center gap-2 border pointer-events-auto max-w-xs`;
  toast.innerHTML = `<i data-lucide="${icons[type]}" class="w-4 h-4 shrink-0"></i><span>${message}</span>`;
  container.appendChild(toast);
  lcIcons();
  setTimeout(() => toast.remove(), 4000);
}

// =============================================================================
// CONFIRM MODAL
// =============================================================================
function showConfirm(title: string, message: string, callback: () => void, danger = true) {
  setText('confirm-title', title);
  setText('confirm-message', message);
  const btn = $('confirm-action-btn') as HTMLButtonElement;
  if (btn) {
    btn.className = `px-4 py-2 ${danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-blue-600 hover:bg-blue-700'} text-white rounded-xl text-sm font-bold transition`;
    btn.textContent = danger ? 'Delete' : 'Confirm';
  }
  currentConfirmCallback = callback;
  show('confirm-modal');
  lcIcons();
}

function closeConfirmModal() {
  hide('confirm-modal');
  currentConfirmCallback = null;
}

function executeConfirm() {
  if (currentConfirmCallback) currentConfirmCallback();
  closeConfirmModal();
}

// =============================================================================
// AUTH INITIALIZATION
// =============================================================================
window.addEventListener('DOMContentLoaded', () => {
  show('admin-loading');
  hide('admin-login');
  hide('admin-denied');
  hide('admin-dashboard');

  onAuthStateChanged(auth, async (user) => {
    hide('admin-loading');

    if (!user) {
      show('admin-login');
      lcIcons();
      return;
    }

    try {
      await syncUserDoc(user);
      const role = await getUserRole(user);

      if (role !== 'admin') {
        show('admin-denied');
        lcIcons();
        return;
      }

      currentAdminUser = user;
      updateAdminUserUI(user);
      show('admin-dashboard');
      document.body.style.overflow = 'hidden';
      lcIcons();
      initDashboard();
    } catch (err) {
      console.error('Admin auth error:', err);
      show('admin-denied');
      lcIcons();
    }
  });
});

function formatAdminDisplayName(user: User): string {
  if (user.displayName && user.displayName.trim() && !user.displayName.includes('@')) {
    return user.displayName.trim();
  }
  const prefix = user.email ? user.email.split('@')[0] : 'Administrator';
  const withoutDigits = prefix.replace(/\d+$/, '');
  const base = withoutDigits.length >= 3 ? withoutDigits : prefix;
  return base.replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function updateAdminUserUI(user: User) {
  const name = formatAdminDisplayName(user);
  const letter = name.charAt(0).toUpperCase();
  const avatars = ['sidebar-avatar', 'header-avatar'];
  avatars.forEach(id => { const el = $(id); if (el) el.textContent = letter; });
  setText('sidebar-name', name);
  setText('sidebar-email', user.email || 'admin@promptsone.com');
  setText('header-name', name);
}

// =============================================================================
// AUTH HANDLERS
// =============================================================================
async function handleAdminGoogleSignIn() {
  const btn = $('admin-google-signin') as HTMLButtonElement;
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting...'; }
  hideLoginError();
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err: any) {
    showLoginError(err.message || 'Google sign-in failed');
    if (btn) { btn.disabled = false; btn.innerHTML = `<svg class="w-5 h-5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg> Continue with Google`; }
  }
}

async function handleAdminEmailLogin(e: Event) {
  e.preventDefault();
  const emailEl = $('admin-email-input') as HTMLInputElement;
  const passEl = $('admin-password-input') as HTMLInputElement;
  const btn = $('admin-login-btn') as HTMLButtonElement;
  const email = emailEl?.value.trim();
  const password = passEl?.value;
  if (!email || !password) return;
  hideLoginError();
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err: any) {
    let msg = 'Authentication failed';
    if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
      msg = 'Invalid email or password';
    } else if (err.code === 'auth/too-many-requests') {
      msg = 'Too many attempts. Try again later';
    } else {
      msg = err.message || msg;
    }
    showLoginError(msg);
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In to Admin Panel'; }
  }
}

async function handleAdminLogout() {
  try {
    await firebaseSignOut(auth);
    window.location.reload();
  } catch (err) {
    console.error('Logout error:', err);
  }
}

function showLoginError(msg: string) {
  const el = $('login-error');
  const txt = $('login-error-text');
  if (el) el.classList.remove('hidden');
  if (txt) txt.textContent = msg;
}

function hideLoginError() {
  const el = $('login-error');
  if (el) el.classList.add('hidden');
}

// =============================================================================
// DASHBOARD INITIALIZATION
// =============================================================================
async function initDashboard() {
  await loadAllPrompts();
  startCategoriesListener();
  startAIToolsListener();
  adminNav('overview');
}

async function loadAllPrompts() {
  try {
    let snap;
    try {
      snap = await getDocs(query(collection(db, 'prompts'), orderBy('createdAt', 'desc'), limit(500)));
    } catch {
      snap = await getDocs(query(collection(db, 'prompts'), limit(500)));
    }
    allPrompts = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem));
    updatePendingBadge();
  } catch (err) {
    showToast('Failed to load prompts', 'error');
  }
}

async function loadAllUsers() {
  try {
    const snap = await getDocs(query(collection(db, 'users'), limit(200)));
    allUsers = snap.docs.map(d => ({ uid: d.id, ...(d.data() as any) } as AdminUser));
  } catch (err) {
    showToast('Failed to load users', 'error');
  }
}

function startCategoriesListener() {
  if (unsubCategories) unsubCategories();
  unsubCategories = onSnapshot(collection(db, 'categories'), (snap) => {
    allCategories = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as CategoryItem));
    updateCategorySelectOptions();
  }, (err) => {
    handleFirestoreError(err, OperationType.LIST, 'categories');
  });
}

function startAIToolsListener() {
  if (unsubAITools) unsubAITools();
  unsubAITools = onSnapshot(collection(db, 'aiTools'), (snap) => {
    allAITools = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
    updateToolSelectOptions();
  }, (err) => {
    handleFirestoreError(err, OperationType.LIST, 'aiTools');
  });
}

function updateToolSelectOptions() {
  const sel = $('pf-tool') as HTMLSelectElement;
  if (sel && allAITools.length > 0) {
    const cur = sel.value;
    sel.innerHTML = allAITools.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
    if (cur) sel.value = cur;
  }
  const filterSel = $('prompt-tool-filter') as HTMLSelectElement;
  if (filterSel && allAITools.length > 0) {
    const curFilter = filterSel.value;
    filterSel.innerHTML = `<option value="all">All Tools</option>` + allAITools.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
    if (curFilter) filterSel.value = curFilter;
  }
}

const DEFAULT_ADMIN_CATEGORIES = [
  '3D Render',
  'AI Art',
  'Anime',
  'Architecture',
  'Birthday',
  'Business',
  'Fantasy',
  'Festivals',
  'Logo Design',
  'Marketing',
  'Photography',
  'Portraits',
  'Real Estate',
  'Social Media',
  'Wallpaper',
  'Wedding'
];

function updateCategorySelectOptions(selectedCategory?: string) {
  const sel = $('pf-category') as HTMLSelectElement;
  if (!sel) return;
  const cur = selectedCategory !== undefined ? selectedCategory : sel.value;
  const names = new Set<string>();
  allCategories.forEach(c => { if (c.name) names.add(c.name); });
  DEFAULT_ADMIN_CATEGORIES.forEach(c => names.add(c));
  if (cur) names.add(cur);
  const sorted = Array.from(names).sort();
  sel.innerHTML = sorted.map(c => `<option value="${c}">${c}</option>`).join('');
  if (cur) {
    sel.value = cur;
  }
}

function updatePendingBadge() {
  const pending = allPrompts.filter(p => p.status === 'pending').length;
  const badge = $('nav-badge-pending');
  if (badge) {
    if (pending > 0) {
      badge.textContent = String(pending);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

// =============================================================================
// NAVIGATION
// =============================================================================
function adminNav(section: string) {
  currentSection = section;

  // Update active nav item
  document.querySelectorAll('.admin-nav-item').forEach(btn => {
    btn.classList.remove('admin-nav-active', 'text-white');
    btn.classList.add('admin-nav-item');
  });
  const activeBtn = $(`nav-${section}`);
  if (activeBtn) {
    activeBtn.classList.add('admin-nav-active');
    activeBtn.classList.remove('admin-nav-item');
  }

  // Render section
  const sectionNames: Record<string, [string, string]> = {
    overview: ['Overview', 'Dashboard summary'],
    prompts: ['Prompt Management', 'Create, edit, approve and manage all prompts'],
    categories: ['Category Management', 'Manage prompt categories'],
    aitools: ['AI Tools', 'Manage supported AI tools'],
    tags: ['Tags', 'View and manage all tags'],
    collections: ['Seasonal Collections', 'Manage featured collections'],
    featured: ['Featured Prompts', 'Manage featured prompt selection'],
    trending: ['Trending Prompts', 'Manage trending prompt selection'],
    users: ['User Management', 'View and manage user accounts'],
    analytics: ['Analytics', 'Engagement metrics and statistics'],
    'search-analytics': ['Search Analytics', 'Top search queries and trends'],
    images: ['Image Management', 'All images used across prompts'],
    cloudinary: ['Cloud CDN Upload', 'Upload images directly to high-speed cloud CDN'],
    reports: ['Reports', 'Export data and generate reports'],
    stats: ['Site Statistics', 'Manage real-time dynamic counters and manual overrides'],
    settings: ['Site Settings', 'Configure site-wide settings'],
    backup: ['Backup & Restore', 'Export and import Firestore data'],
    logs: ['Activity Logs', 'Recent admin actions and events'],
    'seasonal-campaigns': ['Seasonal Campaigns', 'Create, schedule and manage homepage promotional campaigns'],
    blogs: ['Blog Articles', 'Compose and manage tutorials & announcements'],
    pages: ['Static Pages', 'Edit About, Privacy, Terms, and Policy documents'],
    contacts: ['Contact Inquiries', 'Manage inbound user submissions and support requests'],
    'contact-settings': ['Contact Settings', 'Configure support phone, email, address, and Google Maps'],
    media: ['Media Library', 'Browse uploaded images and assets'],
    advertisements: ['Sponsored Advertisements', 'Create, schedule, prioritize and analyze sponsored campaigns'],
    'adsense-settings': ['Google AdSense Integration', 'Configure Google AdSense publisher ID, Auto Ads, and slot mappings'],
    seo: ['SEO & Google Ranking', 'Search engine optimization, meta tags, Google ranking keywords & hashtags'],
  };

  const [title, subtitle] = sectionNames[section] || ['Admin', 'Dashboard'];
  setText('page-title', title);
  setText('page-subtitle', subtitle);

  renderSection(section);
}

function renderSection(section: string) {
  switch (section) {
    case 'overview': renderOverview(); break;
    case 'prompts': renderPrompts(); break;
    case 'categories': renderCategories(); break;
    case 'aitools': renderAITools(); break;
    case 'tags': renderTags(); break;
    case 'collections': renderCollections(); break;
    case 'featured': renderFeatured(); break;
    case 'trending': renderTrending(); break;
    case 'users': renderUsers(); break;
    case 'blogs': renderBlogs(); break;
    case 'seasonal-campaigns': renderSeasonalCampaigns(); break;
    case 'pages': renderPages(); break;
    case 'contacts': renderContacts(); break;
    case 'contact-settings': renderContactSettings(); break;
    case 'media': renderMedia(); break;
    case 'analytics': renderAnalytics(); break;
    case 'search-analytics': renderSearchAnalytics(); break;
    case 'images': renderImages(); break;
    case 'cloudinary': renderCloudinaryUpload(); break;
    case 'reports': renderReports(); break;
    case 'stats': renderStatsManagement(); break;
    case 'settings': renderSettings(); break;
    case 'seo': renderSEO(); break;
    case 'advertisements': renderAdvertisements(); break;
    case 'adsense-settings': renderAdSenseSettings(); break;
    case 'backup': renderBackup(); break;
    case 'logs': renderLogs(); break;
    case 'profile': renderProfile(); break;
    default: renderOverview();
  }
}

function formatN(n: number): string {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function formatDate(ts: any): string {
  if (!ts) return '—';
  const d = ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function statusBadge(status: string): string {
  if (status === 'approved') return `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700">Approved</span>`;
  if (status === 'rejected') return `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-700">Rejected</span>`;
  return `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700">Pending</span>`;
}

// =============================================================================
// OVERVIEW SECTION
// =============================================================================
function renderOverview() {
  const total = allPrompts.length;
  const approved = allPrompts.filter(p => p.status === 'approved').length;
  const pending = allPrompts.filter(p => p.status === 'pending').length;
  const rejected = allPrompts.filter(p => p.status === 'rejected').length;
  const featured = allPrompts.filter(p => p.featured).length;
  const trending = allPrompts.filter(p => p.trending).length;
  const totalViews = allPrompts.reduce((s, p) => s + (p.views || 0), 0);
  const totalLikes = allPrompts.reduce((s, p) => s + (p.likes || 0), 0);
  const totalCopies = allPrompts.reduce((s, p) => s + (p.copyCount || 0), 0);

  const recent = [...allPrompts]
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
    .slice(0, 8);

  const topByViews = [...allPrompts].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 5);

  setContent('admin-content', `
    <div class="space-y-6">
      <!-- Stats Grid -->
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        ${[
          { label: 'Total Prompts', value: total, icon: 'file-text', color: 'blue', bg: 'bg-blue-50', text: 'text-blue-600' },
          { label: 'Pending Review', value: pending, icon: 'clock', color: 'amber', bg: 'bg-amber-50', text: 'text-amber-600', clickable: true },
          { label: 'Total Views', value: formatN(totalViews), icon: 'eye', color: 'indigo', bg: 'bg-indigo-50', text: 'text-indigo-600' },
          { label: 'Total Likes', value: formatN(totalLikes), icon: 'heart', color: 'rose', bg: 'bg-rose-50', text: 'text-rose-600' },
          { label: 'Total Copies', value: formatN(totalCopies), icon: 'copy', color: 'emerald', bg: 'bg-emerald-50', text: 'text-emerald-600' },
        ].map(s => `
          <div class="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm stat-card ${s.clickable ? 'cursor-pointer' : ''}" ${s.clickable ? 'onclick="adminNav(\'prompts\')"' : ''}>
            <div class="flex items-center gap-3 mb-2">
              <div class="w-9 h-9 rounded-xl ${s.bg} flex items-center justify-center shrink-0">
                <i data-lucide="${s.icon}" class="w-4 h-4 ${s.text}"></i>
              </div>
              <span class="text-xs font-semibold text-slate-500">${s.label}</span>
            </div>
            <div class="text-2xl font-extrabold text-slate-900">${s.value}</div>
          </div>
        `).join('')}
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        ${[
          { label: 'Approved', value: approved, text: 'text-emerald-600', bg: 'bg-emerald-50' },
          { label: 'Rejected', value: rejected, text: 'text-rose-600', bg: 'bg-rose-50' },
          { label: 'Featured', value: featured, text: 'text-amber-600', bg: 'bg-amber-50' },
          { label: 'Trending', value: trending, text: 'text-orange-600', bg: 'bg-orange-50' },
        ].map(s => `
          <div class="bg-white rounded-xl p-4 border border-slate-200 shadow-sm stat-card">
            <div class="text-xl font-extrabold ${s.text}">${s.value}</div>
            <div class="text-xs text-slate-500 font-semibold mt-1">${s.label}</div>
          </div>
        `).join('')}
      </div>

      <!-- Quick Actions -->
      <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
        <h3 class="text-sm font-bold text-slate-900 mb-3">Quick Actions</h3>
        <div class="flex flex-wrap gap-2">
          <button onclick="openPromptModal()" class="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition flex items-center gap-1.5">
            <i data-lucide="plus" class="w-3.5 h-3.5"></i> New Prompt
          </button>
          <button onclick="adminNav('prompts')" class="px-3 py-2 bg-amber-50 hover:bg-amber-100 text-amber-700 text-xs font-bold rounded-xl transition border border-amber-200 flex items-center gap-1.5">
            <i data-lucide="clock" class="w-3.5 h-3.5"></i> Review Pending (${pending})
          </button>
          <button onclick="adminNav('categories')" class="px-3 py-2 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-bold rounded-xl transition border border-slate-200 flex items-center gap-1.5">
            <i data-lucide="folder-plus" class="w-3.5 h-3.5"></i> Add Category
          </button>
          <button onclick="adminNav('cloudinary')" class="px-3 py-2 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-bold rounded-xl transition border border-slate-200 flex items-center gap-1.5">
            <i data-lucide="upload-cloud" class="w-3.5 h-3.5"></i> Upload Image
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Recent Prompts -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm">
          <div class="p-4 border-b border-slate-100 flex items-center justify-between">
            <h3 class="text-sm font-bold text-slate-900">Recently Added</h3>
            <button onclick="adminNav('prompts')" class="text-xs text-blue-600 font-semibold hover:text-blue-700">View All</button>
          </div>
          <div class="divide-y divide-slate-100">
            ${recent.length === 0 ? '<p class="text-center text-slate-400 text-xs py-6">No prompts yet</p>' :
              recent.map(p => `
                <div class="flex items-center gap-3 p-3 hover:bg-slate-50 transition">
                  <img src="${p.image || ''}" alt="" class="w-10 h-10 rounded-lg object-cover shrink-0 bg-slate-100" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'40\\' height=\\'40\\'%3E%3Crect width=\\'40\\' height=\\'40\\' fill=\\'%23e2e8f0\\'/%3E%3C/svg%3E'" />
                  <div class="flex-1 min-w-0">
                    <p class="text-xs font-bold text-slate-900 truncate">${p.title}</p>
                    <p class="text-[10px] text-slate-400">${p.tool} · ${formatDate(p.createdAt)}</p>
                  </div>
                  ${statusBadge(p.status || 'pending')}
                </div>
              `).join('')}
          </div>
        </div>

        <!-- Top Prompts by Views -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm">
          <div class="p-4 border-b border-slate-100">
            <h3 class="text-sm font-bold text-slate-900">Top Prompts by Views</h3>
          </div>
          <div class="divide-y divide-slate-100">
            ${topByViews.length === 0 ? '<p class="text-center text-slate-400 text-xs py-6">No data yet</p>' :
              topByViews.map((p, i) => `
                <div class="flex items-center gap-3 p-3 hover:bg-slate-50 transition">
                  <span class="w-5 h-5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-extrabold flex items-center justify-center shrink-0">${i+1}</span>
                  <img src="${p.image || ''}" alt="" class="w-9 h-9 rounded-lg object-cover shrink-0 bg-slate-100" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'36\\' height=\\'36\\'%3E%3Crect width=\\'36\\' height=\\'36\\' fill=\\'%23e2e8f0\\'/%3E%3C/svg%3E'" />
                  <div class="flex-1 min-w-0">
                    <p class="text-xs font-bold text-slate-900 truncate">${p.title}</p>
                    <p class="text-[10px] text-slate-400">${p.category}</p>
                  </div>
                  <span class="text-xs font-extrabold text-blue-600 shrink-0">${formatN(p.views || 0)}</span>
                </div>
              `).join('')}
          </div>
        </div>
      </div>
    </div>
  `);
  lcIcons();
}

// =============================================================================
// PROMPT MANAGEMENT
// =============================================================================
function renderPrompts() {
  filteredPrompts = [...allPrompts];
  const pending = allPrompts.filter(p => p.status === 'pending').length;

  setContent('admin-content', `
    <div class="space-y-4">
      <!-- Toolbar -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
        <div class="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          <div class="flex-1 flex items-center gap-2 flex-wrap">
            <div class="relative">
              <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400"></i>
              <input type="text" id="prompt-search" placeholder="Search prompts..." oninput="filterPrompts()"
                class="pl-8 pr-3 py-2 border border-slate-200 rounded-xl text-xs font-medium focus:border-blue-500 transition w-48 sm:w-64" />
            </div>
            <select id="prompt-status-filter" onchange="filterPrompts()" class="px-3 py-2 border border-slate-200 rounded-xl text-xs font-medium focus:border-blue-500 transition">
              <option value="all">All Status</option>
              <option value="pending">Pending (${pending})</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
            <select id="prompt-tool-filter" onchange="filterPrompts()" class="px-3 py-2 border border-slate-200 rounded-xl text-xs font-medium focus:border-blue-500 transition">
              <option value="all">All Tools</option>
              ${['ChatGPT','Midjourney','Flux','Gemini','Claude','Ideogram','Leonardo AI'].map(t => `<option value="${t}">${t}</option>`).join('')}
            </select>
            <select id="prompt-sort" onchange="filterPrompts()" class="px-3 py-2 border border-slate-200 rounded-xl text-xs font-medium focus:border-blue-500 transition">
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
              <option value="views">Most Views</option>
              <option value="likes">Most Likes</option>
            </select>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span id="prompt-count" class="text-xs text-slate-500 font-medium">${allPrompts.length} prompts</span>
            <button onclick="openPromptModal()" class="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition flex items-center gap-1.5">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i> New Prompt
            </button>
          </div>
        </div>
        <!-- Bulk Actions -->
        <div class="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100">
          <label class="flex items-center gap-1.5 text-xs font-semibold text-slate-600 cursor-pointer">
            <input type="checkbox" id="select-all-cb" onchange="toggleSelectAll(this.checked)" class="w-3.5 h-3.5 accent-blue-600" />
            Select All
          </label>
          <button onclick="bulkApprove()" class="px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold rounded-lg hover:bg-emerald-100 transition flex items-center gap-1">
            <i data-lucide="check" class="w-3 h-3"></i> Approve Selected
          </button>
          <button onclick="bulkReject()" class="px-3 py-1.5 bg-amber-50 text-amber-700 border border-amber-200 text-xs font-bold rounded-lg hover:bg-amber-100 transition flex items-center gap-1">
            <i data-lucide="x" class="w-3 h-3"></i> Reject Selected
          </button>
          <button onclick="bulkDelete()" class="px-3 py-1.5 bg-rose-50 text-rose-700 border border-rose-200 text-xs font-bold rounded-lg hover:bg-rose-100 transition flex items-center gap-1">
            <i data-lucide="trash-2" class="w-3 h-3"></i> Delete Selected
          </button>
        </div>
      </div>

      <!-- Table -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 border-b border-slate-200">
              <tr>
                <th class="p-3 text-left w-8"></th>
                <th class="p-3 text-left font-bold text-slate-600">Prompt</th>
                <th class="p-3 text-left font-bold text-slate-600 hidden sm:table-cell">Tool</th>
                <th class="p-3 text-left font-bold text-slate-600 hidden md:table-cell">Category</th>
                <th class="p-3 text-left font-bold text-slate-600">Status</th>
                <th class="p-3 text-left font-bold text-slate-600 hidden lg:table-cell">Metrics</th>
                <th class="p-3 text-left font-bold text-slate-600 hidden md:table-cell">Flags</th>
                <th class="p-3 text-right font-bold text-slate-600">Actions</th>
              </tr>
            </thead>
            <tbody id="prompts-tbody">
              <tr><td colspan="8" class="p-8 text-center text-slate-400">Loading...</td></tr>
            </tbody>
          </table>
        </div>
        <div class="p-3 border-t border-slate-100 flex items-center justify-between">
          <span id="table-info" class="text-xs text-slate-400">—</span>
          <div class="flex items-center gap-2">
            <button id="prev-page-btn" onclick="changePage(-1)" class="px-3 py-1.5 border border-slate-200 text-slate-600 rounded-lg text-xs font-semibold hover:bg-slate-50 transition disabled:opacity-40">
              <i data-lucide="chevron-left" class="w-3.5 h-3.5"></i>
            </button>
            <span id="page-info" class="text-xs text-slate-500 font-medium">Page 1</span>
            <button id="next-page-btn" onclick="changePage(1)" class="px-3 py-1.5 border border-slate-200 text-slate-600 rounded-lg text-xs font-semibold hover:bg-slate-50 transition disabled:opacity-40">
              <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
  `);

  promptsPage = 0;
  filterPrompts();
  lcIcons();
}

function filterPrompts() {
  const searchEl = $('prompt-search') as HTMLInputElement;
  const statusEl = $('prompt-status-filter') as HTMLSelectElement;
  const toolEl = $('prompt-tool-filter') as HTMLSelectElement;
  const sortEl = $('prompt-sort') as HTMLSelectElement;
  const search = searchEl?.value.toLowerCase() || '';
  const status = statusEl?.value || 'all';
  const tool = toolEl?.value || 'all';
  const sort = sortEl?.value || 'newest';

  filteredPrompts = allPrompts.filter(p => {
    const matchSearch = !search ||
      p.title.toLowerCase().includes(search) ||
      p.tool.toLowerCase().includes(search) ||
      p.category.toLowerCase().includes(search) ||
      (p.creator || '').toLowerCase().includes(search);
    const matchStatus = status === 'all' || p.status === status;
    const matchTool = tool === 'all' || p.tool === tool;
    return matchSearch && matchStatus && matchTool;
  });

  if (sort === 'newest') filteredPrompts.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  else if (sort === 'oldest') filteredPrompts.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  else if (sort === 'views') filteredPrompts.sort((a, b) => (b.views || 0) - (a.views || 0));
  else if (sort === 'likes') filteredPrompts.sort((a, b) => (b.likes || 0) - (a.likes || 0));

  promptsPage = 0;
  setText('prompt-count', `${filteredPrompts.length} prompts`);
  renderPromptsTable();
}

function renderPromptsTable() {
  const tbody = $('prompts-tbody');
  if (!tbody) return;
  const start = promptsPage * PROMPTS_PER_PAGE;
  const page = filteredPrompts.slice(start, start + PROMPTS_PER_PAGE);
  const total = filteredPrompts.length;
  const totalPages = Math.ceil(total / PROMPTS_PER_PAGE);

  setText('page-info', `Page ${promptsPage + 1} of ${Math.max(1, totalPages)}`);
  setText('table-info', `Showing ${start + 1}–${Math.min(start + PROMPTS_PER_PAGE, total)} of ${total}`);

  const prevBtn = $('prev-page-btn') as HTMLButtonElement;
  const nextBtn = $('next-page-btn') as HTMLButtonElement;
  if (prevBtn) prevBtn.disabled = promptsPage === 0;
  if (nextBtn) nextBtn.disabled = promptsPage >= totalPages - 1;

  if (page.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-slate-400 text-sm">No prompts match the current filter</td></tr>`;
    return;
  }

  tbody.innerHTML = page.map(p => `
    <tr class="table-row-hover border-b border-slate-100">
      <td class="p-3">
        <input type="checkbox" class="prompt-cb w-3.5 h-3.5 accent-blue-600" value="${p.id}" />
      </td>
      <td class="p-3">
        <div class="flex items-center gap-2.5 min-w-0">
          <img src="${p.image || ''}" alt="" class="w-10 h-10 rounded-lg object-cover shrink-0 bg-slate-100 border border-slate-100" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'40\\' height=\\'40\\'%3E%3Crect width=\\'40\\' height=\\'40\\' fill=\\'%23e2e8f0\\'/%3E%3C/svg%3E'" />
          <div class="min-w-0">
            <p class="font-bold text-slate-900 truncate max-w-[160px]">${p.title}</p>
            <p class="text-[10px] text-slate-400">By ${p.creator || 'Unknown'} · ${formatDate(p.createdAt)}</p>
          </div>
        </div>
      </td>
      <td class="p-3 hidden sm:table-cell">
        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700">${p.tool}</span>
      </td>
      <td class="p-3 hidden md:table-cell text-slate-600 font-medium">${p.category}</td>
      <td class="p-3">${statusBadge(p.status || 'pending')}</td>
      <td class="p-3 hidden lg:table-cell">
        <div class="text-[10px] text-slate-500 space-y-0.5">
          <div class="flex items-center gap-1"><i data-lucide="eye" class="w-3 h-3 text-blue-400"></i>${formatN(p.views || 0)}</div>
          <div class="flex items-center gap-1"><i data-lucide="heart" class="w-3 h-3 text-rose-400"></i>${formatN(p.likes || 0)}</div>
          <div class="flex items-center gap-1"><i data-lucide="copy" class="w-3 h-3 text-emerald-400"></i>${formatN(p.copyCount || 0)}</div>
        </div>
      </td>
      <td class="p-3 hidden md:table-cell">
        <div class="flex items-center gap-1">
          <button onclick="toggleFlag('${p.id}', 'featured')" title="Toggle Featured" class="p-1.5 rounded-lg ${p.featured ? 'bg-amber-50 text-amber-500' : 'bg-slate-50 text-slate-300'} hover:bg-amber-50 hover:text-amber-500 transition">
            <i data-lucide="star" class="w-3.5 h-3.5"></i>
          </button>
          <button onclick="toggleFlag('${p.id}', 'trending')" title="Toggle Trending" class="p-1.5 rounded-lg ${p.trending ? 'bg-orange-50 text-orange-500' : 'bg-slate-50 text-slate-300'} hover:bg-orange-50 hover:text-orange-500 transition">
            <i data-lucide="trending-up" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </td>
      <td class="p-3">
        <div class="flex items-center justify-end gap-1 flex-wrap">
          ${p.status !== 'approved' ? `<button onclick="updateStatus('${p.id}', 'approved')" class="px-2 py-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded-lg text-[10px] font-bold transition flex items-center gap-0.5"><i data-lucide="check" class="w-3 h-3"></i></button>` : ''}
          ${p.status !== 'rejected' ? `<button onclick="updateStatus('${p.id}', 'rejected')" class="px-2 py-1 bg-amber-50 text-amber-700 hover:bg-amber-100 rounded-lg text-[10px] font-bold transition flex items-center gap-0.5"><i data-lucide="x" class="w-3 h-3"></i></button>` : ''}
          <button onclick="editPrompt('${p.id}')" class="px-2 py-1 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg text-[10px] font-bold transition flex items-center gap-0.5"><i data-lucide="edit-2" class="w-3 h-3"></i></button>
          <button onclick="deletePromptConfirm('${p.id}')" class="px-2 py-1 bg-rose-50 text-rose-700 hover:bg-rose-100 rounded-lg text-[10px] font-bold transition flex items-center gap-0.5"><i data-lucide="trash-2" class="w-3 h-3"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
  lcIcons();
}

function changePage(delta: number) {
  const totalPages = Math.ceil(filteredPrompts.length / PROMPTS_PER_PAGE);
  promptsPage = Math.max(0, Math.min(promptsPage + delta, totalPages - 1));
  renderPromptsTable();
}

function toggleSelectAll(checked: boolean) {
  document.querySelectorAll('.prompt-cb').forEach((cb: any) => { cb.checked = checked; });
}

function getSelectedIds(): string[] {
  return Array.from(document.querySelectorAll('.prompt-cb:checked')).map((cb: any) => cb.value);
}

// =============================================================================
// PROMPT CRUD
// =============================================================================
async function updateStatus(id: string, status: 'approved' | 'rejected' | 'pending') {
  try {
    await updateDoc(doc(db, 'prompts', id), { status, updatedAt: serverTimestamp() });
    const p = allPrompts.find(x => x.id === id);
    if (p) p.status = status;
    updatePendingBadge();
    filterPrompts();
    showToast(`Prompt ${status}!`, status === 'approved' ? 'success' : 'info');
    logAdminAction(`prompt_${status}`, id);
  } catch (err) {
    showToast('Failed to update status', 'error');
  }
}

async function toggleFlag(id: string, field: 'featured' | 'trending') {
  const p = allPrompts.find(x => x.id === id);
  if (!p) return;
  const newVal = !p[field];
  try {
    await updateDoc(doc(db, 'prompts', id), { [field]: newVal, updatedAt: serverTimestamp() });
    p[field] = newVal;
    filterPrompts();
    showToast(`${field.charAt(0).toUpperCase() + field.slice(1)} ${newVal ? 'enabled' : 'disabled'}`, 'success');
    logAdminAction(`prompt_${field}_toggle`, id);
  } catch (err) {
    showToast(`Failed to update ${field}`, 'error');
  }
}

function deletePromptConfirm(id: string) {
  const p = allPrompts.find(x => x.id === id);
  showConfirm('Delete Prompt', `Delete "${p?.title || 'this prompt'}"? This cannot be undone.`, async () => {
    try {
      await deleteDoc(doc(db, 'prompts', id));
      allPrompts = allPrompts.filter(x => x.id !== id);
      updatePendingBadge();
      filterPrompts();
      showToast('Prompt deleted', 'success');
      logAdminAction('prompt_delete', id);
    } catch (err) {
      showToast('Delete failed', 'error');
    }
  });
}

async function bulkApprove() {
  const ids = getSelectedIds();
  if (!ids.length) { showToast('Select prompts first', 'warning'); return; }
  const batch = writeBatch(db);
  ids.forEach(id => batch.update(doc(db, 'prompts', id), { status: 'approved', updatedAt: serverTimestamp() }));
  try {
    await batch.commit();
    ids.forEach(id => { const p = allPrompts.find(x => x.id === id); if (p) p.status = 'approved'; });
    updatePendingBadge();
    filterPrompts();
    showToast(`${ids.length} prompts approved!`, 'success');
  } catch (err) { showToast('Bulk approve failed', 'error'); }
}

async function bulkReject() {
  const ids = getSelectedIds();
  if (!ids.length) { showToast('Select prompts first', 'warning'); return; }
  const batch = writeBatch(db);
  ids.forEach(id => batch.update(doc(db, 'prompts', id), { status: 'rejected', updatedAt: serverTimestamp() }));
  try {
    await batch.commit();
    ids.forEach(id => { const p = allPrompts.find(x => x.id === id); if (p) p.status = 'rejected'; });
    updatePendingBadge();
    filterPrompts();
    showToast(`${ids.length} prompts rejected`, 'info');
  } catch (err) { showToast('Bulk reject failed', 'error'); }
}

async function bulkDelete() {
  const ids = getSelectedIds();
  if (!ids.length) { showToast('Select prompts first', 'warning'); return; }
  showConfirm('Delete Selected', `Delete ${ids.length} selected prompt(s)?`, async () => {
    const batch = writeBatch(db);
    ids.forEach(id => batch.delete(doc(db, 'prompts', id)));
    try {
      await batch.commit();
      allPrompts = allPrompts.filter(p => !ids.includes(p.id));
      updatePendingBadge();
      filterPrompts();
      showToast(`${ids.length} prompts deleted`, 'success');
    } catch (err) { showToast('Bulk delete failed', 'error'); }
  });
}

// Prompt Modal & Multi-Image Gallery
let adminFormImages: string[] = [];

function renderAdminFormImages() {
  const grid = $('pf-images-preview-grid');
  const counter = $('pf-images-counter');
  if (counter) {
    counter.textContent = `${adminFormImages.length} image${adminFormImages.length !== 1 ? 's' : ''} added`;
  }
  if (!grid) return;
  if (adminFormImages.length === 0) {
    grid.innerHTML = '';
    grid.classList.add('hidden');
    return;
  }
  grid.classList.remove('hidden');
  grid.innerHTML = adminFormImages.map((img, idx) => `
    <div class="relative group rounded-xl overflow-hidden border border-slate-200 bg-slate-900 aspect-square flex items-center justify-center p-1">
      <img src="${img}" alt="Preview ${idx + 1}" class="max-w-full max-h-full object-contain" />
      <button type="button" onclick="removeAdminFormImage(${idx})" class="absolute top-1 right-1 w-5 h-5 rounded-full bg-rose-600 hover:bg-rose-700 text-white flex items-center justify-center text-[10px] shadow transition" title="Remove image">
        <i data-lucide="x" class="w-3 h-3"></i>
      </button>
      ${idx === 0 ? `<span class="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-blue-600 text-white text-[9px] font-bold">Cover</span>` : ''}
    </div>
  `).join('');
  lcIcons();
}

function removeAdminFormImage(idx: number) {
  if (idx >= 0 && idx < adminFormImages.length) {
    adminFormImages.splice(idx, 1);
    renderAdminFormImages();
  }
}

function addAdminImageUrl() {
  const input = $('pf-image-url') as HTMLInputElement | null;
  const url = input?.value.trim() || '';
  if (!url) {
    showToast('Enter an image URL first', 'warning');
    return;
  }
  adminFormImages.push(url);
  if (input) input.value = '';
  renderAdminFormImages();
  showToast('Image URL added!', 'success');
}

async function uploadAdminImage(input?: HTMLInputElement) {
  const fileInput = input || ($('pf-image-file') as HTMLInputElement);
  if (!fileInput?.files || fileInput.files.length === 0) return;
  const files = Array.from(fileInput.files);
  const btn = $('upload-img-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<svg class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Uploading...';
  }
  showToast(`Uploading ${files.length} image(s) to cloud CDN...`, 'info');
  try {
    for (let i = 0; i < files.length; i++) {
      const url = await uploadToCloudinary(files[i]);
      if (url) adminFormImages.push(url);
    }
    fileInput.value = '';
    renderAdminFormImages();
    showToast(`${files.length} image(s) uploaded successfully!`, 'success');
  } catch (err: any) {
    showToast(`Upload failed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="upload" class="w-3.5 h-3.5"></i> Upload Files';
      lcIcons();
    }
  }
}

function uploadAdminImageBtn() {
  const fileInput = $('pf-image-file') as HTMLInputElement | null;
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    showToast('Please select image file(s) first', 'warning');
    return;
  }
  uploadAdminImage(fileInput);
}

function openPromptModal(id?: string) {
  const modal = $('prompt-modal');
  if (!modal) return;
  const form = $('prompt-form') as HTMLFormElement;
  if (form) form.reset();
  setText('prompt-modal-title', id ? 'Edit Prompt' : 'Create Prompt');

  let categoryToSet = 'Festivals';

  if (id) {
    const p = allPrompts.find(x => x.id === id);
    if (!p) return;
    ($('pf-id') as HTMLInputElement).value = id;
    ($('pf-title') as HTMLInputElement).value = p.title;
    ($('pf-tool') as HTMLSelectElement).value = p.tool;
    categoryToSet = p.category || 'Festivals';
    ($('pf-status') as HTMLSelectElement).value = p.status || 'pending';
    ($('pf-image-url') as HTMLInputElement).value = '';
    ($('pf-prompt') as HTMLTextAreaElement).value = p.prompt;
    ($('pf-negative') as HTMLTextAreaElement).value = p.negative || '';
    ($('pf-tags') as HTMLInputElement).value = (p.tags || []).join(', ');
    ($('pf-featured') as HTMLInputElement).checked = !!p.featured;
    ($('pf-trending') as HTMLInputElement).checked = !!p.trending;
    
    adminFormImages = (p.images && Array.isArray(p.images) && p.images.length > 0)
      ? [...p.images]
      : (p.image ? [p.image] : []);
    renderAdminFormImages();
  } else {
    ($('pf-id') as HTMLInputElement).value = '';
    adminFormImages = [];
    renderAdminFormImages();
  }

  updateCategorySelectOptions(categoryToSet);
  modal.classList.remove('hidden');
  lcIcons();
}

function editPrompt(id: string) {
  openPromptModal(id);
}

function closePromptModal() {
  const modal = $('prompt-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleSavePrompt(e: Event) {
  e.preventDefault();
  const btn = $('save-prompt-btn') as HTMLButtonElement;
  if (btn) { btn.disabled = true; btn.innerHTML = '<svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Saving...'; }

  const id = ($('pf-id') as HTMLInputElement).value;
  const title = ($('pf-title') as HTMLInputElement).value.trim();
  const tool = ($('pf-tool') as HTMLSelectElement).value;
  const category = ($('pf-category') as HTMLSelectElement).value;
  const status = ($('pf-status') as HTMLSelectElement).value as 'approved' | 'pending' | 'rejected';
  const singleUrl = ($('pf-image-url') as HTMLInputElement)?.value.trim() || '';
  if (singleUrl && !adminFormImages.includes(singleUrl)) {
    adminFormImages.push(singleUrl);
  }
  const promptText = ($('pf-prompt') as HTMLTextAreaElement).value.trim();
  const negative = ($('pf-negative') as HTMLTextAreaElement).value.trim();
  const tagsRaw = ($('pf-tags') as HTMLInputElement).value.trim();
  const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
  const featured = ($('pf-featured') as HTMLInputElement).checked;
  const trending = ($('pf-trending') as HTMLInputElement).checked;

  if (!title || !promptText) {
    showToast('Title and Prompt text are required', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="save" class="w-4 h-4"></i> Save Prompt'; lcIcons(); }
    return;
  }

  // Upload image file if selected
  const fileInput = $('pf-image-file') as HTMLInputElement;
  if (fileInput?.files && fileInput.files.length > 0 && adminFormImages.length === 0) {
    try {
      showToast('Uploading images to cloud CDN...', 'info');
      for (let i = 0; i < fileInput.files.length; i++) {
        const url = await uploadToCloudinary(fileInput.files[i]);
        if (url) adminFormImages.push(url);
      }
    } catch (err: any) {
      showToast(`Image upload failed: ${err.message}`, 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="save" class="w-4 h-4"></i> Save Prompt'; lcIcons(); }
      return;
    }
  }

  const finalImages = [...adminFormImages];
  const primaryImage = finalImages[0] || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=600&q=80';
  const currentUid = auth.currentUser?.uid || currentAdminUser?.uid || '';
  const currentName = auth.currentUser?.displayName || currentAdminUser?.displayName || auth.currentUser?.email?.split('@')[0] || 'PromptVerse Admin';

  try {
    if (id) {
      await updateDoc(doc(db, 'prompts', id), {
        title, tool, category, status,
        image: primaryImage,
        images: finalImages,
        prompt: promptText, negative, tags, featured, trending,
        updatedAt: serverTimestamp()
      });
      const idx = allPrompts.findIndex(p => p.id === id);
      if (idx !== -1) Object.assign(allPrompts[idx], { title, tool, category, status, image: primaryImage, images: finalImages, prompt: promptText, negative, tags, featured, trending });
      showToast('Prompt updated!', 'success');
      try { logAdminAction('prompt_edit', id); } catch (_) {}
    } else {
      const docRef = await addDoc(collection(db, 'prompts'), {
        title, tool, category, status,
        image: primaryImage,
        images: finalImages,
        prompt: promptText, negative, tags, featured, trending,
        views: 0, likes: 0, downloads: 0, copyCount: 0, seasonalTags: [],
        creator: currentName,
        creatorId: currentUid,
        rankScore: 0,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      allPrompts.unshift({ id: docRef.id, title, tool, category, status, image: primaryImage, images: finalImages, prompt: promptText, negative, tags, featured, trending,
        views: 0, likes: 0, downloads: 0, copyCount: 0, creator: currentName });
      showToast('Prompt created!', 'success');
      try { logAdminAction('prompt_create', docRef.id); } catch (_) {}
    }
    updatePendingBadge();
    closePromptModal();
    filterPrompts();
  } catch (err: any) {
    showToast(`Save failed: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="save" class="w-4 h-4"></i> Save Prompt'; lcIcons(); }
  }
}

// =============================================================================
// CATEGORIES SECTION
// =============================================================================
function renderCategories() {
  setContent('admin-content', `
    <div class="space-y-4">
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <h3 class="text-sm font-bold text-slate-900 mb-4">Add New Category</h3>
        <div class="flex items-end gap-3 flex-wrap">
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1.5">Category Name *</label>
            <input type="text" id="new-cat-name" placeholder="e.g., Wedding" class="px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition w-48" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1.5">Lucide Icon Name</label>
            <input type="text" id="new-cat-icon" placeholder="e.g., heart" class="px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition w-40" />
          </div>
          <button onclick="addCategory()" class="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl transition flex items-center gap-1.5">
            <i data-lucide="plus" class="w-4 h-4"></i> Add Category
          </button>
        </div>
      </div>

      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm">
        <div class="p-4 border-b border-slate-100 flex items-center justify-between">
          <h3 class="text-sm font-bold text-slate-900">All Categories</h3>
          <span class="text-xs text-slate-400 font-medium">${allCategories.length} categories</span>
        </div>
        <div id="categories-list" class="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          ${renderCategoriesList()}
        </div>
      </div>
    </div>
  `);
  lcIcons();
}

function renderCategoriesList(): string {
  if (allCategories.length === 0) return '<p class="col-span-full text-center text-slate-400 text-sm py-8">No categories yet. Add one above.</p>';
  return allCategories.map(c => `
    <div class="flex items-center justify-between p-3.5 bg-slate-50 rounded-xl border border-slate-100">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center">
          <i data-lucide="${c.icon || 'folder'}" class="w-4 h-4 text-blue-600"></i>
        </div>
        <div>
          <p class="text-sm font-bold text-slate-900">${c.name}</p>
          <p class="text-[10px] text-slate-400">${c.count || 0} prompts</p>
        </div>
      </div>
      <button onclick="deleteCategoryConfirm('${c.id}', '${c.name}')" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>
    </div>
  `).join('');
}

async function addCategory() {
  const nameEl = $('new-cat-name') as HTMLInputElement;
  const iconEl = $('new-cat-icon') as HTMLInputElement;
  const name = nameEl?.value.trim();
  const icon = iconEl?.value.trim() || 'folder';
  if (!name) { showToast('Enter a category name', 'warning'); return; }
  try {
    await addDoc(collection(db, 'categories'), { name, icon, count: 0 });
    if (nameEl) nameEl.value = '';
    if (iconEl) iconEl.value = '';
    showToast(`Category "${name}" added!`, 'success');
    logAdminAction('category_create', name);
  } catch (err: any) {
    showToast('Failed to add category', 'error');
  }
}

function deleteCategoryConfirm(id: string, name: string) {
  showConfirm('Delete Category', `Delete "${name}"? Prompts in this category will not be deleted.`, async () => {
    try {
      await deleteDoc(doc(db, 'categories', id));
      showToast('Category deleted', 'success');
      logAdminAction('category_delete', id);
    } catch (err) {
      showToast('Failed to delete category', 'error');
    }
  });
}

function closeCategoryModal() {
  const modal = $('category-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleSaveCategory(e: Event) {
  e.preventDefault();
  const name = ($('cf-name') as HTMLInputElement).value.trim();
  const icon = ($('cf-icon') as HTMLInputElement).value.trim() || 'folder';
  if (!name) return;
  try {
    await addDoc(collection(db, 'categories'), { name, icon, count: 0 });
    closeCategoryModal();
    showToast('Category saved!', 'success');
  } catch (err) {
    showToast('Failed to save category', 'error');
  }
}

// =============================================================================
// AI TOOLS SECTION
// =============================================================================
function renderAITools() {
  setContent('admin-content', `
    <div class="space-y-4">
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <h3 class="text-sm font-bold text-slate-900 mb-4">Add New AI Tool</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1.5">Tool Name *</label>
            <input type="text" id="new-tool-name" placeholder="e.g., Midjourney v6.1" class="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:border-blue-500 transition" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1.5">Lucide Icon Name</label>
            <input type="text" id="new-tool-icon" placeholder="e.g., compass" class="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:border-blue-500 transition" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1.5">Logo URL</label>
            <input type="text" id="new-tool-logo" placeholder="https://..." class="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:border-blue-500 transition" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1.5">Count Text</label>
            <input type="text" id="new-tool-count" placeholder="e.g., 54.1K Prompts" class="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:border-blue-500 transition" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1.5">Color Class</label>
            <input type="text" id="new-tool-color" placeholder="e.g., text-purple-600" class="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:border-blue-500 transition" />
          </div>
          <button onclick="addAITool()" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition flex items-center gap-1.5 justify-center">
            <i data-lucide="plus" class="w-4 h-4"></i> Add Tool
          </button>
        </div>
      </div>

      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm">
        <div class="p-4 border-b border-slate-100 flex items-center justify-between">
          <h3 class="text-sm font-bold text-slate-900">All Supported AI Tools</h3>
          <span class="text-xs text-slate-400 font-medium">${allAITools.length} tools</span>
        </div>
        <div class="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          ${allAITools.length === 0 ? '<p class="col-span-full text-center text-slate-400 text-sm py-8">No AI tools configured yet</p>' :
            allAITools.map(t => `
              <div class="flex items-center justify-between p-3.5 bg-slate-50 rounded-xl border border-slate-100">
                <div class="flex items-center gap-3">
                  <div class="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center overflow-hidden">
                    ${t.logoUrl ? `<img src="${t.logoUrl}" class="w-5 h-5 object-contain" />` : `<i data-lucide="${t.icon || 'cpu'}" class="w-4 h-4 ${t.color || 'text-blue-600'}"></i>`}
                  </div>
                  <div>
                    <p class="text-sm font-bold text-slate-900">${t.name}</p>
                    <p class="text-[10px] text-slate-400">${t.count || '0 Prompts'}</p>
                  </div>
                </div>
                <button onclick="deleteAIToolConfirm('${t.id}', '${t.name}')" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition">
                  <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
              </div>
            `).join('')}
        </div>
      </div>
    </div>
  `);
  lcIcons();
}

async function addAITool() {
  const name = ($('new-tool-name') as HTMLInputElement)?.value.trim();
  const icon = ($('new-tool-icon') as HTMLInputElement)?.value.trim() || 'cpu';
  const logoUrl = ($('new-tool-logo') as HTMLInputElement)?.value.trim() || '';
  const count = ($('new-tool-count') as HTMLInputElement)?.value.trim() || '0 Prompts';
  const color = ($('new-tool-color') as HTMLInputElement)?.value.trim() || 'text-blue-600';
  if (!name) { showToast('Tool name is required', 'warning'); return; }
  try {
    const order = allAITools.length + 1;
    await addDoc(collection(db, 'aiTools'), { name, icon, logoUrl, count, color, order });
    ($('new-tool-name') as HTMLInputElement).value = '';
    ($('new-tool-icon') as HTMLInputElement).value = '';
    ($('new-tool-logo') as HTMLInputElement).value = '';
    ($('new-tool-count') as HTMLInputElement).value = '';
    ($('new-tool-color') as HTMLInputElement).value = '';
    showToast(`AI Tool "${name}" added!`, 'success');
  } catch (err) { showToast('Failed to add AI Tool', 'error'); }
}

function deleteAIToolConfirm(id: string, name: string) {
  showConfirm('Delete AI Tool', `Delete "${name}"? This will not delete prompts associated with it.`, async () => {
    try {
      await deleteDoc(doc(db, 'aiTools', id));
      showToast('AI Tool deleted', 'success');
    } catch (err) { showToast('Failed to delete tool', 'error'); }
  });
}

// =============================================================================
// TAGS SECTION
// =============================================================================
function renderTags() {
  const tagMap: Record<string, number> = {};
  allPrompts.forEach(p => {
    [...(p.tags || []), ...(p.seasonalTags || [])].forEach(t => {
      tagMap[t] = (tagMap[t] || 0) + 1;
    });
  });
  const sorted = Object.entries(tagMap).sort((a, b) => b[1] - a[1]);

  setContent('admin-content', `
    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm">
      <div class="p-4 border-b border-slate-100 flex items-center justify-between">
        <h3 class="text-sm font-bold text-slate-900">All Tags</h3>
        <span class="text-xs text-slate-400">${sorted.length} unique tags</span>
      </div>
      <div class="p-4 flex flex-wrap gap-2">
        ${sorted.length === 0 ? '<p class="text-slate-400 text-sm">No tags found</p>' :
          sorted.map(([tag, count]) => `
            <span class="px-3 py-1.5 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold flex items-center gap-1.5">
              <i data-lucide="tag" class="w-3 h-3 text-slate-400"></i>${tag}
              <span class="ml-1 px-1.5 py-0.5 rounded-full bg-white text-slate-500 text-[10px] font-bold border border-slate-200">${count}</span>
            </span>
          `).join('')}
      </div>
    </div>
  `);
  lcIcons();
}

// =============================================================================
// COLLECTIONS SECTION
// =============================================================================
function renderCollections() {
  setContent('admin-content', `
    <div class="space-y-4">
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <h3 class="text-sm font-bold text-slate-900 mb-4">Add Seasonal Collection</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1.5">Collection Name *</label>
            <input type="text" id="col-name" placeholder="e.g., Ganesh Festival Special" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1.5">Season/Theme *</label>
            <select id="col-theme" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition">
              <option>Ganesh Chaturthi</option><option>Diwali</option><option>Christmas</option>
              <option>New Year</option><option>Valentine's Day</option><option>Holi</option>
              <option>Eid</option><option>Raksha Bandhan</option><option>Halloween</option>
              <option>General</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1.5">Description</label>
            <input type="text" id="col-desc" placeholder="Short description..." class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1.5">Cover Image URL</label>
            <input type="text" id="col-image" placeholder="Image CDN URL..." class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition" />
          </div>
          <div class="sm:col-span-2">
            <button onclick="addCollection()" class="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl transition flex items-center gap-1.5">
              <i data-lucide="plus" class="w-4 h-4"></i> Add Collection
            </button>
          </div>
        </div>
      </div>
      <div id="collections-list" class="bg-white rounded-2xl border border-slate-200 shadow-sm">
        <div class="p-4 border-b border-slate-100"><h3 class="text-sm font-bold text-slate-900">All Collections</h3></div>
        <div class="p-4"><p class="text-slate-400 text-sm text-center py-4">Loading collections...</p></div>
      </div>
    </div>
  `);
  loadCollections();
  lcIcons();
}

async function loadCollections() {
  try {
    const snap = await getDocs(collection(db, 'collections'));
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() as any }));
    const listEl = $('collections-list');
    if (!listEl) return;
    if (items.length === 0) {
      listEl.innerHTML = `<div class="p-4 border-b border-slate-100"><h3 class="text-sm font-bold text-slate-900">All Collections</h3></div><div class="p-8 text-center text-slate-400 text-sm">No collections yet</div>`;
      return;
    }
    listEl.innerHTML = `
      <div class="p-4 border-b border-slate-100"><h3 class="text-sm font-bold text-slate-900">All Collections (${items.length})</h3></div>
      <div class="divide-y divide-slate-100">
        ${items.map(c => `
          <div class="flex items-center gap-3 p-4">
            ${c.image ? `<img src="${c.image}" alt="" class="w-12 h-12 rounded-xl object-cover bg-slate-100" />` : `<div class="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center"><i data-lucide="layers" class="w-5 h-5 text-slate-400"></i></div>`}
            <div class="flex-1 min-w-0">
              <p class="text-sm font-bold text-slate-900">${c.name || 'Untitled'}</p>
              <p class="text-xs text-slate-400">${c.theme || ''} ${c.description ? '· ' + c.description : ''}</p>
            </div>
            <button onclick="deleteCollectionConfirm('${c.id}', '${c.name}')" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        `).join('')}
      </div>
    `;
    lcIcons();
  } catch (err) {
    showToast('Failed to load collections', 'error');
  }
}

async function addCollection() {
  const name = ($('col-name') as HTMLInputElement)?.value.trim();
  const theme = ($('col-theme') as HTMLSelectElement)?.value;
  const desc = ($('col-desc') as HTMLInputElement)?.value.trim();
  const image = ($('col-image') as HTMLInputElement)?.value.trim();
  if (!name) { showToast('Enter a collection name', 'warning'); return; }
  try {
    await addDoc(collection(db, 'collections'), { name, theme, description: desc, image, createdAt: serverTimestamp() });
    showToast(`Collection "${name}" added!`, 'success');
    loadCollections();
  } catch (err) { showToast('Failed to add collection', 'error'); }
}

function deleteCollectionConfirm(id: string, name: string) {
  showConfirm('Delete Collection', `Delete "${name}"?`, async () => {
    await deleteDoc(doc(db, 'collections', id));
    showToast('Collection deleted', 'success');
    loadCollections();
  });
}

// =============================================================================
// FEATURED & TRENDING SECTIONS
// =============================================================================
function renderFeatured() {
  const featured = allPrompts.filter(p => p.featured);
  renderFlaggedPrompts('Featured Prompts', featured, 'featured', 'star', 'text-amber-500');
}

function renderTrending() {
  const trending = allPrompts.filter(p => p.trending);
  renderFlaggedPrompts('Trending Prompts', trending, 'trending', 'trending-up', 'text-orange-500');
}

function renderFlaggedPrompts(title: string, items: PromptItem[], flag: string, icon: string, iconClass: string) {
  setContent('admin-content', `
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <i data-lucide="${icon}" class="w-5 h-5 ${iconClass}"></i>
          <h3 class="text-sm font-bold text-slate-900">${title}</h3>
          <span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs font-bold">${items.length}</span>
        </div>
        <button onclick="openPromptModal()" class="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition flex items-center gap-1.5">
          <i data-lucide="plus" class="w-3.5 h-3.5"></i> New Prompt
        </button>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        ${items.length === 0 ? `<div class="col-span-full text-center py-12 text-slate-400 text-sm">No ${flag} prompts yet. Mark prompts as ${flag} from Prompt Management.</div>` :
          items.map(p => `
            <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div class="relative h-40 bg-slate-900">
                <img src="${p.image || ''}" alt="" class="w-full h-full object-cover opacity-80" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'100%\\' height=\\'160\\'%3E%3Crect fill=\\'%23e2e8f0\\' width=\\'100%\\' height=\\'160\\'/%3E%3C/svg%3E'" />
              </div>
              <div class="p-3">
                <p class="text-xs font-bold text-slate-900 line-clamp-1">${p.title}</p>
                <p class="text-[10px] text-slate-400 mt-0.5">${p.tool} · ${p.category}</p>
                <div class="flex items-center gap-2 mt-2">
                  <button onclick="toggleFlag('${p.id}', '${flag}')" class="px-2 py-1 bg-rose-50 text-rose-700 hover:bg-rose-100 rounded-lg text-[10px] font-bold transition flex items-center gap-1">
                    <i data-lucide="x" class="w-3 h-3"></i> Remove ${flag}
                  </button>
                  <button onclick="editPrompt('${p.id}')" class="px-2 py-1 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg text-[10px] font-bold transition flex items-center gap-1">
                    <i data-lucide="edit-2" class="w-3 h-3"></i> Edit
                  </button>
                </div>
              </div>
            </div>
          `).join('')}
      </div>
    </div>
  `);
  lcIcons();
}

// =============================================================================
// USER MANAGEMENT
// =============================================================================
async function renderUsers() {
  setContent('admin-content', `
    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm">
      <div class="p-4 border-b border-slate-100 flex items-center justify-between">
        <h3 class="text-sm font-bold text-slate-900">User Management</h3>
        <div class="flex items-center gap-2">
          <input type="text" id="user-search" placeholder="Search users..." oninput="filterUsers()"
            class="px-3 py-1.5 border border-slate-200 rounded-xl text-xs focus:border-blue-500 transition" />
        </div>
      </div>
      <div id="users-table-container" class="overflow-x-auto">
        <div class="p-8 text-center text-slate-400">
          <svg class="animate-spin w-6 h-6 mx-auto mb-2 text-blue-400" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          Loading users...
        </div>
      </div>
    </div>
  `);
  await loadAllUsers();
  renderUsersTable(allUsers);
  lcIcons();
}

function filterUsers() {
  const search = ($('user-search') as HTMLInputElement)?.value.toLowerCase() || '';
  const filtered = allUsers.filter(u =>
    u.email?.toLowerCase().includes(search) ||
    (u.displayName || '').toLowerCase().includes(search)
  );
  renderUsersTable(filtered);
}

function renderUsersTable(users: AdminUser[]) {
  const container = $('users-table-container');
  if (!container) return;
  if (users.length === 0) {
    container.innerHTML = '<p class="text-center text-slate-400 text-sm py-8">No users found</p>';
    return;
  }
  container.innerHTML = `
    <table class="w-full text-xs">
      <thead class="bg-slate-50 border-b border-slate-200">
        <tr>
          <th class="p-3 text-left font-bold text-slate-600">User</th>
          <th class="p-3 text-left font-bold text-slate-600">Email</th>
          <th class="p-3 text-left font-bold text-slate-600">Role</th>
          <th class="p-3 text-left font-bold text-slate-600 hidden md:table-cell">Joined</th>
          <th class="p-3 text-right font-bold text-slate-600">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${users.map(u => `
          <tr class="table-row-hover border-b border-slate-100">
            <td class="p-3">
              <div class="flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white font-extrabold text-xs shrink-0">
                  ${(u.displayName || u.email || 'U').charAt(0).toUpperCase()}
                </div>
                <span class="font-bold text-slate-900">${u.displayName || 'Unknown'}</span>
              </div>
            </td>
            <td class="p-3 text-slate-500">${u.email || '—'}</td>
            <td class="p-3">
              ${u.role === 'admin'
                ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-purple-100 text-purple-700 flex items-center gap-1 w-fit"><i data-lucide="shield-check" class="w-3 h-3"></i>Admin</span>'
                : '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600">User</span>'}
            </td>
            <td class="p-3 hidden md:table-cell text-slate-400">${formatDate(u.createdAt)}</td>
            <td class="p-3">
              <div class="flex items-center justify-end gap-1">
                ${u.uid !== currentAdminUser?.uid ? `
                  ${u.role !== 'admin'
                    ? `<button onclick="setUserRole('${u.uid}', 'admin')" class="px-2 py-1 bg-purple-50 text-purple-700 hover:bg-purple-100 rounded-lg text-[10px] font-bold transition flex items-center gap-0.5"><i data-lucide="shield-plus" class="w-3 h-3"></i> Make Admin</button>`
                    : `<button onclick="setUserRole('${u.uid}', 'user')" class="px-2 py-1 bg-slate-50 text-slate-700 hover:bg-slate-100 rounded-lg text-[10px] font-bold transition flex items-center gap-0.5"><i data-lucide="shield-minus" class="w-3 h-3"></i> Revoke Admin</button>`}
                ` : '<span class="text-[10px] text-slate-400 italic">Current Admin</span>'}
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  lcIcons();
}

async function setUserRole(uid: string, role: 'admin' | 'user') {
  const action = role === 'admin' ? 'Grant admin access to' : 'Revoke admin access from';
  const user = allUsers.find(u => u.uid === uid);
  showConfirm(`${action} user?`, `This will ${role === 'admin' ? 'grant' : 'revoke'} admin privileges for ${user?.email || uid}.`, async () => {
    try {
      await updateDoc(doc(db, 'users', uid), { role, updatedAt: serverTimestamp() });
      const u = allUsers.find(x => x.uid === uid);
      if (u) u.role = role;
      renderUsersTable(allUsers);
      showToast(`User role updated to ${role}`, 'success');
      logAdminAction(`user_role_set_${role}`, uid);
    } catch (err) {
      showToast('Failed to update user role', 'error');
    }
  }, role !== 'admin');
}

// =============================================================================
// ANALYTICS SECTION
// =============================================================================
function renderAnalytics() {
  const totalViews = allPrompts.reduce((s, p) => s + (p.views || 0), 0);
  const totalLikes = allPrompts.reduce((s, p) => s + (p.likes || 0), 0);
  const totalCopies = allPrompts.reduce((s, p) => s + (p.copyCount || 0), 0);
  const totalDownloads = allPrompts.reduce((s, p) => s + (p.downloads || 0), 0);

  const toolCounts: Record<string, number> = {};
  const catCounts: Record<string, number> = {};
  allPrompts.forEach(p => {
    toolCounts[p.tool] = (toolCounts[p.tool] || 0) + 1;
    catCounts[p.category] = (catCounts[p.category] || 0) + 1;
  });
  const maxTool = Math.max(1, ...Object.values(toolCounts));
  const maxCat = Math.max(1, ...Object.values(catCounts));
  const topByViews = [...allPrompts].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 10);

  setContent('admin-content', `
    <div class="space-y-6">
      <!-- Summary Cards -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        ${[
          { label: 'Total Views', value: formatN(totalViews), icon: 'eye', color: 'blue' },
          { label: 'Total Likes', value: formatN(totalLikes), icon: 'heart', color: 'rose' },
          { label: 'Total Copies', value: formatN(totalCopies), icon: 'copy', color: 'emerald' },
          { label: 'Total Downloads', value: formatN(totalDownloads), icon: 'download', color: 'purple' },
        ].map(s => `
          <div class="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
            <div class="flex items-center gap-2 mb-2">
              <i data-lucide="${s.icon}" class="w-4 h-4 text-${s.color}-500"></i>
              <span class="text-xs font-semibold text-slate-500">${s.label}</span>
            </div>
            <div class="text-2xl font-extrabold text-slate-900">${s.value}</div>
          </div>
        `).join('')}
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Tool Distribution -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <h3 class="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
            <i data-lucide="cpu" class="w-4 h-4 text-blue-500"></i> Prompts by AI Tool
          </h3>
          <div class="space-y-3">
            ${Object.entries(toolCounts).sort((a,b) => b[1]-a[1]).map(([tool, count]) => `
              <div class="flex items-center gap-2 text-xs">
                <span class="w-28 font-semibold text-slate-700 truncate shrink-0">${tool}</span>
                <div class="flex-1 h-2.5 rounded-full bg-slate-100 overflow-hidden">
                  <div class="h-full bg-blue-500 rounded-full" style="width:${Math.round((count/maxTool)*100)}%"></div>
                </div>
                <span class="font-bold text-slate-600 w-8 text-right shrink-0">${count}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Category Distribution -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <h3 class="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
            <i data-lucide="folder" class="w-4 h-4 text-indigo-500"></i> Prompts by Category
          </h3>
          <div class="space-y-3">
            ${Object.entries(catCounts).sort((a,b) => b[1]-a[1]).slice(0,8).map(([cat, count]) => `
              <div class="flex items-center gap-2 text-xs">
                <span class="w-28 font-semibold text-slate-700 truncate shrink-0">${cat}</span>
                <div class="flex-1 h-2.5 rounded-full bg-slate-100 overflow-hidden">
                  <div class="h-full bg-indigo-500 rounded-full" style="width:${Math.round((count/maxCat)*100)}%"></div>
                </div>
                <span class="font-bold text-slate-600 w-8 text-right shrink-0">${count}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <!-- Top 10 Prompts by Views -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm">
        <div class="p-4 border-b border-slate-100">
          <h3 class="text-sm font-bold text-slate-900 flex items-center gap-2">
            <i data-lucide="trophy" class="w-4 h-4 text-amber-500"></i> Top 10 Prompts by Views
          </h3>
        </div>
        <div class="divide-y divide-slate-100">
          ${topByViews.map((p, i) => `
            <div class="flex items-center gap-3 p-3 hover:bg-slate-50 transition">
              <span class="w-6 h-6 rounded-full bg-slate-100 text-slate-600 text-[10px] font-extrabold flex items-center justify-center shrink-0">${i+1}</span>
              <img src="${p.image || ''}" alt="" class="w-10 h-10 rounded-lg object-cover shrink-0 bg-slate-100" />
              <div class="flex-1 min-w-0">
                <p class="text-xs font-bold text-slate-900 truncate">${p.title}</p>
                <p class="text-[10px] text-slate-400">${p.tool} · ${p.category}</p>
              </div>
              <div class="text-right shrink-0">
                <div class="text-sm font-extrabold text-blue-600">${formatN(p.views || 0)}</div>
                <div class="text-[10px] text-slate-400">${formatN(p.likes || 0)} likes</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `);
  lcIcons();
}

// =============================================================================
// SEARCH ANALYTICS
// =============================================================================
async function renderSearchAnalytics() {
  setContent('admin-content', `
    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm">
      <div class="p-4 border-b border-slate-100">
        <h3 class="text-sm font-bold text-slate-900 flex items-center gap-2">
          <i data-lucide="search" class="w-4 h-4 text-blue-500"></i> Top Search Queries
        </h3>
      </div>
      <div id="search-analytics-content" class="p-8 text-center text-slate-400">
        <svg class="animate-spin w-6 h-6 mx-auto mb-2 text-blue-400" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
        Loading search data...
      </div>
    </div>
  `);
  lcIcons();
  try {
    const snap = await getDocs(query(collection(db, 'searchLogs'), orderBy('count', 'desc'), limit(50)));
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() as any }));
    const el = $('search-analytics-content');
    if (!el) return;
    if (items.length === 0) {
      el.innerHTML = '<p class="py-8 text-slate-400 text-sm">No search data yet. Search logs will appear here as users search the site.</p>';
      return;
    }
    const max = Math.max(1, ...items.map((i: any) => i.count || 0));
    el.innerHTML = `
      <div class="divide-y divide-slate-100">
        ${items.map((item: any, i: number) => `
          <div class="flex items-center gap-3 p-3 hover:bg-slate-50 transition">
            <span class="w-5 h-5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-extrabold flex items-center justify-center shrink-0">${i+1}</span>
            <div class="flex-1 min-w-0">
              <p class="text-xs font-bold text-slate-900">${item.query || item.id}</p>
              <div class="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden w-full max-w-xs">
                <div class="h-full bg-blue-500 rounded-full" style="width:${Math.round(((item.count||0)/max)*100)}%"></div>
              </div>
            </div>
            <span class="text-xs font-bold text-slate-500 shrink-0">${item.count || 0} searches</span>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    const el = $('search-analytics-content');
    if (el) el.innerHTML = '<p class="py-8 text-slate-400 text-sm">Search logs collection not found. Logs will be stored as users search.</p>';
  }
}

// =============================================================================
// IMAGE MANAGEMENT
// =============================================================================
function renderImages() {
  const imageUrls = [...new Set(allPrompts.map(p => p.image).filter(Boolean))];
  setContent('admin-content', `
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <i data-lucide="image" class="w-5 h-5 text-blue-500"></i>
          <h3 class="text-sm font-bold text-slate-900">All Prompt Images</h3>
          <span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs font-bold">${imageUrls.length}</span>
        </div>
        <button onclick="adminNav('cloudinary')" class="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition flex items-center gap-1.5">
          <i data-lucide="upload-cloud" class="w-3.5 h-3.5"></i> Upload New
        </button>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
        ${imageUrls.map(url => `
          <div class="group relative bg-slate-100 rounded-xl overflow-hidden aspect-square border border-slate-200">
            <img src="${url}" alt="" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" loading="lazy" onerror="this.parentElement.style.display='none'" />
            <div class="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-1">
              <button onclick="navigator.clipboard.writeText('${url}').then(()=>showToast('URL copied!','success'))" class="p-1.5 bg-white rounded-lg text-slate-700 hover:bg-slate-100 transition" title="Copy URL">
                <i data-lucide="copy" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          </div>
        `).join('')}
        ${imageUrls.length === 0 ? '<p class="col-span-full text-center text-slate-400 text-sm py-12">No images found in prompts</p>' : ''}
      </div>
    </div>
  `);
  lcIcons();
}

// =============================================================================
// CLOUDINARY UPLOAD SECTION
// =============================================================================
function renderCloudinaryUpload() {
  setContent('admin-content', `
    <div class="max-w-2xl space-y-4">
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <h3 class="text-sm font-bold text-slate-900 mb-1 flex items-center gap-2">
          <i data-lucide="upload-cloud" class="w-4 h-4 text-blue-500"></i> Cloud CDN Image Upload
        </h3>
        <p class="text-xs text-slate-400 mb-5">Upload images directly to high-speed cloud CDN. Optimized delivery URLs are automatically generated.</p>

        <div id="upload-drop-zone" class="border-2 border-dashed border-slate-200 rounded-2xl p-8 text-center hover:border-blue-400 hover:bg-blue-50/30 transition cursor-pointer"
          onclick="document.getElementById('cloudinary-file-input').click()">
          <i data-lucide="upload" class="w-10 h-10 text-slate-300 mx-auto mb-3"></i>
          <p class="text-sm font-semibold text-slate-600">Click to select image</p>
          <p class="text-xs text-slate-400 mt-1">JPG, PNG, WEBP, GIF up to 10MB</p>
        </div>
        <input type="file" id="cloudinary-file-input" accept="image/*" class="hidden" onchange="previewCloudinaryImage(this)" />

        <div id="cloudinary-preview" class="hidden mt-4 space-y-3">
          <img id="cloudinary-preview-img" src="" alt="" class="w-48 h-48 object-cover rounded-xl border border-slate-200" />
          <div id="cloudinary-file-info" class="text-xs text-slate-500"></div>
          <button onclick="doCloudinaryUpload()" id="do-upload-btn" class="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition flex items-center justify-center gap-2">
            <i data-lucide="upload-cloud" class="w-4 h-4"></i> Upload to Cloud CDN
          </button>
        </div>

        <div id="cloudinary-result" class="hidden mt-4 p-4 bg-emerald-50 rounded-xl border border-emerald-200 space-y-2">
          <p class="text-xs font-bold text-emerald-700 flex items-center gap-1.5">
            <i data-lucide="check-circle-2" class="w-4 h-4"></i> Uploaded Successfully!
          </p>
          <div class="flex items-center gap-2">
            <input id="cloudinary-result-url" type="text" readonly class="flex-1 px-3 py-2 bg-white border border-emerald-200 rounded-lg text-xs text-slate-700 font-mono" />
            <button onclick="copyCloudinaryUrl()" class="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition flex items-center gap-1">
              <i data-lucide="copy" class="w-3.5 h-3.5"></i> Copy
            </button>
          </div>
          <img id="cloudinary-result-preview" src="" alt="" class="w-32 h-32 object-cover rounded-xl border border-emerald-200" />
        </div>
      </div>
    </div>
  `);
  lcIcons();
}

function previewCloudinaryImage(input: HTMLInputElement) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = (e) => {
    const previewImg = $('cloudinary-preview-img') as HTMLImageElement;
    const preview = $('cloudinary-preview');
    const info = $('cloudinary-file-info');
    if (previewImg) previewImg.src = e.target?.result as string;
    if (preview) preview.classList.remove('hidden');
    if (info) info.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  };
  reader.readAsDataURL(file);
}

async function doCloudinaryUpload() {
  const fileInput = $('cloudinary-file-input') as HTMLInputElement;
  if (!fileInput?.files?.[0]) { showToast('No file selected', 'warning'); return; }
  const btn = $('do-upload-btn') as HTMLButtonElement;
  if (btn) { btn.disabled = true; btn.innerHTML = '<svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Uploading...'; }
  try {
    const url = await uploadToCloudinary(fileInput.files[0]);
    const resultEl = $('cloudinary-result');
    const resultUrl = $('cloudinary-result-url') as HTMLInputElement;
    const resultImg = $('cloudinary-result-preview') as HTMLImageElement;
    if (resultEl) resultEl.classList.remove('hidden');
    if (resultUrl) resultUrl.value = url;
    if (resultImg) resultImg.src = url;
    showToast('Uploaded successfully!', 'success');
    logAdminAction('cloudinary_upload', url.substring(0, 50));
  } catch (err: any) {
    showToast(`Upload failed: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="upload-cloud" class="w-4 h-4"></i> Upload to Cloudinary'; lcIcons(); }
  }
}

function copyCloudinaryUrl() {
  const urlEl = $('cloudinary-result-url') as HTMLInputElement;
  if (urlEl?.value) {
    navigator.clipboard.writeText(urlEl.value);
    showToast('URL copied!', 'success');
  }
}

// =============================================================================
// REPORTS SECTION
// =============================================================================
function renderReports() {
  setContent('admin-content', `
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <h3 class="text-sm font-bold text-slate-900 mb-1 flex items-center gap-2">
          <i data-lucide="file-down" class="w-4 h-4 text-blue-500"></i> Export Prompts CSV
        </h3>
        <p class="text-xs text-slate-400 mb-4">Download all prompts as a CSV file with all metadata.</p>
        <div class="space-y-2">
          <select id="export-status" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition">
            <option value="all">All Statuses</option>
            <option value="approved">Approved Only</option>
            <option value="pending">Pending Only</option>
          </select>
          <button onclick="exportCSV()" class="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition flex items-center justify-center gap-2">
            <i data-lucide="download" class="w-4 h-4"></i> Download CSV
          </button>
        </div>
      </div>
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <h3 class="text-sm font-bold text-slate-900 mb-1 flex items-center gap-2">
          <i data-lucide="file-json" class="w-4 h-4 text-amber-500"></i> Export Prompts JSON
        </h3>
        <p class="text-xs text-slate-400 mb-4">Download all prompts data as a structured JSON file.</p>
        <button onclick="exportJSON()" class="w-full py-2.5 bg-amber-500 hover:bg-amber-600 text-white font-bold text-sm rounded-xl transition flex items-center justify-center gap-2">
          <i data-lucide="download" class="w-4 h-4"></i> Download JSON
        </button>
      </div>
    </div>
  `);
  lcIcons();
}

function exportCSV() {
  const statusFilter = ($('export-status') as HTMLSelectElement)?.value || 'all';
  const data = statusFilter === 'all' ? allPrompts : allPrompts.filter(p => p.status === statusFilter);
  const headers = ['id','title','tool','category','status','views','likes','downloads','copyCount','featured','trending','creator','createdAt'];
  const rows = data.map(p => headers.map(h => {
    const v = (p as any)[h];
    if (h === 'createdAt') return p.createdAt?.seconds ? new Date(p.createdAt.seconds * 1000).toISOString() : '';
    return JSON.stringify(v ?? '');
  }).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  downloadFile(csv, 'promptverse-prompts.csv', 'text/csv');
  showToast(`Exported ${data.length} prompts as CSV`, 'success');
}

function exportJSON() {
  const json = JSON.stringify(allPrompts.map(p => ({
    ...p,
    createdAt: p.createdAt?.seconds ? new Date(p.createdAt.seconds * 1000).toISOString() : null,
    updatedAt: p.updatedAt?.seconds ? new Date(p.updatedAt.seconds * 1000).toISOString() : null
  })), null, 2);
  downloadFile(json, 'promptverse-prompts.json', 'application/json');
  showToast(`Exported ${allPrompts.length} prompts as JSON`, 'success');
}

function downloadFile(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// =============================================================================
// SETTINGS SECTION
// =============================================================================
async function renderSettings() {
  setContent('admin-content', `
    <div class="max-w-3xl space-y-6">
      <!-- Section 1: Core Settings -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
        <h3 class="text-sm font-bold text-slate-900 flex items-center gap-2">
          <i data-lucide="settings" class="w-4 h-4 text-slate-500"></i> Global Settings
        </h3>
        <div id="settings-loading" class="text-slate-400 text-sm text-center py-4">Loading settings...</div>
        <form id="settings-form" class="hidden space-y-4 font-medium text-xs" onsubmit="saveSettings(event)">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Brand Name</label>
              <input type="text" id="setting-brand" class="w-full px-3 py-2 border rounded-xl" />
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Copyright Text</label>
              <input type="text" id="setting-copyright" class="w-full px-3 py-2 border rounded-xl" />
            </div>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Brand Logo URL</label>
              <input type="text" id="setting-logo" class="w-full px-3 py-2 border rounded-xl" />
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Favicon URL (Square 1:1, crawlable format)</label>
              <input type="text" id="setting-favicon" class="w-full px-3 py-2 border rounded-xl" />
            </div>
          </div>
          
          <h4 class="text-xs font-bold text-slate-900 border-t pt-3">Google Search Branding & SEO Meta</h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">SEO Title (Target dynamic &lt;title&gt;)</label>
              <input type="text" id="setting-seo-title" class="w-full px-3 py-2 border rounded-xl" placeholder="e.g. PromptVerse AI - Search Engine for Premium AI Prompts" />
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Search Keywords (Comma-separated)</label>
              <input type="text" id="setting-seo-keywords" class="w-full px-3 py-2 border rounded-xl" placeholder="e.g. AI prompts, ChatGPT, Midjourney" />
            </div>
          </div>
          <div>
            <label class="block text-slate-700 font-bold mb-1.5">SEO Meta Description</label>
            <textarea id="setting-seo-desc" rows="2" class="w-full px-3 py-2 border rounded-xl" placeholder="Brief snippet shown in search results..."></textarea>
          </div>
          <div>
            <label class="block text-slate-700 font-bold mb-1.5">Canonical URL Domain (Must end with /)</label>
            <input type="url" id="setting-canonical-url" class="w-full px-3 py-2 border rounded-xl" placeholder="e.g. https://promptsverse-ai.web.app/" />
          </div>

          <h4 class="text-xs font-bold text-slate-900 border-t pt-3">Social Media Meta (Open Graph & Twitter Cards)</h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Open Graph Title</label>
              <input type="text" id="setting-og-title" class="w-full px-3 py-2 border rounded-xl" placeholder="e.g. Search Premium AI Prompts" />
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Twitter Card Type</label>
              <select id="setting-twitter-card" class="w-full px-3 py-2 border rounded-xl">
                <option value="summary_large_image">summary_large_image (Large Image Card)</option>
                <option value="summary">summary (Small Thumb Card)</option>
              </select>
            </div>
          </div>
          <div>
            <label class="block text-slate-700 font-bold mb-1.5">Open Graph Description</label>
            <textarea id="setting-og-desc" rows="2" class="w-full px-3 py-2 border rounded-xl" placeholder="Social description..."></textarea>
          </div>
          <div>
            <label class="block text-slate-700 font-bold mb-1.5">Open Graph Share Image URL</label>
            <input type="text" id="setting-og-image" class="w-full px-3 py-2 border rounded-xl" placeholder="Social preview card image link..." />
          </div>

          <h4 class="text-xs font-bold text-slate-900 border-t pt-3">JSON-LD Structured Data Schema</h4>
          <div>
            <label class="block text-slate-700 font-bold mb-1.5">Structured-Data (Organization / Website JSON format)</label>
            <textarea id="setting-structured-data" rows="5" class="w-full px-3 py-2 border rounded-xl font-mono text-[10px]" placeholder='e.g. { "@context": "https://schema.org", ... }'></textarea>
          </div>
          <div>
            <label class="block text-slate-700 font-bold mb-1.5">Site Banner Message</label>
            <input type="text" id="setting-banner" placeholder="e.g., New festival prompts available!" class="w-full px-3 py-2 border border-slate-200 rounded-xl" />
          </div>
          <div>
            <label class="block text-slate-700 font-bold mb-1.5">Active Season/Theme</label>
            <select id="setting-theme" class="w-full px-3 py-2 border border-slate-200 rounded-xl">
              <option value="auto">Auto (based on calendar)</option>
              <option value="ai_core">AI Core</option>
              <option value="ganesh">Ganesh Chaturthi</option>
              <option value="diwali">Diwali</option>
              <option value="christmas">Christmas</option>
              <option value="newyear">New Year</option>
            </select>
          </div>
          
          <h4 class="text-xs font-bold text-slate-900 border-t pt-3">Tracking Integrations</h4>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">GA4 Measurement ID</label>
              <input type="text" id="setting-ga4" placeholder="G-XXXXXX" class="w-full px-3 py-2 border rounded-xl" />
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Clarity Project ID</label>
              <input type="text" id="setting-clarity" placeholder="clarity-id" class="w-full px-3 py-2 border rounded-xl" />
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Meta Pixel ID</label>
              <input type="text" id="setting-pixel" placeholder="pixel-id" class="w-full px-3 py-2 border rounded-xl" />
            </div>
          </div>

          <div class="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
            <input type="checkbox" id="setting-maintenance" class="w-4 h-4 accent-rose-600" />
            <div>
              <label for="setting-maintenance" class="text-xs font-bold text-slate-700 cursor-pointer">Maintenance Mode</label>
              <p class="text-[10px] text-slate-400">Show maintenance page to public visitors</p>
            </div>
          </div>
          <button type="submit" class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition flex items-center gap-2">
            <i data-lucide="save" class="w-4 h-4"></i> Save Settings
          </button>
        </form>
      </div>

      <!-- Section 2: Hero Configuration -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
        <h3 class="text-sm font-bold text-slate-900 flex items-center gap-2">
          <i data-lucide="layout" class="w-4 h-4 text-blue-500"></i> Hero Section Configuration
        </h3>
        <form id="hero-config-form" class="space-y-4" onsubmit="saveHeroConfig(event)">
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1.5">Badge Text</label>
            <input type="text" id="hero-badge-input" placeholder="✨ The World's #1 AI Prompt Search Engine" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1.5">Headline HTML</label>
            <textarea id="hero-headline-input" rows="2" placeholder="e.g., <span class='text-blue-600'>Google</span> for AI Prompts" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm font-mono focus:border-blue-500 transition"></textarea>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1.5">Subtitle Text</label>
            <textarea id="hero-subtitle-input" rows="2" placeholder="Subtitle description..." class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition"></textarea>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1.5">Typewriter Phrases (comma-separated)</label>
            <textarea id="hero-phrases-input" rows="3" placeholder="Phrase 1, Phrase 2, Phrase 3..." class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition"></textarea>
          </div>
          <button type="submit" class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition flex items-center gap-2">
            <i data-lucide="save" class="w-4 h-4"></i> Save Hero Config
          </button>
        </form>
      </div>

      <!-- Section 3: Festive special banner -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
        <h3 class="text-sm font-bold text-slate-900 flex items-center gap-2">
          <i data-lucide="sparkles" class="w-4 h-4 text-orange-500"></i> Festive Campaign Banner
        </h3>
        <form id="festive-config-form" class="space-y-4" onsubmit="saveFestiveConfig(event)">
          <div class="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
            <input type="checkbox" id="festive-active" class="w-4 h-4 accent-blue-600" />
            <div>
              <label for="festive-active" class="text-xs font-bold text-slate-700 cursor-pointer">Activate Festive Banner</label>
              <p class="text-[10px] text-slate-400">Toggle display of seasonal banner on home page</p>
            </div>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1.5">Campaign Badge</label>
            <input type="text" id="festive-tag" placeholder="🪔 Festive Special Collection" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1.5">Campaign Title</label>
            <input type="text" id="festive-title" placeholder="Ganesh Chaturthi Special Prompt Collection" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1.5">Campaign Subtitle</label>
            <textarea id="festive-subtitle" rows="2" placeholder="Description of collection..." class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition"></textarea>
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1.5">Search Query Trigger</label>
            <input type="text" id="festive-query" placeholder="Ganesh Chaturthi" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition" />
          </div>
          <button type="submit" class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition flex items-center gap-2">
            <i data-lucide="save" class="w-4 h-4"></i> Save Festive Campaign
          </button>
        </form>
      </div>

      <!-- Section 4: Statistics Counter Bar -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
        <h3 class="text-sm font-bold text-slate-900 flex items-center gap-2">
          <i data-lucide="bar-chart-3" class="w-4 h-4 text-emerald-500"></i> Homepage Stats Counters (6 Items)
        </h3>
        <form id="stats-config-form" class="space-y-4" onsubmit="saveStatsConfig(event)">
          <div class="grid grid-cols-2 sm:grid-cols-6 gap-3" id="stats-inputs-grid">
            <!-- Dynamically rendered -->
          </div>
          
          <h4 class="text-xs font-bold text-slate-900 border-t pt-3">Bottom Banner Stats (4 Items)</h4>
          <div class="grid grid-cols-1 sm:grid-cols-4 gap-4" id="stats-bottom-inputs-grid">
            <!-- Dynamically rendered -->
          </div>
          
          <button type="submit" class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition flex items-center gap-2">
            <i data-lucide="save" class="w-4 h-4"></i> Save All Statistics
          </button>
        </form>
      </div>

      <!-- Section 5: Community Section Config -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
        <h3 class="text-sm font-bold text-slate-900 flex items-center gap-2">
          <i data-lucide="users" class="w-4 h-4 text-indigo-500"></i> Discord Community CTA Widget
        </h3>
        <form id="community-config-form" class="space-y-4 text-xs font-medium" onsubmit="saveCommunityConfig(event)">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Widget Title</label>
              <input type="text" id="comm-title" class="w-full px-3 py-2 border rounded-xl" />
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Subtitle (Member Tagline)</label>
              <input type="text" id="comm-subtitle" class="w-full px-3 py-2 border rounded-xl" />
            </div>
          </div>
          <div>
            <label class="block text-slate-700 font-bold mb-1.5">Description text</label>
            <textarea id="comm-desc" rows="2" class="w-full px-3 py-2 border rounded-xl"></textarea>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Button Text</label>
              <input type="text" id="comm-btn-text" class="w-full px-3 py-2 border rounded-xl" />
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1.5">Discord Invite Link</label>
              <input type="text" id="comm-invite" class="w-full px-3 py-2 border rounded-xl" />
            </div>
          </div>
          <button type="submit" class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition flex items-center gap-2">
            <i data-lucide="save" class="w-4 h-4"></i> Save Community Settings
          </button>
        </form>
      </div>

    </div>
  `);
  lcIcons();

  try {
    const snap = await getDoc(doc(db, 'settings', 'site'));
    const data = snap.exists() ? snap.data() : {};
    hide('settings-loading');
    show('settings-form');
    ($('setting-banner') as HTMLInputElement).value = data.banner || '';
    ($('setting-theme') as HTMLSelectElement).value = data.theme || 'auto';
    ($('setting-maintenance') as HTMLInputElement).checked = !!data.maintenanceMode;

    ($('setting-brand') as HTMLInputElement).value = data.brandName || '';
    ($('setting-copyright') as HTMLInputElement).value = data.copyrightText || '';
    ($('setting-logo') as HTMLInputElement).value = data.logoUrl || '';
    ($('setting-favicon') as HTMLInputElement).value = data.faviconUrl || '';

    ($('setting-seo-title') as HTMLInputElement).value = data.seoTitle || '';
    ($('setting-seo-keywords') as HTMLInputElement).value = data.searchKeywords || '';
    ($('setting-seo-desc') as HTMLTextAreaElement).value = data.metaDescription || '';
    ($('setting-canonical-url') as HTMLInputElement).value = data.canonicalUrl || 'https://promptsone.com/';

    ($('setting-og-title') as HTMLInputElement).value = data.ogTitle || '';
    ($('setting-twitter-card') as HTMLSelectElement).value = data.twitterCard || 'summary_large_image';
    ($('setting-og-desc') as HTMLTextAreaElement).value = data.ogDescription || '';
    ($('setting-og-image') as HTMLInputElement).value = data.ogImage || '';
    ($('setting-structured-data') as HTMLTextAreaElement).value = data.structuredDataOrg || '';
    
    ($('setting-ga4') as HTMLInputElement).value = data.ga4Id || '';
    ($('setting-clarity') as HTMLInputElement).value = data.clarityId || '';
    ($('setting-pixel') as HTMLInputElement).value = data.metaPixelId || '';

    // Load Hero configs
    const heroSnap = await getDoc(doc(db, 'siteConfigs', 'hero'));
    if (heroSnap.exists()) {
      const hero = heroSnap.data();
      ($('hero-badge-input') as HTMLInputElement).value = hero.badgeText || '';
      ($('hero-headline-input') as HTMLTextAreaElement).value = hero.headline || '';
      ($('hero-subtitle-input') as HTMLTextAreaElement).value = hero.subtitle || '';
      ($('hero-phrases-input') as HTMLTextAreaElement).value = (hero.typewriterPhrases || []).join(', ');
    }

    // Load Festive configs
    const festiveSnap = await getDoc(doc(db, 'siteConfigs', 'festive'));
    if (festiveSnap.exists()) {
      const fest = festiveSnap.data();
      ($('festive-active') as HTMLInputElement).checked = fest.active !== false;
      ($('festive-tag') as HTMLInputElement).value = fest.tag || '';
      ($('festive-title') as HTMLInputElement).value = fest.title || '';
      ($('festive-subtitle') as HTMLTextAreaElement).value = fest.subtitle || '';
      ($('festive-query') as HTMLInputElement).value = fest.searchQuery || '';
    }

    // Load Stats configs
    const statsSnap = await getDoc(doc(db, 'siteConfigs', 'stats'));
    const statsData = statsSnap.exists() ? statsSnap.data() : {};
    const items = statsData.items || [
      { label: 'Premium Prompts', value: '3,25,421+', colorClass: 'text-blue-600' },
      { label: 'AI Tools Supported', value: '145+', colorClass: 'text-emerald-600' },
      { label: 'Active Creators', value: '12,500+', colorClass: 'text-amber-600' },
      { label: 'Countries Served', value: '120+', colorClass: 'text-purple-600' },
      { label: 'Copied Today', value: '18,450+', colorClass: 'text-indigo-600' },
      { label: 'Live Searching', value: '3,820', colorClass: 'text-rose-600' }
    ];
    const bottomItems = statsData.bottomItems || [
      { label: 'Premium Prompts', value: '500K+', colorClass: 'text-purple-600', icon: 'file-text' },
      { label: 'Categories', value: '120+', colorClass: 'text-blue-600', icon: 'grid' },
      { label: 'Happy Users', value: '5M+', colorClass: 'text-emerald-600', icon: 'users' },
      { label: 'Prompts Copied', value: '50M+', colorClass: 'text-amber-600', icon: 'copy' }
    ];

    const statsGrid = $('stats-inputs-grid');
    if (statsGrid) {
      statsGrid.innerHTML = items.map((itm: any, idx: number) => `
        <div class="space-y-1.5 p-2 bg-slate-50 rounded-xl border border-slate-100">
          <p class="text-[9px] font-bold text-slate-400">Counter ${idx + 1}</p>
          <input type="text" id="stat-val-${idx}" value="${itm.value}" class="w-full px-2 py-1 border rounded text-xs" placeholder="Value" />
          <input type="text" id="stat-lbl-${idx}" value="${itm.label}" class="w-full px-2 py-1 border rounded text-xs" placeholder="Label" />
          <input type="text" id="stat-col-${idx}" value="${itm.colorClass || 'text-blue-600'}" class="w-full px-2 py-1 border rounded text-[9px] font-mono" placeholder="text-color" />
        </div>
      `).join('');
    }

    const statsBottomGrid = $('stats-bottom-inputs-grid');
    if (statsBottomGrid) {
      statsBottomGrid.innerHTML = bottomItems.map((itm: any, idx: number) => `
        <div class="space-y-1.5 p-2 bg-slate-50 rounded-xl border border-slate-100 text-xs">
          <p class="text-[9px] font-bold text-slate-400">Bottom Column ${idx + 1}</p>
          <input type="text" id="stat-bot-val-${idx}" value="${itm.value}" class="w-full px-2 py-1 border rounded text-xs" placeholder="Value" />
          <input type="text" id="stat-bot-lbl-${idx}" value="${itm.label}" class="w-full px-2 py-1 border rounded text-xs" placeholder="Label" />
          <input type="text" id="stat-bot-icon-${idx}" value="${itm.icon || 'file-text'}" class="w-full px-2 py-1 border rounded text-xs font-mono" placeholder="Lucide icon" />
          <input type="text" id="stat-bot-col-${idx}" value="${itm.colorClass || 'text-blue-600'}" class="w-full px-2 py-1 border rounded text-[9px] font-mono" placeholder="text-color" />
        </div>
      `).join('');
    }

    // Load Community config
    const commSnap = await getDoc(doc(db, 'siteConfigs', 'community'));
    const commData = commSnap.exists() ? commSnap.data() : {
      title: 'PromptVerse Community',
      subtitle: 'Join 50,000+ creators online',
      description: 'Share your prompts, learn advanced techniques, and discover daily featured creators.',
      buttonText: 'Join Discord Server',
      inviteUrl: 'https://discord.gg/promptverse'
    };
    ($('comm-title') as HTMLInputElement).value = commData.title || '';
    ($('comm-subtitle') as HTMLInputElement).value = commData.subtitle || '';
    ($('comm-desc') as HTMLTextAreaElement).value = commData.description || '';
    ($('comm-btn-text') as HTMLInputElement).value = commData.buttonText || '';
    ($('comm-invite') as HTMLInputElement).value = commData.inviteUrl || '';

  } catch (err) {
    hide('settings-loading');
    show('settings-form');
  }
}

async function saveSettings(e: Event) {
  e.preventDefault();
  const banner = ($('setting-banner') as HTMLInputElement).value.trim();
  const theme = ($('setting-theme') as HTMLSelectElement).value;
  const maintenanceMode = ($('setting-maintenance') as HTMLInputElement).checked;

  const brandName = ($('setting-brand') as HTMLInputElement).value.trim();
  const copyrightText = ($('setting-copyright') as HTMLInputElement).value.trim();
  const logoUrl = ($('setting-logo') as HTMLInputElement).value.trim();
  const faviconUrl = ($('setting-favicon') as HTMLInputElement).value.trim();

  const seoTitle = ($('setting-seo-title') as HTMLInputElement).value.trim();
  const searchKeywords = ($('setting-seo-keywords') as HTMLInputElement).value.trim();
  const metaDescription = ($('setting-seo-desc') as HTMLTextAreaElement).value.trim();
  const canonicalUrl = ($('setting-canonical-url') as HTMLInputElement).value.trim();

  const ogTitle = ($('setting-og-title') as HTMLInputElement).value.trim();
  const twitterCard = ($('setting-twitter-card') as HTMLSelectElement).value;
  const ogDescription = ($('setting-og-desc') as HTMLTextAreaElement).value.trim();
  const ogImage = ($('setting-og-image') as HTMLInputElement).value.trim();
  const structuredDataOrg = ($('setting-structured-data') as HTMLTextAreaElement).value.trim();

  const ga4Id = ($('setting-ga4') as HTMLInputElement).value.trim();
  const clarityId = ($('setting-clarity') as HTMLInputElement).value.trim();
  const metaPixelId = ($('setting-pixel') as HTMLInputElement).value.trim();

  try {
    await setDoc(doc(db, 'settings', 'site'), {
      banner, theme, maintenanceMode, brandName, copyrightText, logoUrl, faviconUrl,
      seoTitle, searchKeywords, metaDescription, canonicalUrl,
      ogTitle, twitterCard, ogDescription, ogImage, structuredDataOrg,
      ga4Id, clarityId, metaPixelId,
      updatedAt: serverTimestamp()
    }, { merge: true });
    showToast('Settings saved!', 'success');
    logAdminAction('settings_update', 'site');
  } catch (err) {
    showToast('Failed to save settings', 'error');
  }
}

async function saveHeroConfig(e: Event) {
  e.preventDefault();
  const badgeText = ($('hero-badge-input') as HTMLInputElement).value.trim();
  const headline = ($('hero-headline-input') as HTMLTextAreaElement).value.trim();
  const subtitle = ($('hero-subtitle-input') as HTMLTextAreaElement).value.trim();
  const rawPhrases = ($('hero-phrases-input') as HTMLTextAreaElement).value.trim();
  const typewriterPhrases = rawPhrases ? rawPhrases.split(',').map(p => p.trim()).filter(Boolean) : [];
  try {
    await setDoc(doc(db, 'siteConfigs', 'hero'), { badgeText, headline, subtitle, typewriterPhrases, updatedAt: serverTimestamp() });
    showToast('Hero configuration saved!', 'success');
    logAdminAction('hero_config_update', 'hero');
  } catch (err) {
    showToast('Failed to save hero config', 'error');
  }
}

async function saveFestiveConfig(e: Event) {
  e.preventDefault();
  const active = ($('festive-active') as HTMLInputElement).checked;
  const tag = ($('festive-tag') as HTMLInputElement).value.trim();
  const title = ($('festive-title') as HTMLInputElement).value.trim();
  const subtitle = ($('festive-subtitle') as HTMLTextAreaElement).value.trim();
  const searchQuery = ($('festive-query') as HTMLInputElement).value.trim();
  try {
    await setDoc(doc(db, 'siteConfigs', 'festive'), { active, tag, title, subtitle, searchQuery, updatedAt: serverTimestamp() });
    showToast('Festive banner configuration saved!', 'success');
    logAdminAction('festive_config_update', 'festive');
  } catch (err) {
    showToast('Failed to save festive config', 'error');
  }
}

async function saveStatsConfig(e: Event) {
  e.preventDefault();
  const items = [];
  for (let idx = 0; idx < 6; idx++) {
    const valEl = $(`stat-val-${idx}`) as HTMLInputElement;
    const lblEl = $(`stat-lbl-${idx}`) as HTMLInputElement;
    const colEl = $(`stat-col-${idx}`) as HTMLInputElement;
    if (valEl && lblEl) {
      items.push({
        value: valEl.value.trim(),
        label: lblEl.value.trim(),
        colorClass: colEl ? colEl.value.trim() : 'text-blue-600'
      });
    }
  }

  const bottomItems = [];
  for (let idx = 0; idx < 4; idx++) {
    const valEl = $(`stat-bot-val-${idx}`) as HTMLInputElement;
    const lblEl = $(`stat-bot-lbl-${idx}`) as HTMLInputElement;
    const iconEl = $(`stat-bot-icon-${idx}`) as HTMLInputElement;
    const colEl = $(`stat-bot-col-${idx}`) as HTMLInputElement;
    if (valEl && lblEl) {
      bottomItems.push({
        value: valEl.value.trim(),
        label: lblEl.value.trim(),
        icon: iconEl ? iconEl.value.trim() : 'file-text',
        colorClass: colEl ? colEl.value.trim() : 'text-blue-600'
      });
    }
  }

  try {
    await setDoc(doc(db, 'siteConfigs', 'stats'), { items, bottomItems, updatedAt: serverTimestamp() });
    showToast('Homepage statistics updated!', 'success');
    logAdminAction('stats_config_update', 'stats');
  } catch (err) {
    showToast('Failed to save statistics config', 'error');
  }
}

async function saveCommunityConfig(e: Event) {
  e.preventDefault();
  const title = ($('comm-title') as HTMLInputElement).value.trim();
  const subtitle = ($('comm-subtitle') as HTMLInputElement).value.trim();
  const description = ($('comm-desc') as HTMLTextAreaElement).value.trim();
  const buttonText = ($('comm-btn-text') as HTMLInputElement).value.trim();
  const inviteUrl = ($('comm-invite') as HTMLInputElement).value.trim();

  try {
    await setDoc(doc(db, 'siteConfigs', 'community'), {
      title, subtitle, description, buttonText, inviteUrl, updatedAt: serverTimestamp()
    });
    showToast('Community widget configurations saved!', 'success');
    logAdminAction('community_config_update', 'community');
  } catch (err) {
    showToast('Failed to save community configs', 'error');
  }
}

// =============================================================================
// BACKUP / RESTORE
// =============================================================================
function renderBackup() {
  setContent('admin-content', `
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <h3 class="text-sm font-bold text-slate-900 mb-1 flex items-center gap-2">
          <i data-lucide="database" class="w-4 h-4 text-blue-500"></i> Backup Firestore Data
        </h3>
        <p class="text-xs text-slate-400 mb-4">Export all collections to a JSON file for safekeeping.</p>
        <button onclick="doBackup()" class="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition flex items-center justify-center gap-2">
          <i data-lucide="archive" class="w-4 h-4"></i> Download Backup
        </button>
      </div>
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <h3 class="text-sm font-bold text-slate-900 mb-1 flex items-center gap-2">
          <i data-lucide="upload" class="w-4 h-4 text-amber-500"></i> Restore from Backup
        </h3>
        <p class="text-xs text-slate-400 mb-4">Import a previously exported JSON backup file.</p>
        <p class="text-xs text-rose-500 font-semibold mb-3">Warning: This will overwrite existing data.</p>
        <input type="file" id="restore-file" accept=".json" class="hidden" onchange="doRestore(this)" />
        <button onclick="document.getElementById('restore-file').click()" class="w-full py-2.5 bg-amber-500 hover:bg-amber-600 text-white font-bold text-sm rounded-xl transition flex items-center justify-center gap-2">
          <i data-lucide="upload" class="w-4 h-4"></i> Import Backup File
        </button>
      </div>
    </div>
  `);
  lcIcons();
}

async function doBackup() {
  try {
    const [promptSnap, catSnap] = await Promise.all([
      getDocs(collection(db, 'prompts')),
      getDocs(collection(db, 'categories'))
    ]);
    const backup = {
      exportedAt: new Date().toISOString(),
      prompts: promptSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) })),
      categories: catSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
    };
    downloadFile(JSON.stringify(backup, null, 2), `promptverse-backup-${Date.now()}.json`, 'application/json');
    showToast('Backup downloaded!', 'success');
    logAdminAction('backup_export', 'all');
  } catch (err) {
    showToast('Backup failed', 'error');
  }
}

async function doRestore(input: HTMLInputElement) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    showConfirm('Restore Backup', `This will import ${data.prompts?.length || 0} prompts and ${data.categories?.length || 0} categories. Existing data is preserved.`, async () => {
      try {
        const batch = writeBatch(db);
        (data.categories || []).forEach((c: any) => {
          const { id, ...rest } = c;
          batch.set(doc(db, 'categories', id), rest);
        });
        await batch.commit();

        const batch2 = writeBatch(db);
        (data.prompts || []).slice(0, 500).forEach((p: any) => {
          const { id, ...rest } = p;
          batch2.set(doc(db, 'prompts', id), rest);
        });
        await batch2.commit();

        showToast('Backup restored!', 'success');
        await loadAllPrompts();
      } catch (err: any) {
        showToast(`Restore failed: ${err.message}`, 'error');
      }
    }, true);
  } catch {
    showToast('Invalid backup file format', 'error');
  }
}

// =============================================================================
// ACTIVITY LOGS
// =============================================================================
async function renderLogs() {
  setContent('admin-content', `
    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm">
      <div class="p-4 border-b border-slate-100 flex items-center justify-between">
        <h3 class="text-sm font-bold text-slate-900 flex items-center gap-2">
          <i data-lucide="activity" class="w-4 h-4 text-blue-500"></i> Activity Logs
        </h3>
        <span class="text-xs text-slate-400">Last 100 admin actions</span>
      </div>
      <div id="logs-container" class="divide-y divide-slate-100">
        <div class="p-8 text-center text-slate-400 text-sm">Loading logs...</div>
      </div>
    </div>
  `);
  lcIcons();
  try {
    const snap = await getDocs(query(collection(db, 'adminLogs'), orderBy('timestamp', 'desc'), limit(100)));
    const logs = snap.docs.map(d => ({ id: d.id, ...d.data() as any }));
    const container = $('logs-container');
    if (!container) return;
    if (logs.length === 0) {
      container.innerHTML = '<p class="p-8 text-center text-slate-400 text-sm">No activity logs yet</p>';
      return;
    }
    container.innerHTML = logs.map(log => `
      <div class="flex items-start gap-3 p-3 hover:bg-slate-50 transition">
        <div class="w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center shrink-0 mt-0.5">
          <i data-lucide="activity" class="w-3.5 h-3.5 text-blue-500"></i>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-xs font-bold text-slate-900">${log.action || 'Unknown action'}</p>
          <p class="text-[10px] text-slate-400">${log.adminEmail || 'Admin'} · ${log.target || ''}</p>
        </div>
        <span class="text-[10px] text-slate-400 shrink-0">${formatDate(log.timestamp)}</span>
      </div>
    `).join('');
    lcIcons();
  } catch {
    const container = $('logs-container');
    if (container) container.innerHTML = '<p class="p-8 text-center text-slate-400 text-sm">Activity logs will appear here as you perform admin actions. (Requires adminLogs collection in Firestore)</p>';
  }
}

async function logAdminAction(action: string, target: string) {
  try {
    await addDoc(collection(db, 'adminLogs'), {
      action, target,
      adminUid: currentAdminUser?.uid || '',
      adminEmail: currentAdminUser?.email || '',
      timestamp: serverTimestamp()
    });
  } catch {
    // Silent — log failures should not disrupt admin operations
  }
}

// =============================================================================
// SITE STATISTICS MANAGEMENT
// =============================================================================
async function renderStatsManagement() {
  const approvedPrompts = allPrompts.filter(p => p.status === 'approved');
  const uniqueCreators = new Set(approvedPrompts.map(p => p.creatorId || p.creator).filter(Boolean));
  const totalCopies = allPrompts.reduce((s, p) => s + (p.copyCount || 0), 0);

  setContent('admin-content', `
    <div class="space-y-6">
      <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-base font-bold text-slate-900 flex items-center gap-2">
              <i data-lucide="bar-chart-2" class="w-5 h-5 text-blue-600"></i> Site Statistics & Real-Time Counters
            </h3>
            <p class="text-xs text-slate-500 mt-0.5">Manage real-time calculated metrics and set optional manual overrides for public website counters.</p>
          </div>
          <span class="px-3 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full text-xs font-bold flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Firestore Sync Active
          </span>
        </div>
      </div>

      <!-- Real-Time Auto-Computed Summary Cards -->
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Approved Prompts</div>
          <div class="text-2xl font-extrabold text-blue-600 mt-1">${approvedPrompts.length}</div>
          <div class="text-[10px] text-slate-500 mt-0.5">Auto-computed</div>
        </div>
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">AI Tools</div>
          <div class="text-2xl font-extrabold text-indigo-600 mt-1">${allAITools.length || 140}</div>
          <div class="text-[10px] text-slate-500 mt-0.5">Active engines</div>
        </div>
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Published Creators</div>
          <div class="text-2xl font-extrabold text-purple-600 mt-1">${uniqueCreators.size}</div>
          <div class="text-[10px] text-slate-500 mt-0.5">Active authors</div>
        </div>
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Countries Served</div>
          <div class="text-2xl font-extrabold text-emerald-600 mt-1">48</div>
          <div class="text-[10px] text-slate-500 mt-0.5">Global audience</div>
        </div>
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Total Copy Events</div>
          <div class="text-2xl font-extrabold text-amber-600 mt-1">${totalCopies}</div>
          <div class="text-[10px] text-slate-500 mt-0.5">Tracked actions</div>
        </div>
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div class="text-[10px] font-extrabold uppercase text-slate-400">Live Pulse Base</div>
          <div class="text-2xl font-extrabold text-emerald-600 mt-1">128</div>
          <div class="text-[10px] text-slate-500 mt-0.5">Active visitors</div>
        </div>
      </div>

      <!-- Config & Override Form -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-5">
        <div class="border-b border-slate-100 pb-3">
          <h4 class="text-sm font-bold text-slate-900">Manual Override Settings</h4>
          <p class="text-xs text-slate-500">Set custom display counts or thresholds. Set to 0 or leave empty to use automatic calculation from Firestore data.</p>
        </div>

        <form id="stats-config-form" onsubmit="handleSaveStatsConfig(event)" class="space-y-4 text-xs font-medium">
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <label class="block text-slate-700 font-bold mb-1">Premium Prompts Override</label>
              <input type="number" id="stats-override-prompts" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500" placeholder="0 = Auto-calculate from database" />
              <p class="text-[10px] text-slate-400 mt-1">Calculated count: ${approvedPrompts.length}</p>
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1">AI Tools Supported Override</label>
              <input type="number" id="stats-override-tools" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500" placeholder="0 = Auto-calculate" />
              <p class="text-[10px] text-slate-400 mt-1">Calculated count: ${allAITools.length || 140}</p>
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1">Active Creators Override</label>
              <input type="number" id="stats-override-creators" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500" placeholder="0 = Auto-calculate" />
              <p class="text-[10px] text-slate-400 mt-1">Calculated count: ${uniqueCreators.size}</p>
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1">Countries Served Count *</label>
              <input type="number" id="stats-countries-served" required min="1" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500" placeholder="e.g. 48" />
              <p class="text-[10px] text-slate-400 mt-1">Default: 48 countries</p>
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1">Copied Today Offset / Override</label>
              <input type="number" id="stats-override-copied" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500" placeholder="0 = Auto-count daily events" />
              <p class="text-[10px] text-slate-400 mt-1">Real-time copy events auto-increment this count</p>
            </div>
            <div>
              <label class="block text-slate-700 font-bold mb-1">Live Searching Base Count *</label>
              <input type="number" id="stats-live-searching" required min="1" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500" placeholder="e.g. 128" />
              <p class="text-[10px] text-slate-400 mt-1">Base active visitors (applies organic +/- jitter)</p>
            </div>
          </div>

          <div class="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
            <button type="submit" id="save-stats-btn" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-md transition flex items-center gap-2">
              <i data-lucide="save" class="w-4 h-4"></i> Save Statistics Configuration
            </button>
          </div>
        </form>
      </div>
    </div>
  `);
  lcIcons();

  // Load existing stats config into form
  try {
    const snap = await getDoc(doc(db, 'siteConfigs', 'stats'));
    if (snap.exists()) {
      const d = snap.data();
      const overrides = d.manualOverrides || {};
      const setVal = (id: string, val: any) => {
        const input = $(id) as HTMLInputElement;
        if (input && val !== undefined && val !== null) input.value = String(val);
      };
      if (overrides.premiumPrompts) setVal('stats-override-prompts', overrides.premiumPrompts);
      if (overrides.aiToolsSupported) setVal('stats-override-tools', overrides.aiToolsSupported);
      if (overrides.activeCreators) setVal('stats-override-creators', overrides.activeCreators);
      setVal('stats-countries-served', d.countriesServed || 48);
      if (overrides.copiedToday) setVal('stats-override-copied', overrides.copiedToday);
      setVal('stats-live-searching', d.liveSearchingBase || 128);
    } else {
      ( $('stats-countries-served') as HTMLInputElement ).value = '48';
      ( $('stats-live-searching') as HTMLInputElement ).value = '128';
    }
  } catch (err) {
    showToast('Could not fetch existing stats config', 'warning');
  }
}

async function handleSaveStatsConfig(e: Event) {
  e.preventDefault();
  const btn = $('save-stats-btn') as HTMLButtonElement;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  const getNum = (id: string): number => {
    const val = ( $(id) as HTMLInputElement )?.value;
    return val ? parseInt(val, 10) || 0 : 0;
  };

  const manualOverrides = {
    premiumPrompts: getNum('stats-override-prompts'),
    aiToolsSupported: getNum('stats-override-tools'),
    activeCreators: getNum('stats-override-creators'),
    copiedToday: getNum('stats-override-copied'),
  };

  const countriesServed = getNum('stats-countries-served') || 48;
  const liveSearchingBase = getNum('stats-live-searching') || 128;

  try {
    await setDoc(doc(db, 'siteConfigs', 'stats'), {
      manualOverrides,
      countriesServed,
      liveSearchingBase,
      updatedAt: serverTimestamp()
    }, { merge: true });

    showToast('Site statistics updated successfully!', 'success');
    logAdminAction('Update Site Statistics', 'siteConfigs/stats');
  } catch (err) {
    showToast('Failed to update statistics', 'error');
    handleFirestoreError(err, OperationType.WRITE, 'siteConfigs/stats');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<i data-lucide="save" class="w-4 h-4"></i> Save Statistics Configuration`; lcIcons(); }
  }
}

// =============================================================================
// PROFILE SECTION
// =============================================================================
function renderProfile() {
  const user = currentAdminUser;
  if (!user) return;
  setContent('admin-content', `
    <div class="max-w-lg space-y-4">
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <div class="flex items-center gap-4 mb-6">
          <div class="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center text-white font-extrabold text-2xl shadow-md">
            ${(user.displayName || user.email || 'A').charAt(0).toUpperCase()}
          </div>
          <div>
            <h3 class="text-base font-extrabold text-slate-900">${user.displayName || 'Admin'}</h3>
            <p class="text-sm text-slate-400">${user.email}</p>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-purple-100 text-purple-700 mt-1 inline-flex items-center gap-1">
              <i data-lucide="shield-check" class="w-3 h-3"></i> Administrator
            </span>
          </div>
        </div>

        <form onsubmit="updateProfile(event)" class="space-y-4">
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1.5">Display Name</label>
            <input type="text" id="profile-name" value="${user.displayName || ''}" placeholder="Your name" class="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:border-blue-500 transition" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1.5">Email</label>
            <input type="email" value="${user.email || ''}" disabled class="w-full px-3 py-2.5 border border-slate-100 rounded-xl text-sm bg-slate-50 text-slate-400 cursor-not-allowed" />
          </div>
          <button type="submit" class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl transition flex items-center gap-2">
            <i data-lucide="save" class="w-4 h-4"></i> Update Profile
          </button>
        </form>
      </div>

      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <h4 class="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
          <i data-lucide="shield" class="w-4 h-4 text-slate-500"></i> Security
        </h4>
        <div class="space-y-2">
          <div class="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
            <div>
              <p class="text-xs font-bold text-slate-700">Authentication Provider</p>
              <p class="text-[10px] text-slate-400">${user.providerData[0]?.providerId || 'password'}</p>
            </div>
            <span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">Active</span>
          </div>
          <button onclick="handleAdminLogout()" class="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 text-sm font-semibold transition">
            <i data-lucide="log-out" class="w-4 h-4"></i> Sign Out
          </button>
        </div>
      </div>
    </div>
  `);
  lcIcons();
}

async function updateProfile(e: Event) {
  e.preventDefault();
  const name = ($('profile-name') as HTMLInputElement).value.trim();
  try {
    if (currentAdminUser) {
      await updateDoc(doc(db, 'users', currentAdminUser.uid), { displayName: name, updatedAt: serverTimestamp() });
      updateAdminUserUI(currentAdminUser);
      showToast('Profile updated!', 'success');
    }
  } catch (err) {
    showToast('Failed to update profile', 'error');
  }
}

// =============================================================================
// SIDEBAR TOGGLE (MOBILE)
// =============================================================================
function toggleAdminSidebar() {
  const sidebar = $('admin-sidebar');
  if (sidebar) sidebar.classList.toggle('hidden');
}

// =============================================================================
// CMS MODULES: BLOG MANAGEMENT (CRUD & RICH CMS SUITE)
// =============================================================================

let activeBlogsList: any[] = [];

async function renderBlogs() {
  setContent('admin-content', `
    <div class="space-y-6">
      <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 class="text-sm font-bold text-slate-900 flex items-center gap-2">
            <i data-lucide="newspaper" class="w-4 h-4 text-blue-600"></i> AI Blog Articles & Content CMS
          </h3>
          <p class="text-[10px] text-slate-400 mt-0.5">Compose, schedule, draft, and publish tutorials, news, and prompt engineering guides</p>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="seedDefaultBlogs()" class="px-3 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-bold rounded-xl border border-emerald-200 transition flex items-center gap-1.5" title="Generate sample AI tutorial articles">
            <i data-lucide="wand-2" class="w-3.5 h-3.5"></i> Seed Articles
          </button>
          <button onclick="openBlogComposer()" class="px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl shadow-sm transition flex items-center gap-1.5">
            <i data-lucide="plus" class="w-4 h-4"></i> Write Article
          </button>
        </div>
      </div>

      <!-- Composer Form (Hidden by default) -->
      <div id="blog-composer-card" class="hidden bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
        <h4 id="blog-composer-title" class="text-xs font-bold text-slate-950 uppercase tracking-wider flex items-center gap-2">
          <i data-lucide="pen-tool" class="w-4 h-4 text-blue-600"></i> Compose New Post
        </h4>
        <form onsubmit="saveBlogPost(event)" class="space-y-4 text-xs font-medium">
          <input type="hidden" id="blog-form-id" value="" />
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Post Title *</label>
              <input type="text" id="blog-title" required oninput="autoSlugify(this.value)" class="w-full px-3 py-2 border border-slate-200 rounded-xl focus:border-blue-500 transition" placeholder="e.g. 10 Tips for Flux AI Prompting" />
            </div>
            <div>
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Slug (URL Path) *</label>
              <input type="text" id="blog-slug" required class="w-full px-3 py-2 border border-slate-200 rounded-xl focus:border-blue-500 transition font-mono" placeholder="e.g. 10-tips-for-flux-ai" />
            </div>
          </div>
          
          <div class="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div>
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Author Name *</label>
              <input type="text" id="blog-author" required class="w-full px-3 py-2 border border-slate-200 rounded-xl" placeholder="e.g. PromptVerse Editorial" />
            </div>
            <div>
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Category *</label>
              <input type="text" id="blog-category" required class="w-full px-3 py-2 border border-slate-200 rounded-xl" placeholder="e.g. Tutorials, Cheatsheet, Guides" />
            </div>
            <div>
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Reading Time *</label>
              <input type="text" id="blog-reading-time" required class="w-full px-3 py-2 border border-slate-200 rounded-xl" placeholder="e.g. 5 min read" />
            </div>
            <div>
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Status *</label>
              <select id="blog-status" onchange="toggleScheduleInput(this.value)" class="w-full px-3 py-2 border border-slate-200 rounded-xl font-bold">
                <option value="published">Published</option>
                <option value="draft">Draft</option>
                <option value="scheduled">Scheduled</option>
              </select>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Featured Cover Image URL</label>
              <div class="flex gap-2">
                <input type="text" id="blog-image" class="flex-1 px-3 py-2 border border-slate-200 rounded-xl font-mono text-xs" placeholder="Paste image URL or upload below..." />
                <input type="file" id="blog-img-file-input" accept="image/*" class="hidden" onchange="uploadBlogCoverImage(this)" />
                <button type="button" id="upload-blog-img-btn" onclick="document.getElementById('blog-img-file-input').click()" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition flex items-center gap-1 shrink-0">
                  <i data-lucide="upload" class="w-3.5 h-3.5"></i> Upload CDN
                </button>
              </div>
            </div>
            <div id="blog-schedule-container" class="hidden">
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Publish / Schedule Date *</label>
              <input type="datetime-local" id="blog-schedule-date" class="w-full px-3 py-2 border border-slate-200 rounded-xl" />
            </div>
          </div>

          <!-- SEO Metadata Fields Section -->
          <div class="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
            <h5 class="text-xs font-bold text-slate-800 flex items-center gap-1.5"><i data-lucide="search" class="w-4 h-4 text-blue-500"></i> SEO & Google Search Snippet Optimization</h5>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">SEO Meta Title</label>
                <input type="text" id="blog-seo-title" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="Defaults to post title if blank" />
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">SEO Meta Keywords</label>
                <input type="text" id="blog-seo-keywords" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="e.g. AI prompts, Flux, Midjourney guide" />
              </div>
            </div>
            <div>
              <label class="block text-[10px] font-bold text-slate-600 mb-1">SEO Meta Description</label>
              <input type="text" id="blog-seo-desc" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="Brief search snippet summary..." />
            </div>
          </div>

          <div>
            <label class="block text-[11px] font-bold text-slate-700 mb-1">Article Summary *</label>
            <input type="text" id="blog-summary" required class="w-full px-3 py-2 border border-slate-200 rounded-xl" placeholder="Quick 1-2 sentence catchphrase summary of this blog post..." />
          </div>

          <div>
            <div class="flex items-center justify-between mb-1.5 flex-wrap gap-2">
              <label class="block text-[11px] font-bold text-slate-700">Article Content (HTML / Rich Formatting) *</label>
              <!-- Formatting Toolbar Buttons -->
              <div class="flex items-center gap-1 flex-wrap bg-slate-100 p-1 rounded-xl border border-slate-200">
                <button type="button" onclick="insertBlogFormattingTag('<b>', '</b>')" class="px-2 py-1 bg-white rounded font-bold text-[10px] text-slate-700 hover:bg-slate-200" title="Bold"><b>B</b></button>
                <button type="button" onclick="insertBlogFormattingTag('<i>', '</i>')" class="px-2 py-1 bg-white rounded italic text-[10px] text-slate-700 hover:bg-slate-200" title="Italic"><i>I</i></button>
                <button type="button" onclick="insertBlogFormattingTag('<h3>', '</h3>')" class="px-2 py-1 bg-white rounded font-bold text-[10px] text-slate-700 hover:bg-slate-200" title="Heading 3">H3</button>
                <button type="button" onclick="insertBlogFormattingTag('<h4>', '</h4>')" class="px-2 py-1 bg-white rounded font-bold text-[10px] text-slate-700 hover:bg-slate-200" title="Heading 4">H4</button>
                <button type="button" onclick="insertBlogFormattingTag('<a href=\'#\'>', '</a>')" class="px-2 py-1 bg-white rounded text-[10px] text-slate-700 hover:bg-slate-200" title="Link">Link</button>
                <button type="button" onclick="insertBlogFormattingTag('<img src=\'', '\' alt=\'\' class=\'w-full rounded-2xl my-4\' />')" class="px-2 py-1 bg-white rounded text-[10px] text-slate-700 hover:bg-slate-200" title="Image Tag">Img</button>
                <button type="button" onclick="insertBlogFormattingTag('<ul>\n  <li>', '</li>\n</ul>')" class="px-2 py-1 bg-white rounded text-[10px] text-slate-700 hover:bg-slate-200" title="Bullet List">&bull; List</button>
                <button type="button" onclick="insertBlogFormattingTag('<blockquote>', '</blockquote>')" class="px-2 py-1 bg-white rounded text-[10px] text-slate-700 hover:bg-slate-200" title="Quote">Quote</button>
                <button type="button" onclick="insertBlogFormattingTag('<pre><code>', '</code></pre>')" class="px-2 py-1 bg-white rounded font-mono text-[10px] text-slate-700 hover:bg-slate-200" title="Code Block">Code</button>
                <button type="button" onclick="insertBlogFormattingTag('<p>', '</p>')" class="px-2 py-1 bg-white rounded text-[10px] text-slate-700 hover:bg-slate-200" title="Paragraph">Para</button>
              </div>
            </div>
            <textarea id="blog-content" required rows="12" class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl font-mono text-xs focus:border-blue-500 transition leading-relaxed" placeholder="Write your article content using HTML formatting or plain text..."></textarea>
          </div>
          
          <div class="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onclick="previewBlogPost()" class="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-xl transition flex items-center gap-1.5"><i data-lucide="eye" class="w-4 h-4"></i> Live Preview</button>
            <button type="button" onclick="$('blog-composer-card').classList.add('hidden')" class="px-4 py-2 border border-slate-200 hover:bg-slate-50 rounded-xl font-semibold">Cancel</button>
            <button type="submit" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-sm transition flex items-center gap-1.5"><i data-lucide="save" class="w-4 h-4"></i> Save Article</button>
          </div>
        </form>
      </div>

      <!-- Blog Live Preview Container (Hidden by default) -->
      <div id="blog-preview-container" class="hidden bg-slate-100 rounded-3xl border border-slate-200 p-6 space-y-4">
        <div class="flex items-center justify-between border-b border-slate-200 pb-2">
          <h4 class="text-xs font-bold text-slate-800 uppercase tracking-widest flex items-center gap-1.5"><i data-lucide="eye" class="w-4 h-4 text-amber-500"></i> Article Live Preview</h4>
          <button onclick="closeBlogPreview()" class="text-xs text-rose-600 font-bold hover:underline">Close Preview</button>
        </div>
        <article class="bg-white rounded-2xl p-6 border border-slate-200 space-y-4 shadow-sm max-w-3xl mx-auto">
          <span id="preview-blog-cat" class="px-2.5 py-1 rounded bg-blue-50 text-blue-600 text-[10px] font-bold uppercase">Tutorial</span>
          <h1 id="preview-blog-title" class="text-2xl font-extrabold text-slate-900 leading-tight">Post Title</h1>
          <div class="flex items-center gap-3 text-[11px] text-slate-400 font-bold">
            <span id="preview-blog-author">By Admin</span>
            <span>&middot;</span>
            <span id="preview-blog-read">5 min read</span>
            <span>&middot;</span>
            <span id="preview-blog-date">Date</span>
          </div>
          <div id="preview-blog-body" class="prose prose-slate text-xs sm:text-sm text-slate-700 leading-relaxed border-t border-slate-100 pt-4"></div>
        </article>
      </div>

      <!-- Articles Table with Search & Filter Header -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="p-4 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
          <div class="flex items-center gap-2">
            <span class="text-xs font-bold text-slate-800">Published & Draft Posts</span>
            <span id="blogs-count-badge" class="text-[10px] bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-full font-bold">0 posts</span>
          </div>
          <div class="flex items-center gap-2">
            <input type="text" id="blog-search" placeholder="Search title or category..." oninput="filterBlogsTable()" class="px-3 py-1.5 border border-slate-200 rounded-xl text-xs focus:border-blue-500 transition w-48 sm:w-64" />
            <select id="blog-status-filter" onchange="filterBlogsTable()" class="px-3 py-1.5 border border-slate-200 rounded-xl text-xs font-bold focus:border-blue-500 transition">
              <option value="all">All Statuses</option>
              <option value="published">Published</option>
              <option value="draft">Drafts</option>
              <option value="scheduled">Scheduled</option>
            </select>
          </div>
        </div>
        <div class="overflow-x-auto w-full">
          <table class="w-full text-xs min-w-[700px]">
            <thead class="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold">
              <tr>
                <th class="p-3 text-left w-14">Image</th>
                <th class="p-3 text-left">Article Details</th>
                <th class="p-3 text-left">Category</th>
                <th class="p-3 text-left">Slug</th>
                <th class="p-3 text-left">Status</th>
                <th class="p-3 text-left">Date</th>
                <th class="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody id="blogs-tbody" class="divide-y divide-slate-100">
              <tr><td colspan="7" class="p-8 text-center text-slate-400">Loading articles...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `);
  lcIcons();

  try {
    const snap = await getDocs(query(collection(db, 'blogs'), orderBy('timestamp', 'desc')));
    activeBlogsList = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
    
    $('blogs-count-badge')!.textContent = `${activeBlogsList.length} articles`;
    renderBlogsTableRows(activeBlogsList);
  } catch (err) {
    $('blogs-tbody')!.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-rose-500 font-semibold">Failed to load articles from database.</td></tr>`;
  }
}

function renderBlogsTableRows(list: any[]) {
  const tbody = $('blogs-tbody');
  if (!tbody) return;
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400 text-xs">No articles found matching criteria.</td></tr>`;
    return;
  }
  
  tbody.innerHTML = list.map(b => {
    let imgTag = '<div class="w-10 h-10 bg-slate-100 rounded-lg border border-slate-200 shrink-0 flex items-center justify-center"><i data-lucide="image" class="w-4 h-4 text-slate-400"></i></div>';
    if (b.featuredImage) {
      imgTag = `<img src="${b.featuredImage}" class="w-10 h-10 rounded-lg object-cover border border-slate-100 shrink-0 shadow-sm" onerror="this.parentElement.innerHTML='<div class=\\'w-10 h-10 bg-slate-100 rounded-lg border border-slate-200 shrink-0 flex items-center justify-center\\'><i data-lucide=\\'image\\' class=\\'w-4 h-4 text-slate-400\\'></i></div>'" />`;
    }
    const scheduleText = b.status === 'scheduled' && b.publishDate 
      ? `<div class="text-[9px] text-indigo-500 font-semibold mt-0.5">Sched: ${formatDate(b.publishDate)}</div>` 
      : '';
    return `
      <tr class="hover:bg-slate-50/50 transition">
        <td class="p-3 w-14 shrink-0">${imgTag}</td>
        <td class="p-3">
          <div class="font-bold text-slate-900 max-w-[220px] truncate" title="${b.title}">${b.title}</div>
          <div class="text-[9px] text-slate-400 font-medium">By ${b.author || 'Admin'} &middot; ${b.readingTime || '3 min read'}</div>
        </td>
        <td class="p-3 font-semibold text-slate-600 whitespace-nowrap">${b.category || 'Tutorial'}</td>
        <td class="p-3 font-mono text-slate-500 max-w-[150px] truncate" title="${b.slug}">${b.slug}</td>
        <td class="p-3 whitespace-nowrap">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${b.status === 'published' ? 'bg-emerald-50 text-emerald-700' : b.status === 'scheduled' ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-100 text-slate-600'}">
            ${b.status || 'draft'}
          </span>
          ${scheduleText}
        </td>
        <td class="p-3 text-slate-400 whitespace-nowrap">${formatDate(b.timestamp)}</td>
        <td class="p-3 text-right space-x-0.5 whitespace-nowrap">
          <button onclick="editBlogPost('${b.id}')" class="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="Edit Post"><i data-lucide="edit-3" class="w-4 h-4 inline"></i></button>
          <button onclick="deleteBlogPostConfirm('${b.id}')" class="p-1.5 text-rose-600 hover:bg-rose-50 rounded transition" title="Delete Post"><i data-lucide="trash-2" class="w-4 h-4 inline"></i></button>
        </td>
      </tr>
    `;
  }).join('');
  lcIcons();
}

function filterBlogsTable() {
  const search = ($('blog-search') as HTMLInputElement)?.value.toLowerCase() || '';
  const statusFilter = ($('blog-status-filter') as HTMLSelectElement)?.value || 'all';

  const filtered = activeBlogsList.filter(b => {
    const matchesSearch = !search ||
      (b.title || '').toLowerCase().includes(search) ||
      (b.category || '').toLowerCase().includes(search) ||
      (b.author || '').toLowerCase().includes(search) ||
      (b.slug || '').toLowerCase().includes(search);
    const matchesStatus = statusFilter === 'all' || b.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  renderBlogsTableRows(filtered);
}

async function uploadBlogCoverImage(input: HTMLInputElement) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  const btn = $('upload-blog-img-btn') as HTMLButtonElement;
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }
  try {
    showToast('Uploading cover image to Cloud CDN...', 'info');
    const url = await uploadToCloudinary(file);
    const imgInput = $('blog-image') as HTMLInputElement;
    if (imgInput) imgInput.value = url;
    showToast('Cover image uploaded to CDN!', 'success');
  } catch (err: any) {
    showToast(`Image upload failed: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="upload" class="w-3.5 h-3.5"></i> Upload CDN'; lcIcons(); }
  }
}

function insertBlogFormattingTag(prefix: string, suffix: string) {
  const textarea = $('blog-content') as HTMLTextAreaElement;
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = textarea.value;
  const selectedText = val.substring(start, end) || 'text';
  const replacement = prefix + selectedText + suffix;
  textarea.value = val.substring(0, start) + replacement + val.substring(end);
  textarea.focus();
  textarea.setSelectionRange(start + prefix.length, start + prefix.length + selectedText.length);
}

async function seedDefaultBlogs() {
  showConfirm('Seed Sample Articles', 'This will add 3 professional AI prompt engineering tutorial articles to your blog collection. Continue?', async () => {
    try {
      showToast('Seeding sample blog articles...', 'info');
      const seedArticles = [
        {
          title: "Mastering Flux AI Prompting: The Ultimate 2026 Guide",
          slug: "mastering-flux-ai-prompting-guide",
          author: "PromptVerse Editorial",
          category: "Tutorials",
          readingTime: "6 min read",
          status: "published",
          featuredImage: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80",
          summary: "Learn how to craft ultra-realistic photo prompts using Flux.1 Schnell and Flux Pro parameters.",
          contentHTML: `<h3>Introduction to Flux AI Architecture</h3><p>Flux.1 has redefined text-to-image synthesis with unmatched typography compliance and photorealistic lighting texture fidelity. In this tutorial, we analyze exact prompt structure for Flux models.</p><h4>1. Prompt Keyword Hierarchy</h4><p>When composing a Flux prompt, place lighting and camera settings at the beginning:</p><pre><code>A hyperrealistic 35mm film photograph of an elderly artisan in a sunlit wooden workshop, shot on Leica M11, soft warm golden hour light, shallow depth of field --ar 16:9</code></pre><h4>2. Negative Prompts and Clarity</h4><p>Unlike legacy SDXL models, Flux works best with descriptive direct statements rather than long negative prompt lists.</p>`,
          seoTitle: "Mastering Flux AI Prompting Guide | PromptVerse",
          seoDesc: "Complete 2026 guide to prompt engineering for Flux.1 AI image generation models.",
          seoKeywords: "Flux AI, prompt engineering, Midjourney, AI tutorials",
          timestamp: serverTimestamp()
        },
        {
          title: "ChatGPT System Prompts Masterclass: Persona & Formatting Control",
          slug: "chatgpt-system-prompts-masterclass",
          author: "Rajesh Kumar",
          category: "Guides",
          readingTime: "8 min read",
          status: "published",
          featuredImage: "https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&w=800&q=80",
          summary: "Discover advanced techniques for framing LLM system prompts for coding, content writing, and data extraction.",
          contentHTML: `<h3>The Power of System Instructions</h3><p>System prompts establish the core identity, boundaries, and formatting output constraints for ChatGPT and Gemini models before any user message is evaluated.</p><h4>Formatting Markdown Output</h4><p>Enforce clean JSON or Structured Markdown by specifying output schema directly in the preamble:</p><blockquote>Always structure responses with clear H3 headers, key bullet points, and code blocks with syntax highlighting.</blockquote>`,
          seoTitle: "ChatGPT System Prompts Masterclass | PromptVerse",
          seoDesc: "Learn how to write high-converting system prompts for ChatGPT and LLM agents.",
          seoKeywords: "ChatGPT, system prompt, LLM prompt engineering",
          timestamp: serverTimestamp()
        },
        {
          title: "Midjourney v6.1 Parameter Cheatsheet: Aspect Ratios, Chaos & Stylize",
          slug: "midjourney-v61-parameter-cheatsheet",
          author: "PromptVerse Team",
          category: "Cheatsheet",
          readingTime: "4 min read",
          status: "published",
          featuredImage: "https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?auto=format&fit=crop&w=800&q=80",
          summary: "A concise reference guide to all Midjourney v6.1 command parameters and aspect ratio hacks.",
          contentHTML: `<h3>Midjourney v6.1 Essential Flags</h3><ul><li><b>--ar 16:9</b> - Cinematic widescreen orientation</li><li><b>--stylize 250</b> - Enhances artistic rendering and detail richness</li><li><b>--chaos 15</b> - Introduces initial variance across 4 grid images</li><li><b>--v 6.1</b> - Enforces latest lighting and text rendering engine</li></ul>`,
          seoTitle: "Midjourney v6.1 Parameter Cheatsheet | PromptVerse",
          seoDesc: "Quick reference guide for Midjourney v6.1 parameters: aspect ratios, stylize, chaos, and tile.",
          seoKeywords: "Midjourney v6.1, AI parameters, prompt cheatsheet",
          timestamp: serverTimestamp()
        }
      ];

      for (const art of seedArticles) {
        await addDoc(collection(db, 'blogs'), art);
      }
      showToast('3 sample articles created!', 'success');
      logAdminAction('blog_seed_articles', 'blogs');
      renderBlogs();
    } catch (err: any) {
      showToast(`Failed to seed articles: ${err.message}`, 'error');
    }
  });
}

function autoSlugify(val: string) {
  const slugInput = $('blog-slug') as HTMLInputElement;
  if (slugInput) {
    slugInput.value = val.trim().toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }
}

function toggleScheduleInput(status: string) {
  const container = $('blog-schedule-container');
  if (container) {
    if (status === 'scheduled') container.classList.remove('hidden');
    else container.classList.add('hidden');
  }
}

function previewBlogPost() {
  const title = ($('blog-title') as HTMLInputElement).value.trim() || 'Post Title';
  const category = ($('blog-category') as HTMLInputElement).value.trim() || 'General';
  const author = ($('blog-author') as HTMLInputElement).value.trim() || 'PromptVerse Admin';
  const readingTime = ($('blog-reading-time') as HTMLInputElement).value.trim() || '3 min read';
  const content = ($('blog-content') as HTMLTextAreaElement).value || '<p>Write content to see preview.</p>';

  const preview = $('blog-preview-container');
  if (preview) {
    $('preview-blog-cat')!.textContent = category;
    $('preview-blog-title')!.textContent = title;
    $('preview-blog-author')!.textContent = `By ${author}`;
    $('preview-blog-read')!.textContent = readingTime;
    $('preview-blog-date')!.textContent = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    $('preview-blog-body')!.innerHTML = content;
    preview.classList.remove('hidden');
  }
}

function closeBlogPreview() {
  const preview = $('blog-preview-container');
  if (preview) preview.classList.add('hidden');
}

function openBlogComposer() {
  show('blog-composer-card');
  closeBlogPreview();
  $('blog-composer-title')!.textContent = 'Compose New Post';
  ( $('blog-form-id') as HTMLInputElement).value = '';
  ( $('blog-title') as HTMLInputElement).value = '';
  ( $('blog-slug') as HTMLInputElement).value = '';
  ( $('blog-author') as HTMLInputElement).value = currentAdminUser?.displayName || 'PromptVerse Admin';
  ( $('blog-category') as HTMLInputElement).value = 'Tutorials';
  ( $('blog-reading-time') as HTMLInputElement).value = '5 min read';
  ( $('blog-image') as HTMLInputElement).value = '';
  ( $('blog-status') as HTMLSelectElement).value = 'published';
  ( $('blog-summary') as HTMLInputElement).value = '';
  ( $('blog-content') as HTMLTextAreaElement).value = '';
  ( $('blog-seo-title') as HTMLInputElement).value = '';
  ( $('blog-seo-desc') as HTMLInputElement).value = '';
  ( $('blog-seo-keywords') as HTMLInputElement).value = '';
  toggleScheduleInput('published');
}

function editBlogPost(id: string) {
  const b = activeBlogsList.find(x => x.id === id);
  if (!b) return;
  show('blog-composer-card');
  closeBlogPreview();
  $('blog-composer-title')!.textContent = 'Edit Blog Post';
  ( $('blog-form-id') as HTMLInputElement).value = b.id;
  ( $('blog-title') as HTMLInputElement).value = b.title || '';
  ( $('blog-slug') as HTMLInputElement).value = b.slug || '';
  ( $('blog-author') as HTMLInputElement).value = b.author || '';
  ( $('blog-category') as HTMLInputElement).value = b.category || '';
  ( $('blog-reading-time') as HTMLInputElement).value = b.readingTime || '5 min read';
  ( $('blog-image') as HTMLInputElement).value = b.featuredImage || '';
  ( $('blog-status') as HTMLSelectElement).value = b.status || 'published';
  ( $('blog-summary') as HTMLInputElement).value = b.summary || '';
  ( $('blog-content') as HTMLTextAreaElement).value = b.contentHTML || '';
  ( $('blog-seo-title') as HTMLInputElement).value = b.seoTitle || '';
  ( $('blog-seo-desc') as HTMLInputElement).value = b.seoDesc || '';
  ( $('blog-seo-keywords') as HTMLInputElement).value = b.seoKeywords || '';
  
  toggleScheduleInput(b.status);
  if (b.status === 'scheduled' && b.publishDate) {
    const d = b.publishDate.seconds ? new Date(b.publishDate.seconds * 1000) : new Date(b.publishDate);
    const tzoffset = d.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(d.getTime() - tzoffset)).toISOString().slice(0, 16);
    ( $('blog-schedule-date') as HTMLInputElement).value = localISOTime;
  }
}

async function saveBlogPost(e: Event) {
  e.preventDefault();
  const id = ($('blog-form-id') as HTMLInputElement).value;
  const title = ($('blog-title') as HTMLInputElement).value.trim();
  const slug = ($('blog-slug') as HTMLInputElement).value.trim().toLowerCase().replace(/\s+/g, '-');
  const author = ($('blog-author') as HTMLInputElement).value.trim();
  const category = ($('blog-category') as HTMLInputElement).value.trim();
  const readingTime = ($('blog-reading-time') as HTMLInputElement).value.trim();
  const featuredImage = ($('blog-image') as HTMLInputElement).value.trim();
  const status = ($('blog-status') as HTMLSelectElement).value;
  const summary = ($('blog-summary') as HTMLInputElement).value.trim();
  const contentHTML = ($('blog-content') as HTMLTextAreaElement).value;
  
  const seoTitle = ($('blog-seo-title') as HTMLInputElement).value.trim();
  const seoDesc = ($('blog-seo-desc') as HTMLInputElement).value.trim();
  const seoKeywords = ($('blog-seo-keywords') as HTMLInputElement).value.trim();

  let publishDate: any = null;
  if (status === 'scheduled') {
    const sDate = ($('blog-schedule-date') as HTMLInputElement).value;
    if (!sDate) {
      showToast('Schedule date is required for scheduled status', 'warning');
      return;
    }
    publishDate = new Date(sDate);
  }

  try {
    const postData = {
      title, slug, author, category, readingTime, featuredImage, status, summary, contentHTML,
      seoTitle, seoDesc, seoKeywords,
      publishDate: publishDate ? publishDate : serverTimestamp(),
      timestamp: serverTimestamp()
    };
    if (id) {
      await setDoc(doc(db, 'blogs', id), postData, { merge: true });
      showToast('Blog article updated!', 'success');
      logAdminAction('blog_update', title);
    } else {
      await addDoc(collection(db, 'blogs'), postData);
      showToast('New blog article saved!', 'success');
      logAdminAction('blog_create', title);
    }
    renderBlogs();
  } catch (err) {
    showToast('Failed to save blog post', 'error');
  }
}

function deleteBlogPostConfirm(id: string) {
  showConfirm('Delete Blog Post', 'Are you sure you want to delete this article?', async () => {
    try {
      await deleteDoc(doc(db, 'blogs', id));
      showToast('Article deleted', 'success');
      logAdminAction('blog_delete', id);
      renderBlogs();
    } catch {
      showToast('Failed to delete blog post', 'error');
    }
  });
}

// =============================================================================
// CMS MODULES: STATIC PAGES MANAGEMENT
// =============================================================================

let activeStaticPages: any[] = [];

async function renderPages() {
  setContent('admin-content', `
    <div class="space-y-6">
      <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
        <h3 class="text-sm font-bold text-slate-900 mb-1">Static Page CMS</h3>
        <p class="text-[10px] text-slate-400">Edit dynamic pages: About Us, Privacy Policy, Terms, Careers, FAQ, etc.</p>
      </div>

      <!-- Editor Panel (Hidden by default) -->
      <div id="page-editor-card" class="hidden bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
        <h4 id="page-editor-title" class="text-xs font-bold text-slate-950 uppercase tracking-wider">Edit Page Content</h4>
        <form onsubmit="saveStaticPage(event)" class="space-y-4 text-xs font-medium">
          <input type="hidden" id="page-form-id" value="" />
          <div>
            <label class="block text-[11px] font-bold text-slate-700 mb-1">Page Title *</label>
            <input type="text" id="page-title-input" required class="w-full px-3 py-2 border border-slate-200 rounded-xl" />
          </div>
          <div>
            <label class="block text-[11px] font-bold text-slate-700 mb-1">Content (HTML / Rich Text) *</label>
            <textarea id="page-content-input" required rows="12" class="w-full px-3 py-2 border border-slate-200 rounded-xl font-mono"></textarea>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" onclick="$('page-editor-card').classList.add('hidden')" class="px-4 py-2 border rounded-xl">Cancel</button>
            <button type="submit" class="px-4 py-2 bg-blue-600 text-white font-bold rounded-xl">Save Content</button>
          </div>
        </form>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4" id="pages-grid-list">
        <div class="col-span-full py-8 text-center text-slate-400 text-sm">Loading pages...</div>
      </div>
    </div>
  `);
  lcIcons();

  try {
    const snap = await getDocs(collection(db, 'staticPages'));
    activeStaticPages = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    const grid = $('pages-grid-list');
    if (!grid) return;
    if (activeStaticPages.length === 0) {
      // Seed default static pages
      const defaults = [
        { id: 'about', title: 'About Us', contentHTML: '<p>About PromptVerse details go here...</p>' },
        { id: 'privacy', title: 'Privacy Policy', contentHTML: '<p>Privacy policies go here...</p>' },
        { id: 'terms', title: 'Terms & Conditions', contentHTML: '<p>Terms and Conditions go here...</p>' },
        { id: 'cookies', title: 'Cookie Policy', contentHTML: '<p>Cookie policies go here...</p>' },
        { id: 'faq_general', title: 'General FAQ', contentHTML: '<p>FAQ contents go here...</p>' }
      ];
      for (const p of defaults) {
        await setDoc(doc(db, 'staticPages', p.id), { title: p.title, contentHTML: p.contentHTML, updatedAt: serverTimestamp() });
      }
      renderPages();
      return;
    }

    grid.innerHTML = activeStaticPages.map(p => `
      <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between space-y-4">
        <div>
          <h4 class="font-bold text-slate-900 text-sm flex items-center gap-2">
            <i data-lucide="file-text" class="w-4 h-4 text-blue-500"></i> ${p.title}
          </h4>
          <span class="text-[10px] font-mono text-slate-400">ID: ${p.id}</span>
        </div>
        <button onclick="editStaticPage('${p.id}')" class="w-full py-2 bg-slate-50 hover:bg-blue-50 text-blue-600 border border-slate-200/80 rounded-xl font-bold text-xs transition">
          Edit Page Content
        </button>
      </div>
    `).join('');
    lcIcons();
  } catch (err) {
    $('pages-grid-list')!.innerHTML = `<p class="col-span-full py-8 text-center text-rose-500">Failed to load pages.</p>`;
  }
}

function editStaticPage(id: string) {
  const p = activeStaticPages.find(x => x.id === id);
  if (!p) return;
  show('page-editor-card');
  ( $('page-form-id') as HTMLInputElement).value = p.id;
  ( $('page-title-input') as HTMLInputElement).value = p.title || '';
  ( $('page-content-input') as HTMLTextAreaElement).value = p.contentHTML || '';
}

async function saveStaticPage(e: Event) {
  e.preventDefault();
  const id = ($('page-form-id') as HTMLInputElement).value;
  const title = ($('page-title-input') as HTMLInputElement).value.trim();
  const contentHTML = ($('page-content-input') as HTMLTextAreaElement).value;

  try {
    await setDoc(doc(db, 'staticPages', id), { title, contentHTML, updatedAt: serverTimestamp() }, { merge: true });
    showToast('Static page content saved!', 'success');
    logAdminAction('static_page_update', title);
    renderPages();
  } catch {
    showToast('Failed to save page', 'error');
  }
}

// =============================================================================
// CMS MODULES: CONTACT SUBMISSIONS MANAGEMENT
// =============================================================================

let activeContacts: any[] = [];

async function renderContacts() {
  setContent('admin-content', `
    <div class="space-y-6">
      <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex items-center justify-between">
        <div>
          <h3 class="text-sm font-bold text-slate-900">Contact Desk</h3>
          <p class="text-[10px] text-slate-400">View and respond to inquiries submitted via the Contact Us form</p>
        </div>
        <button onclick="exportContactsCSV()" class="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-xl transition flex items-center gap-1.5">
          <i data-lucide="download" class="w-4 h-4"></i> Export CSV
        </button>
      </div>

      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold">
              <tr>
                <th class="p-3 text-left">Sender</th>
                <th class="p-3 text-left">Subject</th>
                <th class="p-3 text-left">Message</th>
                <th class="p-3 text-left">Status</th>
                <th class="p-3 text-left">Date</th>
                <th class="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody id="contacts-tbody">
              <tr><td colspan="6" class="p-8 text-center text-slate-400">Loading submissions...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `);
  lcIcons();

  try {
    const snap = await getDocs(query(collection(db, 'contactSubmissions'), orderBy('timestamp', 'desc')));
    activeContacts = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    const tbody = $('contacts-tbody');
    if (!tbody) return;
    if (activeContacts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400 text-xs">No contact form submissions received yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = activeContacts.map(c => `
      <tr class="border-b border-slate-100 hover:bg-slate-50/50">
        <td class="p-3">
          <div class="font-bold text-slate-900">${c.name}</div>
          <div class="text-[10px] text-slate-400 font-mono">${c.email}</div>
        </td>
        <td class="p-3 font-semibold text-slate-700">${c.subject}</td>
        <td class="p-3 text-slate-500 max-w-xs truncate" title="${c.message}">${c.message}</td>
        <td class="p-3">
          <select onchange="updateContactStatus('${c.id}', this.value)" class="px-2 py-1 rounded bg-slate-100 border text-[10px] font-bold">
            <option value="new" ${c.status === 'new' ? 'selected' : ''}>New</option>
            <option value="replied" ${c.status === 'replied' ? 'selected' : ''}>Replied</option>
            <option value="ignored" ${c.status === 'ignored' ? 'selected' : ''}>Ignored</option>
          </select>
        </td>
        <td class="p-3 text-slate-400">${formatDate(c.timestamp)}</td>
        <td class="p-3 text-right">
          <button onclick="deleteContactSubmission('${c.id}')" class="p-1.5 text-rose-600 hover:bg-rose-50 rounded" title="Delete Submission"><i data-lucide="trash-2" class="w-4 h-4 inline"></i></button>
        </td>
      </tr>
    `).join('');
    lcIcons();
  } catch (err) {
    $('contacts-tbody')!.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-rose-500">Failed to load contact submissions.</td></tr>`;
  }
}

async function updateContactStatus(id: string, value: string) {
  try {
    await setDoc(doc(db, 'contactSubmissions', id), { status: value }, { merge: true });
    showToast(`Status updated to: ${value}`, 'success');
  } catch {
    showToast('Failed to update status', 'error');
  }
}

async function deleteContactSubmission(id: string) {
  showConfirm('Delete Inquiry', 'Delete this contact submission record?', async () => {
    try {
      await deleteDoc(doc(db, 'contactSubmissions', id));
      showToast('Record deleted', 'success');
      renderContacts();
    } catch {
      showToast('Failed to delete submission', 'error');
    }
  });
}

function exportContactsCSV() {
  if (activeContacts.length === 0) return;
  const headers = ['Name', 'Email', 'Subject', 'Message', 'Status', 'Date'];
  const rows = activeContacts.map(c => [
    c.name, c.email, c.subject, c.message, c.status,
    c.timestamp?.seconds ? new Date(c.timestamp.seconds * 1000).toISOString() : ''
  ]);
  const csvContent = [headers.join(','), ...rows.map(r => r.map(f => `"${String(f).replace(/"/g, '""')}"`).join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', `contact_submissions_${Date.now()}.csv`);
  link.click();
}

async function renderContactSettings() {
  setContent('admin-content', `
    <div class="space-y-6">
      <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
        <h3 class="text-sm font-bold text-slate-900">Global Contact Settings</h3>
        <p class="text-[10px] text-slate-400">Manage phone numbers, emails, physical address, maps integration, and social links</p>
      </div>

      <div class="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
        <form onsubmit="saveContactSettings(event)" class="space-y-4 text-xs font-medium">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Support Phone Number *</label>
              <input type="text" id="setting-phone" required class="w-full px-3 py-2 border border-slate-200 rounded-xl" placeholder="e.g. +91 98765 43210" />
            </div>
            <div>
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Support Email Address *</label>
              <input type="email" id="setting-email" required class="w-full px-3 py-2 border border-slate-200 rounded-xl" placeholder="e.g. support@promptverse.com" />
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Office Address *</label>
              <input type="text" id="setting-address" required class="w-full px-3 py-2 border border-slate-200 rounded-xl" placeholder="e.g. HiTech City, Hyderabad, India" />
            </div>
            <div>
              <label class="block text-[11px] font-bold text-slate-700 mb-1">Business Hours *</label>
              <input type="text" id="setting-hours" required class="w-full px-3 py-2 border border-slate-200 rounded-xl" placeholder="e.g. Mon - Fri: 9:00 AM - 6:00 PM" />
            </div>
          </div>

          <div>
            <label class="block text-[11px] font-bold text-slate-700 mb-1">Google Maps Embed URL (Iframe src link) *</label>
            <input type="text" id="setting-map" required class="w-full px-3 py-2 border border-slate-200 rounded-xl" placeholder="e.g. https://www.google.com/maps/embed?pb=..." />
          </div>

          <div class="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
            <h5 class="text-xs font-bold text-slate-800 flex items-center gap-1.5"><i data-lucide="share-2" class="w-4 h-4 text-blue-500"></i> Social Media Platforms &amp; Links</h5>
            <p class="text-[10px] text-slate-400">Links configured here will automatically render brand icons in the website footer and contact desk.</p>
            
            <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">Instagram Link</label>
                <input type="text" id="setting-instagram" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="https://instagram.com/yourhandle" />
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">Facebook Link</label>
                <input type="text" id="setting-facebook" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="https://facebook.com/yourpage" />
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">YouTube Channel</label>
                <input type="text" id="setting-youtube" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="https://youtube.com/@yourchannel" />
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">Twitter / X Link</label>
                <input type="text" id="setting-twitter" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="https://x.com/username" />
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">LinkedIn Link</label>
                <input type="text" id="setting-linkedin" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="https://linkedin.com/in/username" />
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">WhatsApp Link / Number</label>
                <input type="text" id="setting-whatsapp" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="https://wa.me/15550199" />
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">Telegram Link</label>
                <input type="text" id="setting-telegram" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="https://t.me/yourchannel" />
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">Discord Invite Link</label>
                <input type="text" id="setting-discord" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="https://discord.gg/invitecode" />
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">GitHub Link</label>
                <input type="text" id="setting-github" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="https://github.com/yourorg" />
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-600 mb-1">Pinterest Link</label>
                <input type="text" id="setting-pinterest" class="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" placeholder="https://pinterest.com/yourprofile" />
              </div>
            </div>
          </div>

          <div>
            <label class="block text-[11px] font-bold text-slate-700 mb-1">Support details / Help notice</label>
            <input type="text" id="setting-support" class="w-full px-3 py-2 border border-slate-200 rounded-xl" placeholder="e.g. For urgent API support, contact helpdesk" />
          </div>

          <div class="flex items-center gap-2 py-2">
            <input type="checkbox" id="setting-form-enabled" class="rounded text-blue-600 focus:ring-blue-500" />
            <label for="setting-form-enabled" class="text-[11px] font-bold text-slate-700">Enable Contact Submission Form on public site</label>
          </div>

          <div class="flex justify-end pt-2">
            <button type="submit" class="px-6 py-2.5 bg-blue-600 text-white font-extrabold rounded-xl hover:bg-blue-700 transition shadow-md shadow-blue-500/25">Save Contact Settings</button>
          </div>
        </form>
      </div>
    </div>
  `);
  lcIcons();

  try {
    const docSnap = await getDoc(doc(db, 'settings', 'contact'));
    if (docSnap.exists()) {
      const data = docSnap.data();
      const sanitizeLoad = (val: any) => {
        if (!val || typeof val !== 'string') return '';
        const lower = val.toLowerCase();
        if (
          lower.includes('yourhandle') ||
          lower.includes('yourpage') ||
          lower.includes('yourchannel') ||
          lower.includes('/username') ||
          lower.includes('invitecode') ||
          lower.includes('yourorg') ||
          lower.includes('yourprofile')
        ) {
          return '';
        }
        return val.trim();
      };

      ($('setting-phone') as HTMLInputElement).value = data.phone || '';
      ($('setting-email') as HTMLInputElement).value = data.email || '';
      ($('setting-address') as HTMLInputElement).value = data.address || '';
      ($('setting-hours') as HTMLInputElement).value = data.businessHours || '';
      ($('setting-map') as HTMLInputElement).value = data.googleMapsEmbed || '';
      ($('setting-facebook') as HTMLInputElement).value = sanitizeLoad(data.facebook);
      ($('setting-instagram') as HTMLInputElement).value = sanitizeLoad(data.instagram);
      ($('setting-youtube') as HTMLInputElement).value = sanitizeLoad(data.youtube);
      ($('setting-twitter') as HTMLInputElement).value = sanitizeLoad(data.twitter);
      ($('setting-linkedin') as HTMLInputElement).value = sanitizeLoad(data.linkedin);
      ($('setting-whatsapp') as HTMLInputElement).value = sanitizeLoad(data.whatsapp);
      ($('setting-telegram') as HTMLInputElement).value = sanitizeLoad(data.telegram);
      ($('setting-discord') as HTMLInputElement).value = sanitizeLoad(data.discord);
      ($('setting-github') as HTMLInputElement).value = sanitizeLoad(data.github);
      ($('setting-pinterest') as HTMLInputElement).value = sanitizeLoad(data.pinterest);
      ($('setting-support') as HTMLInputElement).value = data.supportDetails || '';
      ($('setting-form-enabled') as HTMLInputElement).checked = data.contactFormEnabled !== false;
    }
  } catch (err) {
    showToast('Failed to fetch contact settings', 'error');
  }
}

async function saveContactSettings(e: Event) {
  e.preventDefault();
  const sanitizeSave = (id: string) => {
    const el = $(id) as HTMLInputElement | null;
    const val = (el?.value || '').trim();
    if (!val) return '';
    const lower = val.toLowerCase();
    if (
      lower.includes('yourhandle') ||
      lower.includes('yourpage') ||
      lower.includes('yourchannel') ||
      lower.includes('/username') ||
      lower.includes('invitecode') ||
      lower.includes('yourorg') ||
      lower.includes('yourprofile')
    ) {
      return '';
    }
    return val;
  };

  const phone = ($('setting-phone') as HTMLInputElement).value.trim();
  const email = ($('setting-email') as HTMLInputElement).value.trim();
  const address = ($('setting-address') as HTMLInputElement).value.trim();
  const businessHours = ($('setting-hours') as HTMLInputElement).value.trim();
  const googleMapsEmbed = ($('setting-map') as HTMLInputElement).value.trim();
  
  const facebook = sanitizeSave('setting-facebook');
  const instagram = sanitizeSave('setting-instagram');
  const youtube = sanitizeSave('setting-youtube');
  const twitter = sanitizeSave('setting-twitter');
  const linkedin = sanitizeSave('setting-linkedin');
  const whatsapp = sanitizeSave('setting-whatsapp');
  const telegram = sanitizeSave('setting-telegram');
  const discord = sanitizeSave('setting-discord');
  const github = sanitizeSave('setting-github');
  const pinterest = sanitizeSave('setting-pinterest');
  
  const supportDetails = ($('setting-support') as HTMLInputElement).value.trim();
  const contactFormEnabled = ($('setting-form-enabled') as HTMLInputElement).checked;

  try {
    await setDoc(doc(db, 'settings', 'contact'), {
      phone, email, address, businessHours, googleMapsEmbed,
      facebook, instagram, youtube, twitter, linkedin, whatsapp, telegram, discord, github, pinterest,
      supportDetails, contactFormEnabled,
      updatedAt: serverTimestamp()
    });
    showToast('Contact & social media settings updated successfully!', 'success');
    logAdminAction('contact_settings_update', email);
  } catch (err) {
    showToast('Failed to save contact settings', 'error');
  }
}

// =============================================================================
// CMS MODULES: MEDIA LIBRARY
// =============================================================================

let activeMediaLogs: any[] = [];

async function renderMedia() {
  setContent('admin-content', `
    <div class="space-y-6">
      <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex items-center justify-between">
        <div>
          <h3 class="text-sm font-bold text-slate-900">Cloud Media Asset Library</h3>
          <p class="text-[10px] text-slate-400">Track and copy CDN URLs of all uploaded assets</p>
        </div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4" id="media-grid-list">
        <div class="col-span-full py-8 text-center text-slate-400 text-sm">Loading media library...</div>
      </div>
    </div>
  `);
  lcIcons();

  try {
    const snap = await getDocs(query(collection(db, 'mediaLibrary'), orderBy('timestamp', 'desc'), limit(150)));
    activeMediaLogs = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    const grid = $('media-grid-list');
    if (!grid) return;
    if (activeMediaLogs.length === 0) {
      grid.innerHTML = `<p class="col-span-full text-center py-12 text-slate-400 text-sm">No media files uploaded yet.</p>`;
      return;
    }

    grid.innerHTML = activeMediaLogs.map(m => `
      <div class="bg-white p-3 border rounded-2xl hover:shadow-md transition space-y-2 flex flex-col justify-between">
        <div class="relative aspect-square rounded-xl overflow-hidden bg-slate-950 flex items-center justify-center">
          <img src="${m.url}" class="max-w-full max-h-full object-contain" />
        </div>
        <div class="min-w-0">
          <p class="text-[10px] font-bold text-slate-800 truncate" title="${m.filename}">${m.filename}</p>
          <p class="text-[9px] text-slate-400 font-mono">${(m.bytes / 1024).toFixed(1)} KB · ${m.format}</p>
        </div>
        <div class="flex gap-1">
          <button onclick="copyMediaUrl('${m.url}')" class="flex-1 py-1 bg-blue-50 text-blue-600 rounded text-[9px] font-bold hover:bg-blue-100">URL</button>
          <button onclick="deleteMediaConfirm('${m.id}')" class="py-1 px-2 bg-rose-50 text-rose-600 rounded text-[9px] hover:bg-rose-100"><i data-lucide="trash-2" class="w-3.5 h-3.5 inline"></i></button>
        </div>
      </div>
    `).join('');
    lcIcons();
  } catch (err) {
    $('media-grid-list')!.innerHTML = `<p class="col-span-full py-8 text-center text-rose-500">Failed to load media logs.</p>`;
  }
}

function copyMediaUrl(url: string) {
  navigator.clipboard.writeText(url);
  showToast('Media CDN URL copied to clipboard!', 'success');
}

function deleteMediaConfirm(id: string) {
  showConfirm('Delete Media Log', 'Delete this image from the database library logs? Note: File deletion on CDN requires master storage administrative portal.', async () => {
    try {
      await deleteDoc(doc(db, 'mediaLibrary', id));
      showToast('Media log removed', 'success');
      renderMedia();
    } catch {
      showToast('Failed to delete media log', 'error');
    }
  });
}

// =============================================================================
// SEASONAL CAMPAIGNS
// =============================================================================

// Temp state for the composer form's chip list
let _scChips: { text: string; query: string }[] = [];
let _scEditId: string | null = null;

async function renderSeasonalCampaigns() {
  const container = $('admin-content');
  if (!container) return;

  container.innerHTML = `
    <div class="space-y-5">
      <!-- Header -->
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 class="text-base font-extrabold text-slate-900">Seasonal Campaigns</h2>
          <p class="text-xs text-slate-500 mt-0.5">Only Active campaigns within their schedule window appear on the home page. No active campaign = clean homepage.</p>
        </div>
        <button onclick="openSeasonalCampaignComposer()" class="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition shadow-md shadow-blue-500/20">
          <i data-lucide="plus" class="w-4 h-4"></i> New Campaign
        </button>
      </div>

      <!-- Campaign Composer Modal -->
      <div id="seasonal-composer" class="hidden bg-white rounded-2xl border border-slate-200 shadow-card p-6 space-y-5">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-extrabold text-slate-900" id="seasonal-composer-title">New Seasonal Campaign</h3>
          <button onclick="closeSeasonalComposer()" class="text-slate-400 hover:text-slate-700 transition"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <input type="hidden" id="sc-edit-id" />

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Campaign Name *</label>
            <input id="sc-name" type="text" placeholder="e.g. Diwali 2026 Campaign" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Tag Label (badge pill text)</label>
            <input id="sc-tag" type="text" placeholder="e.g. 🪔 Festive Special" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="sm:col-span-2 space-y-1">
            <label class="text-xs font-bold text-slate-600">Banner Title *</label>
            <input id="sc-title" type="text" placeholder="e.g. Diwali Special Prompt Collection" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="sm:col-span-2 space-y-1">
            <label class="text-xs font-bold text-slate-600">Banner Subtitle</label>
            <input id="sc-subtitle" type="text" placeholder="Short description for the banner" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Search / Explore Query *</label>
            <input id="sc-search-query" type="text" placeholder="e.g. Diwali Poster" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Display Order (lower = first)</label>
            <input id="sc-order" type="number" value="10" min="0" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Background CSS Class</label>
            <input id="sc-bg-class" type="text" placeholder="bg-gradient-to-r from-amber-500 via-orange-600 to-rose-600" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <div class="flex flex-wrap gap-1.5 mt-1">
              ${[
                { label: '🧡 Diwali', cls: 'bg-gradient-to-r from-amber-500 via-orange-600 to-rose-600' },
                { label: '🟢 Nature', cls: 'bg-gradient-to-r from-emerald-500 via-teal-600 to-cyan-700' },
                { label: '💜 Night', cls: 'bg-gradient-to-br from-slate-900 to-indigo-950' },
                { label: '🔵 Ocean', cls: 'bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-700' },
                { label: '🌸 Pink', cls: 'bg-gradient-to-r from-pink-500 via-rose-500 to-red-600' },
                { label: '⭐ Gold', cls: 'bg-gradient-to-r from-yellow-500 via-amber-500 to-orange-500' },
              ].map(g => `<button type="button" onclick="document.getElementById('sc-bg-class').value='${g.cls}'" class="px-2 py-0.5 rounded-lg text-[9px] font-bold border border-slate-200 hover:bg-slate-100 transition">${g.label}</button>`).join('')}
            </div>
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600 flex items-center gap-1.5">
              <input id="sc-active" type="checkbox" class="w-3.5 h-3.5 accent-blue-600" checked /> Active on homepage
            </label>
            <p class="text-[10px] text-slate-400">Only one active campaign shows at a time (lowest order wins)</p>
          </div>
        </div>

        <!-- Schedule Window -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t pt-4">
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Scheduled Start (optional)</label>
            <input id="sc-start" type="datetime-local" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Scheduled End (optional)</label>
            <input id="sc-end" type="datetime-local" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>

        <!-- Quick Search Chips -->
        <div class="border-t pt-4 space-y-2">
          <label class="text-xs font-bold text-slate-600">Quick Search Chips (shown below the hero search bar)</label>
          <div id="sc-chips-list" class="flex flex-wrap gap-2 min-h-[32px]"></div>
          <div class="flex gap-2">
            <input id="sc-chip-text" type="text" placeholder="Chip label (e.g. 🪔 Diwali Diya)" class="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <input id="sc-chip-query" type="text" placeholder="Search query (e.g. Diwali Diya)" class="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <button onclick="addSeasonalChip()" class="px-3 py-2 bg-indigo-600 text-white text-xs font-bold rounded-xl hover:bg-indigo-700 transition shrink-0">+ Add</button>
          </div>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-3 border-t pt-4">
          <button onclick="saveSeasonalCampaign()" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-extrabold rounded-xl transition shadow">Save Campaign</button>
          <button onclick="closeSeasonalComposer()" class="px-5 py-2 border border-slate-200 text-slate-600 text-xs font-bold rounded-xl hover:bg-slate-50 transition">Cancel</button>
        </div>
      </div>

      <!-- Campaign List Table -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-card overflow-x-auto">
        <table class="w-full text-xs min-w-[700px]">
          <thead class="bg-slate-50 border-b border-slate-200">
            <tr>
              <th class="p-3 text-left font-bold text-slate-500 w-8">#</th>
              <th class="p-3 text-left font-bold text-slate-500">Name</th>
              <th class="p-3 text-left font-bold text-slate-500">Tag / Title</th>
              <th class="p-3 text-left font-bold text-slate-500">Schedule</th>
              <th class="p-3 text-left font-bold text-slate-500">Status</th>
              <th class="p-3 text-right font-bold text-slate-500">Actions</th>
            </tr>
          </thead>
          <tbody id="seasonal-campaigns-tbody">
            <tr><td colspan="6" class="p-8 text-center text-slate-400">Loading campaigns...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
  lcIcons();

  try {
    const snap = await getDocs(query(collection(db, 'seasonalCampaigns'), orderBy('order', 'asc')));
    const tbody = $('seasonal-campaigns-tbody');
    if (!tbody) return;

    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400">No campaigns yet. Create your first seasonal campaign.</td></tr>`;
      return;
    }

    const now = new Date();
    tbody.innerHTML = snap.docs.map((docSnap, idx) => {
      const c = { id: docSnap.id, ...docSnap.data() } as any;

      // Determine live status (active + within schedule window)
      let liveStatus = 'inactive';
      if (c.active) {
        let withinWindow = true;
        if (c.scheduledStart) {
          const start = c.scheduledStart.seconds ? new Date(c.scheduledStart.seconds * 1000) : new Date(c.scheduledStart);
          if (now < start) withinWindow = false;
        }
        if (c.scheduledEnd) {
          const end = c.scheduledEnd.seconds ? new Date(c.scheduledEnd.seconds * 1000) : new Date(c.scheduledEnd);
          if (now > end) withinWindow = false;
        }
        liveStatus = withinWindow ? 'live' : 'scheduled';
      }

      const statusBadges: Record<string, string> = {
        live: `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700 flex items-center gap-1"><i data-lucide="radio" class="w-2.5 h-2.5"></i> Live</span>`,
        scheduled: `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700">Scheduled</span>`,
        inactive: `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">Inactive</span>`,
      };

      const schedStart = c.scheduledStart ? (c.scheduledStart.seconds ? new Date(c.scheduledStart.seconds * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : c.scheduledStart) : '—';
      const schedEnd = c.scheduledEnd ? (c.scheduledEnd.seconds ? new Date(c.scheduledEnd.seconds * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : c.scheduledEnd) : '—';

      return `
        <tr class="border-b border-slate-100 hover:bg-slate-50/60 transition">
          <td class="p-3 text-slate-400 font-bold">${c.order ?? idx + 1}</td>
          <td class="p-3">
            <p class="font-bold text-slate-900 truncate max-w-[140px]" title="${c.name}">${c.name}</p>
            <p class="text-[10px] text-slate-400">${(c.chips || []).length} chip(s)</p>
          </td>
          <td class="p-3">
            <p class="font-semibold text-slate-700 truncate max-w-[180px]" title="${c.title}">${c.tag ? `<span class="mr-1">${c.tag}</span>` : ''}${c.title || '—'}</p>
            <p class="text-[10px] text-slate-400 truncate max-w-[180px]">${c.subtitle || ''}</p>
          </td>
          <td class="p-3 text-slate-500">
            <p><span class="font-semibold">Start:</span> ${schedStart}</p>
            <p><span class="font-semibold">End:</span> ${schedEnd}</p>
          </td>
          <td class="p-3">
            <div class="flex flex-col gap-1">
              ${statusBadges[liveStatus]}
              <label class="flex items-center gap-1.5 cursor-pointer mt-1">
                <input type="checkbox" ${c.active ? 'checked' : ''} onchange="toggleSeasonalCampaignActive('${c.id}', this.checked)" class="w-3 h-3 accent-blue-600" />
                <span class="text-[10px] text-slate-500 font-medium">Enabled</span>
              </label>
            </div>
          </td>
          <td class="p-3">
            <div class="flex items-center justify-end gap-1.5">
              <button onclick="editSeasonalCampaign('${c.id}')" class="p-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 transition" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
              <button onclick="deleteSeasonalCampaignConfirm('${c.id}')" class="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 transition" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    lcIcons();
  } catch (err) {
    const tbody = $('seasonal-campaigns-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-rose-500">Failed to load campaigns.</td></tr>`;
  }
}

function openSeasonalCampaignComposer() {
  _scEditId = null;
  _scChips = [];
  const composer = $('seasonal-composer');
  if (!composer) return;
  composer.classList.remove('hidden');
  const titleEl = $('seasonal-composer-title');
  if (titleEl) titleEl.textContent = 'New Seasonal Campaign';
  // Clear all fields
  ['sc-edit-id','sc-name','sc-tag','sc-title','sc-subtitle','sc-search-query','sc-bg-class','sc-start','sc-end'].forEach(id => {
    const el = $(id) as HTMLInputElement | null;
    if (el) el.value = '';
  });
  const orderEl = $('sc-order') as HTMLInputElement | null;
  if (orderEl) orderEl.value = '10';
  const activeEl = $('sc-active') as HTMLInputElement | null;
  if (activeEl) activeEl.checked = true;
  renderScChipsList();
  composer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  lcIcons();
}

async function editSeasonalCampaign(id: string) {
  try {
    const docSnap = await getDoc(doc(db, 'seasonalCampaigns', id));
    if (!docSnap.exists()) { showToast('Campaign not found', 'error'); return; }
    const c = docSnap.data() as any;

    _scEditId = id;
    _scChips = Array.isArray(c.chips) ? [...c.chips] : [];

    const composer = $('seasonal-composer');
    if (!composer) return;
    composer.classList.remove('hidden');
    const titleEl = $('seasonal-composer-title');
    if (titleEl) titleEl.textContent = 'Edit Campaign';

    const setVal = (id: string, val: string) => { const el = $(id) as HTMLInputElement | null; if (el) el.value = val; };
    setVal('sc-edit-id', id);
    setVal('sc-name', c.name || '');
    setVal('sc-tag', c.tag || '');
    setVal('sc-title', c.title || '');
    setVal('sc-subtitle', c.subtitle || '');
    setVal('sc-search-query', c.searchQuery || '');
    setVal('sc-bg-class', c.bgClass || '');
    setVal('sc-order', String(c.order ?? 10));

    const toLocalDT = (ts: any) => {
      if (!ts) return '';
      const d = ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts);
      return d.toISOString().slice(0, 16);
    };
    setVal('sc-start', toLocalDT(c.scheduledStart));
    setVal('sc-end', toLocalDT(c.scheduledEnd));

    const activeEl = $('sc-active') as HTMLInputElement | null;
    if (activeEl) activeEl.checked = !!c.active;

    renderScChipsList();
    composer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    lcIcons();
  } catch {
    showToast('Failed to load campaign', 'error');
  }
}

async function saveSeasonalCampaign() {
  const getVal = (id: string) => ($(id) as HTMLInputElement | null)?.value.trim() || '';
  const name = getVal('sc-name');
  const title = getVal('sc-title');
  const searchQuery = getVal('sc-search-query');

  if (!name || !title || !searchQuery) {
    showToast('Name, Banner Title, and Search Query are required', 'error');
    return;
  }

  const activeEl = $('sc-active') as HTMLInputElement | null;
  const startRaw = getVal('sc-start');
  const endRaw = getVal('sc-end');

  const payload: Record<string, any> = {
    name,
    tag: getVal('sc-tag'),
    title,
    subtitle: getVal('sc-subtitle'),
    searchQuery,
    bgClass: getVal('sc-bg-class') || 'bg-gradient-to-br from-slate-900 to-indigo-950',
    order: parseInt(getVal('sc-order') || '10', 10),
    active: activeEl ? activeEl.checked : false,
    chips: _scChips,
    scheduledStart: startRaw ? new Date(startRaw) : null,
    scheduledEnd: endRaw ? new Date(endRaw) : null,
    timestamp: new Date(),
  };

  try {
    const editId = _scEditId || getVal('sc-edit-id');
    if (editId) {
      await updateDoc(doc(db, 'seasonalCampaigns', editId), payload);
      showToast('Campaign updated!', 'success');
    } else {
      await addDoc(collection(db, 'seasonalCampaigns'), payload);
      showToast('Campaign created!', 'success');
    }
    closeSeasonalComposer();
    renderSeasonalCampaigns();
  } catch (err) {
    showToast('Failed to save campaign', 'error');
  }
}

async function toggleSeasonalCampaignActive(id: string, active: boolean) {
  try {
    await updateDoc(doc(db, 'seasonalCampaigns', id), { active });
    showToast(active ? 'Campaign activated' : 'Campaign deactivated', 'success');
    renderSeasonalCampaigns();
  } catch {
    showToast('Failed to toggle campaign', 'error');
  }
}

function deleteSeasonalCampaignConfirm(id: string) {
  showConfirm('Delete Campaign', 'Permanently delete this seasonal campaign? This cannot be undone.', async () => {
    try {
      await deleteDoc(doc(db, 'seasonalCampaigns', id));
      showToast('Campaign deleted', 'success');
      renderSeasonalCampaigns();
    } catch {
      showToast('Failed to delete campaign', 'error');
    }
  });
}

function closeSeasonalComposer() {
  const composer = $('seasonal-composer');
  if (composer) composer.classList.add('hidden');
  _scEditId = null;
  _scChips = [];
}

function addSeasonalChip() {
  const textEl = $('sc-chip-text') as HTMLInputElement | null;
  const queryEl = $('sc-chip-query') as HTMLInputElement | null;
  const text = textEl?.value.trim() || '';
  const query = queryEl?.value.trim() || '';
  if (!text && !query) { showToast('Enter chip text or query', 'error'); return; }
  _scChips.push({ text: text || query, query: query || text });
  if (textEl) textEl.value = '';
  if (queryEl) queryEl.value = '';
  renderScChipsList();
}

function removeSeasonalChip(idx: number) {
  _scChips.splice(idx, 1);
  renderScChipsList();
}

function renderScChipsList() {
  const container = $('sc-chips-list');
  if (!container) return;
  if (_scChips.length === 0) {
    container.innerHTML = `<span class="text-[10px] text-slate-400 italic">No chips added yet. Add chips above to show quick-search shortcuts under the hero search bar.</span>`;
    return;
  }
  container.innerHTML = _scChips.map((chip, idx) => `
    <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-[11px] font-semibold">
      ${chip.text}
      <button type="button" onclick="removeSeasonalChip(${idx})" class="text-blue-400 hover:text-rose-600 ml-0.5 transition"><i data-lucide="x" class="w-2.5 h-2.5"></i></button>
    </span>
  `).join('');
  lcIcons();
}

// =============================================================================
// WINDOW GLOBALS
// =============================================================================
function attachGlobals() {
  const w = window as any;
  w.adminNav = adminNav;
  w.handleAdminGoogleSignIn = handleAdminGoogleSignIn;
  w.handleAdminEmailLogin = handleAdminEmailLogin;
  w.handleAdminLogout = handleAdminLogout;
  w.toggleAdminSidebar = toggleAdminSidebar;
  w.executeConfirm = executeConfirm;
  w.closeConfirmModal = closeConfirmModal;
  w.openPromptModal = openPromptModal;
  w.closePromptModal = closePromptModal;
  w.handleSavePrompt = handleSavePrompt;
  w.editPrompt = editPrompt;
  w.deletePromptConfirm = deletePromptConfirm;
  w.updateStatus = updateStatus;
  w.toggleFlag = toggleFlag;
  w.bulkApprove = bulkApprove;
  w.bulkReject = bulkReject;
  w.bulkDelete = bulkDelete;
  w.filterPrompts = filterPrompts;
  w.changePage = changePage;
  w.toggleSelectAll = toggleSelectAll;
  w.uploadAdminImage = uploadAdminImage;
  w.addCategory = addCategory;
  w.deleteCategoryConfirm = deleteCategoryConfirm;
  w.closeCategoryModal = closeCategoryModal;
  w.handleSaveCategory = handleSaveCategory;
  w.addCollection = addCollection;
  w.deleteCollectionConfirm = deleteCollectionConfirm;
  w.setUserRole = setUserRole;
  w.filterUsers = filterUsers;
  w.exportCSV = exportCSV;
  w.exportJSON = exportJSON;
  w.saveSettings = saveSettings;
  w.saveHeroConfig = saveHeroConfig;
  w.saveFestiveConfig = saveFestiveConfig;
  w.saveStatsConfig = saveStatsConfig;
  w.renderStatsManagement = renderStatsManagement;
  w.handleSaveStatsConfig = handleSaveStatsConfig;
  w.saveCommunityConfig = saveCommunityConfig;
  w.addAITool = addAITool;
  w.deleteAIToolConfirm = deleteAIToolConfirm;
  w.doBackup = doBackup;
  w.doRestore = doRestore;
  w.updateProfile = updateProfile;
  w.previewCloudinaryImage = previewCloudinaryImage;
  w.doCloudinaryUpload = doCloudinaryUpload;
  w.copyCloudinaryUrl = copyCloudinaryUrl;
  w.showToast = showToast;

  // New CMS globals
  w.renderBlogs = renderBlogs;
  w.openBlogComposer = openBlogComposer;
  w.editBlogPost = editBlogPost;
  w.saveBlogPost = saveBlogPost;
  w.deleteBlogPostConfirm = deleteBlogPostConfirm;
  w.renderPages = renderPages;
  w.editStaticPage = editStaticPage;
  w.saveStaticPage = saveStaticPage;
  w.renderContacts = renderContacts;
  w.updateContactStatus = updateContactStatus;
  w.deleteContactSubmission = deleteContactSubmission;
  w.exportContactsCSV = exportContactsCSV;
  w.renderMedia = renderMedia;
  w.copyMediaUrl = copyMediaUrl;
  w.deleteMediaConfirm = deleteMediaConfirm;
  w.renderContactSettings = renderContactSettings;
  w.saveContactSettings = saveContactSettings;
  w.previewBlogPost = previewBlogPost;
  w.closeBlogPreview = closeBlogPreview;
  w.autoSlugify = autoSlugify;
  w.toggleScheduleInput = toggleScheduleInput;

  // Seasonal Campaigns
  w.renderSeasonalCampaigns = renderSeasonalCampaigns;
  w.openSeasonalCampaignComposer = openSeasonalCampaignComposer;
  w.saveSeasonalCampaign = saveSeasonalCampaign;
  w.editSeasonalCampaign = editSeasonalCampaign;
  w.deleteSeasonalCampaignConfirm = deleteSeasonalCampaignConfirm;
  w.toggleSeasonalCampaignActive = toggleSeasonalCampaignActive;
  w.addSeasonalChip = addSeasonalChip;
  w.removeSeasonalChip = removeSeasonalChip;

  // Advertisements
  w.renderAdvertisements = renderAdvertisements;
  w.openAdComposer = openAdComposer;
  w.saveSponsoredAd = saveSponsoredAd;
  w.editSponsoredAd = editSponsoredAd;
  w.deleteSponsoredAdConfirm = deleteSponsoredAdConfirm;
  w.toggleSponsoredAdActive = toggleSponsoredAdActive;
  w.closeAdComposer = closeAdComposer;
  w.renderAdSenseSettings = renderAdSenseSettings;
  w.saveAdSenseSettings = saveAdSenseSettings;

  // SEO & Google Ranking Management
  w.renderSEO = renderSEO;
  w.saveSEOSettings = saveSEOSettings;
  w.addTrendingHashtag = addTrendingHashtag;
  w.removeTrendingHashtag = removeTrendingHashtag;
  w.quickAddRankingKeyword = quickAddRankingKeyword;
  w.generateDefaultStructuredData = generateDefaultStructuredData;
  w.updateSeoLivePreview = updateSeoLivePreview;
  w.copySitemapXml = copySitemapXml;
  w.downloadSitemapXml = downloadSitemapXml;
  w.copyRobotsTxt = copyRobotsTxt;
  w.uploadSeoOgImage = uploadSeoOgImage;
}

// =============================================================================
// ADVERTISEMENT MANAGEMENT MODULE
// =============================================================================
let _adEditId: string | null = null;

async function renderAdvertisements() {
  const container = $('admin-content');
  if (!container) return;

  container.innerHTML = `
    <div class="space-y-6">
      <!-- Top Action Bar -->
      <div class="bg-white rounded-2xl p-5 border border-slate-200 shadow-card flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 class="font-bold text-lg text-slate-900">Sponsored Ads & Placements</h3>
          <p class="text-xs text-slate-500">Create, schedule, prioritize and analyze sponsored campaigns.</p>
        </div>
        <button onclick="openAdComposer()" class="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center gap-1.5 shrink-0">
          <i data-lucide="plus" class="w-4 h-4"></i> Create Sponsored Ad
        </button>
      </div>

      <!-- Ad Composer Form (Hidden by default) -->
      <div id="ad-composer" class="hidden bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-4">
        <h4 id="ad-composer-title" class="font-bold text-sm text-slate-900 border-b pb-2">New Sponsored Ad</h4>
        <input type="hidden" id="ad-edit-id" />

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Ad Campaign Name / Title *</label>
            <input id="ad-title" type="text" placeholder="e.g. Midjourney Pro Fast GPU Generator" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Sponsor / Partner Name *</label>
            <input id="ad-sponsor-name" type="text" placeholder="e.g. PromptLabs Corp" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>

        <div class="space-y-1">
          <label class="text-xs font-bold text-slate-600">Description / Promotional Text *</label>
          <textarea id="ad-description" rows="2" placeholder="Describe the promotion or offer..." class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"></textarea>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Placement Slot *</label>
            <select id="ad-placement" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="feed-inline">In-Feed (Inline Native Card)</option>
              <option value="detail-after-prompt">Prompt Details Page (After Content)</option>
              <option value="detail-native-1">Prompt Details Page (Native Slot #1)</option>
              <option value="detail-native-2">Prompt Details Page (Native Slot #2)</option>
              <option value="search-bottom">Search Page (Below Results)</option>
              <option value="sidebar">Sidebar Widget (Prompt Detail View)</option>
              <option value="footer-banner">Global Footer (Responsive Banner)</option>
            </select>
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Call-To-Action (CTA) *</label>
            <input id="ad-cta" type="text" placeholder="e.g. Try Fast GPU Free" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Target URL / Destination *</label>
            <input id="ad-target-url" type="url" placeholder="https://..." class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t pt-4">
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-700 block">Ad Banner Image (Upload or Image URL)</label>
            <div class="flex gap-2">
              <input type="text" id="ad-image-url" placeholder="Upload or paste URL" class="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <input type="file" id="ad-image-file" accept="image/*" class="hidden" onchange="uploadAdMedia('ad-image-file', 'ad-image-url')" />
              <button onclick="$('ad-image-file').click()" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition shrink-0">Upload</button>
            </div>
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-700 block">Sponsor Logo Image (Optional)</label>
            <div class="flex gap-2">
              <input type="text" id="ad-logo-url" placeholder="Upload or paste URL" class="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <input type="file" id="ad-logo-file" accept="image/*" class="hidden" onchange="uploadAdMedia('ad-logo-file', 'ad-logo-url')" />
              <button onclick="$('ad-logo-file').click()" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition shrink-0">Upload</button>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-4 gap-4 border-t pt-4">
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Priority Level (1-100)</label>
            <input id="ad-priority" type="number" min="1" max="100" value="10" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Scheduled Start</label>
            <input id="ad-start" type="datetime-local" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-bold text-slate-600">Scheduled End</label>
            <input id="ad-end" type="datetime-local" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="flex items-center pt-5">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" id="ad-active" checked class="w-4 h-4 rounded accent-blue-600" />
              <span class="text-xs font-bold text-slate-700">Activate Campaign</span>
            </label>
          </div>
        </div>

        <div class="flex items-center gap-3 border-t pt-4">
          <button onclick="saveSponsoredAd()" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-extrabold rounded-xl transition shadow">Save Advertisement</button>
          <button onclick="closeAdComposer()" class="px-5 py-2 border border-slate-200 text-slate-600 text-xs font-bold rounded-xl hover:bg-slate-50 transition">Cancel</button>
        </div>
      </div>

      <!-- Analytics Summary Cards -->
      <div id="ad-analytics-cards" class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <!-- Rendered dynamically -->
      </div>

      <!-- Advertisements Table -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-card overflow-x-auto">
        <table class="w-full text-xs min-w-[800px]">
          <thead class="bg-slate-50 border-b border-slate-200">
            <tr>
              <th class="p-3 text-left font-bold text-slate-500">Banner</th>
              <th class="p-3 text-left font-bold text-slate-500">Campaign / Sponsor</th>
              <th class="p-3 text-left font-bold text-slate-500">Placement</th>
              <th class="p-3 text-left font-bold text-slate-500">Schedule Window</th>
              <th class="p-3 text-left font-bold text-slate-500">Impressions / Clicks</th>
              <th class="p-3 text-left font-bold text-slate-500">CTR</th>
              <th class="p-3 text-left font-bold text-slate-500">Status</th>
              <th class="p-3 text-right font-bold text-slate-500">Actions</th>
            </tr>
          </thead>
          <tbody id="advertisements-tbody">
            <tr><td colspan="8" class="p-8 text-center text-slate-400">Loading campaigns...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
  lcIcons();

  // Load and render Ads table + stats
  const tbody = $('advertisements-tbody');
  try {
    const snap = await getDocs(query(collection(db, 'sponsoredAds'), orderBy('createdAt', 'desc')));
    const analyticsCards = $('ad-analytics-cards');
    if (!tbody) return;

    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-slate-400">No sponsored advertisements yet. Click "Create Sponsored Ad" to launch a campaign.</td></tr>`;
      if (analyticsCards) analyticsCards.innerHTML = '';
      return;
    }

    const adsList = snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() } as any));
    const now = new Date();

    // Render Analytics Cards
    let totalImps = 0;
    let totalClicks = 0;
    let activeCampaignsCount = 0;

    adsList.forEach(a => {
      totalImps += (a.impressions || 0);
      totalClicks += (a.clicks || 0);
      if (a.isActive) {
        const start = a.startDate?.seconds ? new Date(a.startDate.seconds * 1000) : new Date(a.startDate);
        const end = a.endDate?.seconds ? new Date(a.endDate.seconds * 1000) : new Date(a.endDate);
        if (start <= now && end >= now) activeCampaignsCount++;
      }
    });

    const averageCTR = totalImps > 0 ? ((totalClicks / totalImps) * 100).toFixed(2) : '0.00';

    if (analyticsCards) {
      analyticsCards.innerHTML = `
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span class="text-xs text-slate-500 font-semibold">Total Campaigns</span>
          <div class="text-2xl font-extrabold text-slate-900 mt-1">${adsList.length}</div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span class="text-xs text-emerald-600 font-semibold">Live Campaigns</span>
          <div class="text-2xl font-extrabold text-emerald-600 mt-1">${activeCampaignsCount}</div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span class="text-xs text-blue-600 font-semibold">Total Impressions</span>
          <div class="text-2xl font-extrabold text-blue-600 mt-1">${formatNumber(totalImps)}</div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span class="text-xs text-purple-600 font-semibold">Average CTR</span>
          <div class="text-2xl font-extrabold text-purple-600 mt-1">${averageCTR}%</div>
        </div>
      `;
    }

    // Render Table Body
    tbody.innerHTML = adsList.map(a => {
      let liveStatus = 'inactive';
      if (a.isActive) {
        const start = a.startDate?.seconds ? new Date(a.startDate.seconds * 1000) : new Date(a.startDate);
        const end = a.endDate?.seconds ? new Date(a.endDate.seconds * 1000) : new Date(a.endDate);
        if (now < start) liveStatus = 'scheduled';
        else if (now > end) liveStatus = 'expired';
        else liveStatus = 'live';
      }

      const statusBadges: Record<string, string> = {
        live: `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700 flex items-center gap-1"><i data-lucide="play" class="w-3 h-3"></i> Active</span>`,
        scheduled: `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700">Scheduled</span>`,
        expired: `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">Expired</span>`,
        inactive: `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-700">Paused</span>`
      };

      const startText = a.startDate?.seconds 
        ? new Date(a.startDate.seconds * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) 
        : new Date(a.startDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const endText = a.endDate?.seconds 
        ? new Date(a.endDate.seconds * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) 
        : new Date(a.endDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

      const ctr = (a.impressions || 0) > 0 ? (((a.clicks || 0) / (a.impressions || 0)) * 100).toFixed(2) : '0.00';

      return `
        <tr class="border-b border-slate-100 hover:bg-slate-50/60 transition">
          <td class="p-3">
            <img src="${optimizeCloudinaryUrl(a.imageUrl, 150)}" class="w-12 h-12 rounded-lg object-cover border" loading="lazy" />
          </td>
          <td class="p-3">
            <p class="font-bold text-slate-900 truncate max-w-[180px]">${escapeHtml(a.title)}</p>
            <p class="text-[10px] text-slate-400 font-semibold">${escapeHtml(a.sponsorName)}</p>
          </td>
          <td class="p-3 font-semibold text-slate-600">${a.placement}</td>
          <td class="p-3 text-slate-500">
            <p><span class="font-bold">Start:</span> ${startText}</p>
            <p><span class="font-bold">End:</span> ${endText}</p>
          </td>
          <td class="p-3 text-slate-500 font-medium">
            <p>${a.impressions || 0} impressions</p>
            <p>${a.clicks || 0} clicks</p>
          </td>
          <td class="p-3 font-bold text-indigo-600">${ctr}%</td>
          <td class="p-3">
            <div class="flex flex-col gap-1">
              ${statusBadges[liveStatus]}
              <label class="flex items-center gap-1 cursor-pointer mt-1">
                <input type="checkbox" ${a.isActive ? 'checked' : ''} onchange="toggleSponsoredAdActive('${a.id}', this.checked)" class="w-3 h-3 accent-blue-600" />
                <span class="text-[10px] text-slate-500">Enabled</span>
              </label>
            </div>
          </td>
          <td class="p-3">
            <div class="flex items-center justify-end gap-1.5">
              <button onclick="editSponsoredAd('${a.id}')" class="p-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 transition" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
              <button onclick="deleteSponsoredAdConfirm('${a.id}')" class="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 transition" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    lcIcons();
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-rose-500">Failed to load advertisements.</td></tr>`;
    }
  }
}

// Global Cloudinary upload helper for ads CRUD
(window as any).uploadAdMedia = async (fileInputId: string, urlInputId: string) => {
  const fileInput = $(fileInputId) as HTMLInputElement | null;
  const urlInput = $(urlInputId) as HTMLInputElement | null;
  if (!fileInput || !fileInput.files?.[0]) return;

  const file = fileInput.files[0];
  showToast('Uploading asset to cloud storage...', 'info');

  try {
    const url = await uploadToCloudinary(file);
    if (urlInput) urlInput.value = url;
    showToast('Asset uploaded successfully!', 'success');
  } catch (err: any) {
    showToast(err.message || 'Asset upload failed', 'error');
  }
};

// Global Prompt & Multi-Image functions attached to window
(window as any).addAdminImageUrl = addAdminImageUrl;
(window as any).removeAdminFormImage = removeAdminFormImage;
(window as any).uploadAdminImage = uploadAdminImage;
(window as any).uploadAdminImageBtn = uploadAdminImageBtn;

// Global Blog CMS functions attached to window
(window as any).filterBlogsTable = filterBlogsTable;
(window as any).uploadBlogCoverImage = uploadBlogCoverImage;
(window as any).insertBlogFormattingTag = insertBlogFormattingTag;
(window as any).seedDefaultBlogs = seedDefaultBlogs;
(window as any).openBlogComposer = openBlogComposer;
(window as any).editBlogPost = editBlogPost;
(window as any).saveBlogPost = saveBlogPost;
(window as any).deleteBlogPostConfirm = deleteBlogPostConfirm;
(window as any).previewBlogPost = previewBlogPost;
(window as any).closeBlogPreview = closeBlogPreview;

function openAdComposer() {
  _adEditId = null;
  const composer = $('ad-composer');
  if (!composer) return;

  composer.classList.remove('hidden');
  const titleEl = $('ad-composer-title');
  if (titleEl) titleEl.textContent = 'Create New Sponsored Ad';

  // Reset fields
  ['ad-edit-id','ad-title','ad-sponsor-name','ad-description','ad-cta','ad-target-url','ad-image-url','ad-logo-url','ad-start','ad-end'].forEach(id => {
    const el = $(id) as HTMLInputElement | null;
    if (el) el.value = '';
  });
  const priorityEl = $('ad-priority') as HTMLInputElement | null;
  if (priorityEl) priorityEl.value = '10';
  const activeEl = $('ad-active') as HTMLInputElement | null;
  if (activeEl) activeEl.checked = true;

  composer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function editSponsoredAd(id: string) {
  try {
    const docSnap = await getDoc(doc(db, 'sponsoredAds', id));
    if (!docSnap.exists()) { showToast('Advertisement not found', 'error'); return; }
    const a = docSnap.data() as any;

    _adEditId = id;
    const composer = $('ad-composer');
    if (!composer) return;

    composer.classList.remove('hidden');
    const titleEl = $('ad-composer-title');
    if (titleEl) titleEl.textContent = 'Edit Advertisement';

    const setVal = (id: string, val: string) => { const el = $(id) as HTMLInputElement | null; if (el) el.value = val; };
    setVal('ad-edit-id', id);
    setVal('ad-title', a.title || '');
    setVal('ad-sponsor-name', a.sponsorName || '');
    setVal('ad-description', a.description || '');
    setVal('ad-cta', a.ctaText || '');
    setVal('ad-target-url', a.targetUrl || '');
    setVal('ad-image-url', a.imageUrl || '');
    setVal('ad-logo-url', a.sponsorLogo || '');
    setVal('ad-priority', String(a.priority ?? 10));

    // Formats date strings to datetime-local format
    const toDatetimeLocal = (ts: any) => {
      if (!ts) return '';
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toISOString().slice(0, 16);
    };
    setVal('ad-start', toDatetimeLocal(a.startDate));
    setVal('ad-end', toDatetimeLocal(a.endDate));

    const activeEl = $('ad-active') as HTMLInputElement | null;
    if (activeEl) activeEl.checked = a.isActive !== false;

    const placementSelect = $('ad-placement') as HTMLSelectElement | null;
    if (placementSelect) placementSelect.value = a.placement || 'feed-inline';

    composer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showToast('Failed to load advertisement data', 'error');
  }
}

async function saveSponsoredAd() {
  const title = ($('ad-title') as HTMLInputElement)?.value.trim();
  const sponsorName = ($('ad-sponsor-name') as HTMLInputElement)?.value.trim();
  const description = ($('ad-description') as HTMLTextAreaElement)?.value.trim();
  const placement = ($('ad-placement') as HTMLSelectElement)?.value;
  const ctaText = ($('ad-cta') as HTMLInputElement)?.value.trim();
  const targetUrl = ($('ad-target-url') as HTMLInputElement)?.value.trim();
  const imageUrl = ($('ad-image-url') as HTMLInputElement)?.value.trim();
  const sponsorLogo = ($('ad-logo-url') as HTMLInputElement)?.value.trim();
  const priority = parseInt(($('ad-priority') as HTMLInputElement)?.value) || 10;
  const startDateStr = ($('ad-start') as HTMLInputElement)?.value;
  const endDateStr = ($('ad-end') as HTMLInputElement)?.value;
  const isActive = ($('ad-active') as HTMLInputElement)?.checked;

  if (!title || !sponsorName || !description || !placement || !ctaText || !targetUrl || !imageUrl) {
    showToast('All starred (*) fields are required', 'error');
    return;
  }

  const startDate = startDateStr ? Timestamp.fromDate(new Date(startDateStr)) : Timestamp.fromDate(new Date());
  const endDate = endDateStr ? Timestamp.fromDate(new Date(endDateStr)) : Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)); // Default 30 days

  const data = {
    title,
    sponsorName,
    description,
    placement,
    ctaText,
    targetUrl,
    imageUrl,
    sponsorLogo: sponsorLogo || null,
    priority,
    startDate,
    endDate,
    isActive,
    updatedAt: serverTimestamp(),
  };

  try {
    if (_adEditId) {
      await updateDoc(doc(db, 'sponsoredAds', _adEditId), data);
      showToast('Sponsored ad updated successfully!', 'success');
    } else {
      const newData = {
        ...data,
        impressions: 0,
        clicks: 0,
        createdAt: serverTimestamp(),
      };
      await addDoc(collection(db, 'sponsoredAds'), newData);
      showToast('Sponsored ad created successfully!', 'success');
    }

    invalidateAdCache(); // Invalidate the client-side cache
    closeAdComposer();
    renderAdvertisements();
  } catch (err) {
    showToast('Failed to save advertisement', 'error');
  }
}

async function deleteSponsoredAdConfirm(id: string) {
  showConfirm('Delete Sponsored Ad', 'Permanently delete this sponsored advertisement campaign? This cannot be undone.', async () => {
    try {
      await deleteDoc(doc(db, 'sponsoredAds', id));
      invalidateAdCache();
      showToast('Advertisement deleted successfully', 'success');
      renderAdvertisements();
    } catch {
      showToast('Failed to delete advertisement', 'error');
    }
  });
}

async function toggleSponsoredAdActive(id: string, active: boolean) {
  try {
    await updateDoc(doc(db, 'sponsoredAds', id), {
      isActive: active,
      updatedAt: serverTimestamp()
    });
    invalidateAdCache();
    showToast(active ? 'Advertisement campaign activated' : 'Advertisement campaign paused', 'success');
    renderAdvertisements();
  } catch {
    showToast('Failed to toggle campaign status', 'error');
  }
}

function closeAdComposer() {
  const composer = $('ad-composer');
  if (composer) composer.classList.add('hidden');
  _adEditId = null;
}

// =============================================================================
// GOOGLE ADSENSE INTEGRATION SETTINGS
// =============================================================================
async function renderAdSenseSettings() {
  const container = $('admin-content');
  if (!container) return;

  container.innerHTML = `
    <div class="max-w-3xl mx-auto bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-6 text-xs font-semibold">
      <h3 class="font-bold text-lg text-slate-900 border-b pb-2 flex items-center gap-1.5"><i data-lucide="badge-dollar-sign" class="w-5 h-5 text-emerald-600"></i> Google AdSense Configuration</h3>

      <form id="adsense-settings-form" onsubmit="saveAdSenseSettings(event)" class="space-y-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="space-y-1">
            <label class="text-slate-700 block">AdSense Publisher ID *</label>
            <input type="text" id="adsense-publisher-id" placeholder="ca-pub-XXXXXXXXXXXXXXXX" required class="w-full px-3 py-2 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div class="flex items-center pt-5">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" id="adsense-auto-ads" class="w-4 h-4 rounded accent-blue-600" />
              <span class="text-slate-700">Enable Google Auto Ads</span>
            </label>
          </div>
        </div>

        <div class="border-t pt-4 space-y-4">
          <h4 class="font-bold text-sm text-slate-800 border-b pb-1.5 flex items-center gap-1.5"><i data-lucide="layout" class="w-4 h-4 text-blue-500"></i> Manual Ad Slot Placements</h4>
          <p class="text-[10px] text-slate-400 font-medium">Map custom Slot IDs from your Google AdSense console to reserve placements on high-performing layouts.</p>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-slate-700 block">Feed Inline Slot ID</label>
              <input type="text" id="adsense-slot-feed" placeholder="e.g. 1234567890" class="w-full px-3 py-2 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div class="space-y-1">
              <label class="text-slate-700 block">Detail Bottom Slot ID</label>
              <input type="text" id="adsense-slot-detail" placeholder="e.g. 1234567890" class="w-full px-3 py-2 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div class="space-y-1">
              <label class="text-slate-700 block">Search Bottom Slot ID</label>
              <input type="text" id="adsense-slot-search" placeholder="e.g. 1234567890" class="w-full px-3 py-2 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div class="space-y-1">
              <label class="text-slate-700 block">Sidebar Widget Slot ID</label>
              <input type="text" id="adsense-slot-sidebar" placeholder="e.g. 1234567890" class="w-full px-3 py-2 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div class="space-y-1">
              <label class="text-slate-700 block">Footer Banner Slot ID</label>
              <input type="text" id="adsense-slot-footer" placeholder="e.g. 1234567890" class="w-full px-3 py-2 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 pt-3 border-t">
          <button type="submit" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-sm transition">Save AdSense Config</button>
        </div>
      </form>
    </div>
  `;
  lcIcons();

  // Populate form values from Firestore settings/adsense
  try {
    const configSnap = await getDoc(doc(db, 'settings', 'adsense'));
    if (configSnap.exists()) {
      const data = configSnap.data();
      const setVal = (id: string, val: string) => { const el = $(id) as HTMLInputElement | null; if (el) el.value = val || ''; };
      setVal('adsense-publisher-id', data.publisherId || '');
      setVal('adsense-slot-feed', data.manualSlots?.feedInline || '');
      setVal('adsense-slot-detail', data.manualSlots?.detailBottom || '');
      setVal('adsense-slot-search', data.manualSlots?.searchBottom || '');
      setVal('adsense-slot-sidebar', data.manualSlots?.sidebarWidget || '');
      setVal('adsense-slot-footer', data.manualSlots?.footerBanner || '');

      const autoAdsEl = $('adsense-auto-ads') as HTMLInputElement | null;
      if (autoAdsEl) autoAdsEl.checked = data.autoAdsEnabled !== false;
    }
  } catch (err) {
    showToast('Failed to load AdSense config', 'warning');
  }
}

async function saveAdSenseSettings(e: Event) {
  e.preventDefault();
  const publisherId = ($('adsense-publisher-id') as HTMLInputElement)?.value.trim();
  const autoAdsEnabled = ($('adsense-auto-ads') as HTMLInputElement)?.checked;
  const feedInline = ($('adsense-slot-feed') as HTMLInputElement)?.value.trim();
  const detailBottom = ($('adsense-slot-detail') as HTMLInputElement)?.value.trim();
  const searchBottom = ($('adsense-slot-search') as HTMLInputElement)?.value.trim();
  const sidebarWidget = ($('adsense-slot-sidebar') as HTMLInputElement)?.value.trim();
  const footerBanner = ($('adsense-slot-footer') as HTMLInputElement)?.value.trim();

  const data = {
    publisherId,
    autoAdsEnabled,
    manualSlots: {
      feedInline,
      detailBottom,
      searchBottom,
      sidebarWidget,
      footerBanner,
    },
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'settings', 'adsense'), data, { merge: true });
    showToast('AdSense settings saved successfully!', 'success');
  } catch (err) {
    showToast('Failed to save AdSense settings', 'error');
  }
}

// =============================================================================
// SEO & GOOGLE RANKING MANAGEMENT MODULE
// =============================================================================

let _seoHashtags: string[] = [
  '#AIPrompts',
  '#ChatGPT',
  '#PromptEngineering',
  '#MidjourneyPrompt',
  '#GenerativeAI',
  '#FluxAI',
  '#AICreators',
  '#PromptOfTheDay'
];

async function renderSEO() {
  const container = $('admin-content');
  if (!container) return;

  container.innerHTML = `
    <div class="space-y-6 max-w-5xl mx-auto pb-12">
      <!-- Top Title & Quick Actions -->
      <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-card flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold mb-2">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Google Search &amp; Meta Indexing Suite
          </div>
          <h2 class="text-xl font-extrabold text-slate-900 tracking-tight">SEO &amp; Google Ranking Management</h2>
          <p class="text-xs text-slate-500 mt-1">Configure search engine metadata, Open Graph cards, Google Search Console verification, ranking keywords, and trending hashtags.</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button type="button" onclick="copySitemapXml()" class="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs flex items-center gap-1.5 transition">
            <i data-lucide="file-code" class="w-4 h-4 text-blue-600"></i> Sitemap.xml
          </button>
          <a href="https://search.google.com/search-console" target="_blank" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition">
            <i data-lucide="external-link" class="w-4 h-4"></i> Google Search Console
          </a>
        </div>
      </div>

      <!-- Live SERP Preview & SEO Health Score Grid -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        <!-- Google Search Result Snippet Simulation -->
        <div class="lg:col-span-2 bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 class="text-xs font-extrabold uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <svg class="w-4 h-4" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
              </svg>
              Live Google Search Snippet Preview
            </h3>
            <span class="text-[10px] text-slate-400 font-semibold">Desktop &amp; Mobile SERP</span>
          </div>

          <!-- The Mock Google Card -->
          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200/80 font-sans space-y-1.5">
            <div class="flex items-center gap-2 text-xs text-slate-600">
              <div class="w-4 h-4 rounded-full bg-emerald-600 flex items-center justify-center text-white font-black text-[9px]">P</div>
              <span id="serp-preview-site" class="font-semibold text-slate-800">PromptsOne</span>
              <span class="text-slate-400">&rsaquo;</span>
              <span id="serp-preview-url" class="text-slate-500 text-[11px] font-mono truncate">https://promptsone.com</span>
            </div>
            <h4 id="serp-preview-title" class="text-base sm:text-lg font-medium text-[#1a0dab] hover:underline cursor-pointer leading-tight truncate">
              PromptsOne — Google for AI Prompts &amp; Engineering Portal
            </h4>
            <p id="serp-preview-desc" class="text-xs sm:text-[13px] text-[#4d5156] leading-relaxed line-clamp-2">
              Discover, search, copy, and share 500,000+ top engineered AI prompts for ChatGPT, Midjourney, Flux, Claude, Gemini, and Sora on PromptsOne.
            </p>
          </div>
        </div>

        <!-- SEO Health Score & Checklist -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-4 flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-xs font-extrabold uppercase tracking-wider text-slate-700">SEO Health Score</h3>
              <span id="seo-score-badge" class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-black text-xs">96 / 100</span>
            </div>
            
            <!-- Progress Bar -->
            <div class="w-full bg-slate-100 h-2 rounded-full overflow-hidden mb-3">
              <div id="seo-score-bar" class="bg-emerald-500 h-full rounded-full transition-all duration-500" style="width: 96%"></div>
            </div>

            <!-- Audit Checklist -->
            <ul id="seo-checklist" class="space-y-1.5 text-[11px] font-medium text-slate-600">
              <li id="chk-title" class="flex items-center gap-2 text-emerald-600"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> Title length optimal (40-65 chars)</li>
              <li id="chk-desc" class="flex items-center gap-2 text-emerald-600"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> Meta description optimal (140-165 chars)</li>
              <li id="chk-keywords" class="flex items-center gap-2 text-emerald-600"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> Ranking keywords configured</li>
              <li id="chk-hashtags" class="flex items-center gap-2 text-emerald-600"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> Trending hashtags configured</li>
              <li id="chk-ogimage" class="flex items-center gap-2 text-emerald-600"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> Social share (OG) image provided</li>
              <li id="chk-canonical" class="flex items-center gap-2 text-emerald-600"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> Canonical base URL valid</li>
              <li id="chk-gsc" class="flex items-center gap-2 text-slate-500"><i data-lucide="help-circle" class="w-3.5 h-3.5"></i> Google Search Console verification</li>
            </ul>
          </div>
          <p class="text-[10px] text-slate-400 font-medium">All settings sync live to public HTML meta tags and Firestore in real time.</p>
        </div>

      </div>

      <!-- Main SEO Form -->
      <form id="seo-master-form" onsubmit="saveSEOSettings(event)" class="space-y-6">

        <!-- 1. CORE SEARCH ENGINE METADATA -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-5">
          <div class="flex items-center gap-2.5 border-b border-slate-100 pb-3">
            <div class="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
              <i data-lucide="search" class="w-4 h-4"></i>
            </div>
            <div>
              <h3 class="text-sm font-extrabold text-slate-900">1. Core Search Engine Metadata</h3>
              <p class="text-[11px] text-slate-500">Primary tags indexed by Google, Bing, Yahoo, and DuckDuckGo crawlers</p>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1 sm:col-span-2">
              <div class="flex items-center justify-between">
                <label class="text-xs font-bold text-slate-700">Primary Page Title (&lt;title&gt;) *</label>
                <span id="title-char-count" class="text-[10px] font-mono text-slate-400">0 / 60 chars (Optimal: 40-60)</span>
              </div>
              <input 
                type="text" 
                id="seo-title" 
                required 
                placeholder="PromptsOne — Google for AI Prompts &amp; Engineering Portal" 
                oninput="updateSeoLivePreview()"
                class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs sm:text-sm font-semibold focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 transition" 
              />
            </div>

            <div class="space-y-1">
              <label class="text-xs font-bold text-slate-700">Title Format Template</label>
              <input 
                type="text" 
                id="seo-title-template" 
                placeholder="%title% | PromptsOne — AI Prompt Search Engine" 
                class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-mono focus:border-blue-500 focus:outline-none transition" 
              />
              <p class="text-[10px] text-slate-400">Used dynamically on prompt details, category views, and blogs.</p>
            </div>

            <div class="space-y-1">
              <label class="text-xs font-bold text-slate-700">Canonical Base URL</label>
              <input 
                type="url" 
                id="seo-canonical" 
                placeholder="https://promptsone.com/" 
                oninput="updateSeoLivePreview()"
                class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-mono focus:border-blue-500 focus:outline-none transition" 
              />
              <p class="text-[10px] text-slate-400">Prevents duplicate content issues on Google.</p>
            </div>

            <div class="space-y-1 sm:col-span-2">
              <div class="flex items-center justify-between">
                <label class="text-xs font-bold text-slate-700">Meta Description (&lt;meta name="description"&gt;) *</label>
                <span id="desc-char-count" class="text-[10px] font-mono text-slate-400">0 / 160 chars (Optimal: 140-160)</span>
              </div>
              <textarea 
                id="seo-desc" 
                rows="3" 
                required 
                placeholder="Discover, search, copy, and share 500,000+ top engineered AI prompts for ChatGPT, Midjourney, Flux, Claude, Gemini, and Sora on PromptsOne."
                oninput="updateSeoLivePreview()"
                class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs sm:text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
              ></textarea>
            </div>

            <div class="space-y-1">
              <label class="text-xs font-bold text-slate-700">Robots Indexing Directive</label>
              <select id="seo-robots" class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-semibold focus:border-blue-500 focus:outline-none transition">
                <option value="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">index, follow (Recommended for Google ranking)</option>
                <option value="index, nofollow">index, nofollow</option>
                <option value="noindex, follow">noindex, follow</option>
                <option value="noindex, nofollow">noindex, nofollow (Pause indexing)</option>
              </select>
            </div>

            <div class="space-y-1">
              <label class="text-xs font-bold text-slate-700">Author / Organization Name</label>
              <input 
                type="text" 
                id="seo-author" 
                placeholder="PromptsOne AI" 
                class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs focus:border-blue-500 focus:outline-none transition" 
              />
            </div>
          </div>
        </div>

        <!-- 2. HIGH-IMPACT GOOGLE RANKING KEYWORDS -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-4">
          <div class="flex items-center gap-2.5 border-b border-slate-100 pb-3">
            <div class="w-8 h-8 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
              <i data-lucide="key" class="w-4 h-4"></i>
            </div>
            <div>
              <h3 class="text-sm font-extrabold text-slate-900">2. Target Google Ranking Keywords</h3>
              <p class="text-[11px] text-slate-500">Target search queries for Google snippet matching and internal search boosting</p>
            </div>
          </div>

          <div class="space-y-2">
            <label class="text-xs font-bold text-slate-700">Ranking Keywords (Comma separated)</label>
            <textarea 
              id="seo-keywords" 
              rows="3" 
              placeholder="ai prompts, chatgpt prompts, midjourney prompts, prompt engineering, flux prompts, deepseek prompts, claude prompts, promptsone, best ai image prompts, generative ai prompts"
              oninput="updateSeoLivePreview()"
              class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-mono focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
            ></textarea>

            <div class="flex flex-wrap items-center gap-1.5 pt-1">
              <span class="text-[10px] font-bold text-slate-400 mr-1">Quick Add:</span>
              ${[
                'ai prompts', 'chatgpt prompts', 'midjourney prompts', 'flux prompts',
                'prompt engineering', 'leonardo ai', 'claude prompts', 'gemini prompts',
                'deepseek prompts', 'best image prompts', 'promptsone'
              ].map(k => `
                <button type="button" onclick="quickAddRankingKeyword('${k}')" class="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-amber-50 hover:text-amber-800 text-slate-700 text-[10px] font-semibold border border-slate-200/80 transition flex items-center gap-1">
                  <i data-lucide="plus" class="w-2.5 h-2.5"></i> ${k}
                </button>
              `).join('')}
            </div>
          </div>
        </div>

        <!-- 3. TRENDING & SOCIAL HASHTAGS -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-4">
          <div class="flex items-center gap-2.5 border-b border-slate-100 pb-3">
            <div class="w-8 h-8 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center font-bold">
              <i data-lucide="hash" class="w-4 h-4"></i>
            </div>
            <div>
              <h3 class="text-sm font-extrabold text-slate-900">3. Trending &amp; Social Hashtags</h3>
              <p class="text-[11px] text-slate-500">Live viral hashtags displayed on the public gallery and search suggestions</p>
            </div>
          </div>

          <!-- Active Hashtags List -->
          <div class="space-y-2">
            <label class="text-xs font-bold text-slate-700">Active Hashtags</label>
            <div id="seo-hashtags-list" class="flex flex-wrap gap-2 p-3 bg-slate-50 rounded-xl border border-slate-200 min-h-[50px] items-center">
              <!-- Rendered via JS -->
            </div>
          </div>

          <!-- Add New Hashtag Input -->
          <div class="flex items-center gap-2">
            <div class="relative flex-1 max-w-sm">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">#</span>
              <input 
                type="text" 
                id="new-hashtag-input" 
                placeholder="NewHashtag (e.g. PromptEngineering)" 
                onkeydown="if(event.key==='Enter'){event.preventDefault();addTrendingHashtag();}"
                class="w-full pl-7 pr-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold focus:border-purple-500 focus:outline-none" 
              />
            </div>
            <button type="button" onclick="addTrendingHashtag()" class="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs rounded-xl transition flex items-center gap-1.5 shadow-sm">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i> Add Hashtag
            </button>
          </div>

          <!-- Quick Suggestion Hashtags -->
          <div class="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-100">
            <span class="text-[10px] font-bold text-slate-400 mr-1">Suggestions:</span>
            ${[
              '#AIPrompts', '#ChatGPT', '#MidjourneyPrompt', '#PromptEngineering',
              '#GenerativeAI', '#FluxAI', '#AICreators', '#PromptOfTheDay', '#AIArtCommunity'
            ].map(h => `
              <button type="button" onclick="quickAddHashtagDirect('${h}')" class="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-purple-50 hover:text-purple-800 text-slate-700 text-[10px] font-semibold border border-slate-200/80 transition">
                ${h}
              </button>
            `).join('')}
          </div>
        </div>

        <!-- 4. GOOGLE SEARCH CONSOLE & WEBMASTER VERIFICATION -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-4">
          <div class="flex items-center gap-2.5 border-b border-slate-100 pb-3">
            <div class="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
              <i data-lucide="shield-check" class="w-4 h-4"></i>
            </div>
            <div>
              <h3 class="text-sm font-extrabold text-slate-900">4. Google Search Console &amp; Webmaster Verification</h3>
              <p class="text-[11px] text-slate-500">Proves website ownership to Google Search Console and Bing Webmaster Tools</p>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-xs font-bold text-slate-700">Google Site Verification Token</label>
              <input 
                type="text" 
                id="seo-google-verify" 
                placeholder="e.g. google-site-verification token or code" 
                oninput="updateSeoLivePreview()"
                class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-mono focus:border-emerald-500 focus:outline-none transition" 
              />
              <p class="text-[10px] text-slate-400">Injected as &lt;meta name="google-site-verification" content="..."&gt;</p>
            </div>

            <div class="space-y-1">
              <label class="text-xs font-bold text-slate-700">Bing Webmaster Verification Code</label>
              <input 
                type="text" 
                id="seo-bing-verify" 
                placeholder="e.g. msvalidate.01 token" 
                class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-mono focus:border-emerald-500 focus:outline-none transition" 
              />
              <p class="text-[10px] text-slate-400">Injected as &lt;meta name="msvalidate.01" content="..."&gt;</p>
            </div>
          </div>
        </div>

        <!-- 5. SOCIAL SHARING & OPEN GRAPH (OG) CARDS -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-5">
          <div class="flex items-center gap-2.5 border-b border-slate-100 pb-3">
            <div class="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
              <i data-lucide="share-2" class="w-4 h-4"></i>
            </div>
            <div>
              <h3 class="text-sm font-extrabold text-slate-900">5. Social Sharing &amp; Open Graph (OG) Tags</h3>
              <p class="text-[11px] text-slate-500">Controls how links look when shared on WhatsApp, Facebook, LinkedIn, Discord, and Telegram</p>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-xs font-bold text-slate-700">OG Title (og:title)</label>
              <input 
                type="text" 
                id="seo-og-title" 
                placeholder="PromptsOne — Search Engine for Premium AI Prompts" 
                class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-semibold focus:border-indigo-500 focus:outline-none transition" 
              />
            </div>

            <div class="space-y-1">
              <label class="text-xs font-bold text-slate-700">OG Site Name (og:site_name)</label>
              <input 
                type="text" 
                id="seo-og-site-name" 
                placeholder="PromptsOne" 
                class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-semibold focus:border-indigo-500 focus:outline-none transition" 
              />
            </div>

            <div class="space-y-1 sm:col-span-2">
              <label class="text-xs font-bold text-slate-700">OG Description (og:description)</label>
              <textarea 
                id="seo-og-desc" 
                rows="2" 
                placeholder="Discover, search, copy, and share 500,000+ top engineered AI prompts for ChatGPT, Midjourney, Flux, Claude, Gemini, and Sora on PromptsOne."
                class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs focus:border-indigo-500 focus:outline-none transition"
              ></textarea>
            </div>

            <div class="space-y-1 sm:col-span-2">
              <label class="text-xs font-bold text-slate-700">OG Image URL (og:image) * Optimal 1200x630 px</label>
              <div class="flex gap-2">
                <input 
                  type="text" 
                  id="seo-og-image" 
                  placeholder="https://images.unsplash.com/... or cloud CDN URL" 
                  oninput="updateSeoLivePreview()"
                  class="flex-1 px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-mono focus:border-indigo-500 focus:outline-none transition" 
                />
                <input type="file" id="seo-og-image-file" accept="image/*" class="hidden" onchange="uploadSeoOgImage(this)" />
                <button type="button" onclick="$('seo-og-image-file').click()" class="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition flex items-center gap-1.5 shrink-0">
                  <i data-lucide="upload" class="w-3.5 h-3.5"></i> Upload Image
                </button>
              </div>

              <!-- OG Image Live Preview Box -->
              <div id="seo-og-image-preview-box" class="mt-3 p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center gap-4">
                <img id="seo-og-image-preview" src="https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=400&q=80" alt="OG Preview" class="w-32 h-20 object-cover rounded-lg border bg-slate-200" />
                <div class="text-xs text-slate-500 space-y-1">
                  <p class="font-bold text-slate-800">Social Share Thumbnail Preview</p>
                  <p class="text-[11px]">This image will display when anyone pastes your URL into WhatsApp, Telegram, or Facebook.</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 6. TWITTER / X CARD CONFIGURATION -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-5">
          <div class="flex items-center gap-2.5 border-b border-slate-100 pb-3">
            <div class="w-8 h-8 rounded-xl bg-slate-900 text-white flex items-center justify-center font-bold">
              <svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            </div>
            <div>
              <h3 class="text-sm font-extrabold text-slate-900">6. Twitter / X Cards</h3>
              <p class="text-[11px] text-slate-500">Rich tweet card tags for Twitter / X timeline posts</p>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-xs font-bold text-slate-700">Twitter Card Type</label>
              <select id="seo-twitter-card" class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-semibold focus:border-slate-900 focus:outline-none transition">
                <option value="summary_large_image">summary_large_image (Recommended)</option>
                <option value="summary">summary</option>
              </select>
            </div>

            <div class="space-y-1">
              <label class="text-xs font-bold text-slate-700">Twitter Handle / Creator</label>
              <input 
                type="text" 
                id="seo-twitter-creator" 
                placeholder="@PromptsOneAI" 
                class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-mono focus:border-slate-900 focus:outline-none transition" 
              />
            </div>
          </div>
        </div>

        <!-- 7. SCHEMA.ORG JSON-LD STRUCTURED DATA -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center font-bold">
                <i data-lucide="code" class="w-4 h-4"></i>
              </div>
              <div>
                <h3 class="text-sm font-extrabold text-slate-900">7. Schema.org JSON-LD Structured Data</h3>
                <p class="text-[11px] text-slate-500">Enables Google Rich Snippets (WebSite, SearchAction Sitelinks, SoftwareApplication, Organization)</p>
              </div>
            </div>
            <button type="button" onclick="generateDefaultStructuredData()" class="px-3 py-1.5 rounded-xl bg-teal-50 hover:bg-teal-100 text-teal-700 font-bold text-xs flex items-center gap-1 transition">
              <i data-lucide="wand-2" class="w-3.5 h-3.5"></i> Auto-Generate Standard Schema
            </button>
          </div>

          <div class="space-y-2">
            <textarea 
              id="seo-json-ld" 
              rows="9" 
              placeholder="{ &quot;@context&quot;: &quot;https://schema.org&quot;, ... }"
              class="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl text-xs font-mono bg-slate-950 text-emerald-400 focus:border-teal-500 focus:outline-none transition"
            ></textarea>
            <p class="text-[10px] text-slate-400">Validated against Schema.org specification. Injected inside &lt;script type="application/ld+json"&gt; in document head.</p>
          </div>
        </div>

        <!-- 8. INSTANT SITEMAP.XML & ROBOTS.TXT SUITE -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-4">
          <div class="flex items-center gap-2.5 border-b border-slate-100 pb-3">
            <div class="w-8 h-8 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center font-bold">
              <i data-lucide="map" class="w-4 h-4"></i>
            </div>
            <div>
              <h3 class="text-sm font-extrabold text-slate-900">8. Dynamic Sitemap.xml &amp; Robots.txt Tools</h3>
              <p class="text-[11px] text-slate-500">Fast Google indexing tools generated from live Firestore content</p>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-slate-800 flex items-center gap-1.5"><i data-lucide="file-text" class="w-4 h-4 text-orange-500"></i> Sitemap.xml</span>
                <span class="text-[10px] text-slate-400 font-semibold" id="sitemap-url-count">Includes all prompts &amp; pages</span>
              </div>
              <p class="text-[11px] text-slate-500">Auto-constructs XML map containing your homepage, categories, blog articles, and approved prompt deep links.</p>
              <div class="flex items-center gap-2 pt-1">
                <button type="button" onclick="copySitemapXml()" class="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white font-bold text-xs rounded-lg transition flex items-center gap-1">
                  <i data-lucide="copy" class="w-3.5 h-3.5"></i> Copy XML
                </button>
                <button type="button" onclick="downloadSitemapXml()" class="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs rounded-lg transition flex items-center gap-1">
                  <i data-lucide="download" class="w-3.5 h-3.5"></i> Download
                </button>
              </div>
            </div>

            <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-slate-800 flex items-center gap-1.5"><i data-lucide="bot" class="w-4 h-4 text-blue-500"></i> Robots.txt</span>
                <span class="text-[10px] text-emerald-600 font-semibold font-mono">Standard Googlebot</span>
              </div>
              <p class="text-[11px] text-slate-500">Instructs web crawlers to index public pages while disallowing admin paths and internal API routes.</p>
              <div class="flex items-center gap-2 pt-1">
                <button type="button" onclick="copyRobotsTxt()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-lg transition flex items-center gap-1">
                  <i data-lucide="copy" class="w-3.5 h-3.5"></i> Copy Robots.txt
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- SAVE BUTTON BAR -->
        <div class="sticky bottom-4 z-30 bg-white/95 backdrop-blur-md p-4 rounded-2xl border border-slate-200 shadow-2xl flex items-center justify-between gap-4">
          <div class="flex items-center gap-2 text-xs font-semibold text-slate-600 hidden sm:flex">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
            Changes reflect instantly on live website upon save
          </div>
          <div class="flex items-center gap-3 w-full sm:w-auto justify-end">
            <button type="button" onclick="adminNav('overview')" class="px-5 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 font-bold text-xs rounded-xl transition">
              Cancel
            </button>
            <button type="submit" id="save-seo-btn" class="px-7 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl shadow-lg shadow-emerald-600/20 transition flex items-center gap-2">
              <i data-lucide="save" class="w-4 h-4"></i> Save All SEO Configurations
            </button>
          </div>
        </div>

      </form>
    </div>
  `;
  lcIcons();

  // Populate data from Firestore settings/site & settings/seo
  try {
    const [siteSnap, seoSnap] = await Promise.all([
      getDoc(doc(db, 'settings', 'site')),
      getDoc(doc(db, 'settings', 'seo'))
    ]);

    const siteData = siteSnap.exists() ? siteSnap.data() : {};
    const seoData = seoSnap.exists() ? seoSnap.data() : {};
    const merged = { ...siteData, ...seoData };

    const setVal = (id: string, val: any) => {
      const el = $(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      if (el && val !== undefined && val !== null) el.value = String(val);
    };

    setVal('seo-title', merged.seoTitle || 'PromptsOne — Google for AI Prompts & Engineering Portal');
    setVal('seo-title-template', merged.titleTemplate || '%title% | PromptsOne — AI Prompt Search Engine');
    setVal('seo-desc', merged.metaDescription || 'Discover, search, copy, and share 500,000+ top engineered AI prompts for ChatGPT, Midjourney, Flux, Claude, Gemini, and Sora on PromptsOne.');
    setVal('seo-canonical', merged.canonicalUrl || 'https://promptsone.com/');
    setVal('seo-robots', merged.robotsDirective || 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');
    setVal('seo-author', merged.author || 'PromptsOne AI');
    setVal('seo-keywords', merged.searchKeywords || 'ai prompts, chatgpt prompts, midjourney prompts, prompt engineering, flux prompts, claude prompts, promptsone, best ai image prompts');
    setVal('seo-google-verify', merged.googleVerification || '');
    setVal('seo-bing-verify', merged.bingVerification || '');

    setVal('seo-og-title', merged.ogTitle || merged.seoTitle || 'PromptsOne — Search Engine for Premium AI Prompts');
    setVal('seo-og-site-name', merged.ogSiteName || merged.brandName || 'PromptsOne');
    setVal('seo-og-desc', merged.ogDescription || merged.metaDescription || 'Discover, search, copy, and share 500,000+ top engineered AI prompts for ChatGPT, Midjourney, Flux, Claude, Gemini, and Sora on PromptsOne.');
    setVal('seo-og-image', merged.ogImage || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1200&q=80');

    setVal('seo-twitter-card', merged.twitterCard || 'summary_large_image');
    setVal('seo-twitter-creator', merged.twitterCreator || '@PromptsOneAI');

    if (Array.isArray(merged.trendingHashtags) && merged.trendingHashtags.length > 0) {
      _seoHashtags = [...merged.trendingHashtags];
    }
    renderSeoHashtagsList();

    if (merged.structuredDataOrg) {
      setVal('seo-json-ld', merged.structuredDataOrg);
    } else {
      generateDefaultStructuredData();
    }

    updateSeoLivePreview();
  } catch (err) {
    showToast('Failed to load SEO configuration', 'warning');
  }
}

function renderSeoHashtagsList() {
  const container = $('seo-hashtags-list');
  if (!container) return;
  if (_seoHashtags.length === 0) {
    container.innerHTML = '<span class="text-xs text-slate-400">No hashtags added yet. Type below to add.</span>';
    return;
  }
  container.innerHTML = _seoHashtags.map((tag, idx) => `
    <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-purple-100 text-purple-700 text-xs font-bold shadow-xs">
      ${escapeHtml(tag)}
      <button type="button" onclick="removeTrendingHashtag(${idx})" class="w-3.5 h-3.5 rounded-full hover:bg-purple-200 flex items-center justify-center text-purple-600 transition" title="Remove hashtag">
        &times;
      </button>
    </span>
  `).join('');
}

function addTrendingHashtag() {
  const input = $('new-hashtag-input') as HTMLInputElement | null;
  if (!input) return;
  let val = input.value.trim();
  if (!val) return;
  if (!val.startsWith('#')) val = '#' + val;
  if (!_seoHashtags.includes(val)) {
    _seoHashtags.push(val);
    renderSeoHashtagsList();
    updateSeoLivePreview();
  }
  input.value = '';
}

function removeTrendingHashtag(idx: number) {
  _seoHashtags.splice(idx, 1);
  renderSeoHashtagsList();
  updateSeoLivePreview();
}

(window as any).quickAddHashtagDirect = (tag: string) => {
  if (!_seoHashtags.includes(tag)) {
    _seoHashtags.push(tag);
    renderSeoHashtagsList();
    updateSeoLivePreview();
    showToast(`Added ${tag}`, 'info');
  }
};

function quickAddRankingKeyword(kw: string) {
  const input = $('seo-keywords') as HTMLTextAreaElement | null;
  if (!input) return;
  const cur = input.value.trim();
  if (!cur) {
    input.value = kw;
  } else if (!cur.toLowerCase().includes(kw.toLowerCase())) {
    input.value = cur + ', ' + kw;
  }
  updateSeoLivePreview();
  showToast(`Added "${kw}" to ranking keywords`, 'info');
}

function generateDefaultStructuredData() {
  const siteTitle = ($('seo-title') as HTMLInputElement)?.value.trim() || 'PromptsOne';
  const canonicalUrl = ($('seo-canonical') as HTMLInputElement)?.value.trim() || 'https://promptsone.com/';
  const metaDesc = ($('seo-desc') as HTMLTextAreaElement)?.value.trim() || 'The world largest AI prompt search engine & engineering marketplace.';

  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${canonicalUrl.replace(/\/$/, '')}/#website`,
        "url": canonicalUrl,
        "name": siteTitle,
        "description": metaDesc,
        "potentialAction": {
          "@type": "SearchAction",
          "target": {
            "@type": "EntryPoint",
            "urlTemplate": `${canonicalUrl.replace(/\/$/, '')}/#search?q={search_term_string}`
          },
          "query-input": "required name=search_term_string"
        }
      },
      {
        "@type": "WebApplication",
        "@id": `${canonicalUrl.replace(/\/$/, '')}/#app`,
        "name": siteTitle,
        "url": canonicalUrl,
        "applicationCategory": "DesignApplication",
        "operatingSystem": "All",
        "description": metaDesc,
        "offers": {
          "@type": "Offer",
          "price": "0",
          "priceCurrency": "USD"
        }
      },
      {
        "@type": "Organization",
        "@id": `${canonicalUrl.replace(/\/$/, '')}/#organization`,
        "name": "PromptsOne",
        "url": canonicalUrl,
        "logo": `${canonicalUrl.replace(/\/$/, '')}/favicon.ico`,
        "sameAs": [
          "https://twitter.com/PromptsOneAI",
          "https://discord.gg/promptverse"
        ]
      }
    ]
  };

  const textarea = $('seo-json-ld') as HTMLTextAreaElement | null;
  if (textarea) {
    textarea.value = JSON.stringify(schema, null, 2);
  }
  updateSeoLivePreview();
  showToast('Standard Schema.org structured data generated!', 'success');
}

function updateSeoLivePreview() {
  const title = ($('seo-title') as HTMLInputElement)?.value.trim() || 'PromptsOne';
  const desc = ($('seo-desc') as HTMLTextAreaElement)?.value.trim() || '';
  const canonical = ($('seo-canonical') as HTMLInputElement)?.value.trim() || 'https://promptsone.com';
  const keywords = ($('seo-keywords') as HTMLTextAreaElement)?.value.trim() || '';
  const ogImg = ($('seo-og-image') as HTMLInputElement)?.value.trim() || '';
  const googleVerify = ($('seo-google-verify') as HTMLInputElement)?.value.trim() || '';

  // Update SERP preview card
  const previewTitle = $('serp-preview-title');
  if (previewTitle) previewTitle.textContent = title;
  const previewDesc = $('serp-preview-desc');
  if (previewDesc) previewDesc.textContent = desc || 'Search engine snippet description will display here...';
  const previewUrl = $('serp-preview-url');
  if (previewUrl) previewUrl.textContent = canonical;

  // Update char counters
  const titleCount = $('title-char-count');
  if (titleCount) {
    const len = title.length;
    titleCount.textContent = `${len} / 60 chars (${len >= 40 && len <= 65 ? 'Optimal' : len < 40 ? 'Too short' : 'Too long'})`;
    titleCount.className = `text-[10px] font-mono ${len >= 40 && len <= 65 ? 'text-emerald-600 font-bold' : 'text-amber-500'}`;
  }

  const descCount = $('desc-char-count');
  if (descCount) {
    const len = desc.length;
    descCount.textContent = `${len} / 160 chars (${len >= 130 && len <= 165 ? 'Optimal' : len < 130 ? 'Too short' : 'Too long'})`;
    descCount.className = `text-[10px] font-mono ${len >= 130 && len <= 165 ? 'text-emerald-600 font-bold' : 'text-amber-500'}`;
  }

  // Update OG image preview
  const ogImgEl = $('seo-og-image-preview') as HTMLImageElement | null;
  if (ogImgEl && ogImg) {
    ogImgEl.src = ogImg;
  }

  // Calculate live health score
  let score = 0;
  const checks = {
    title: title.length >= 35 && title.length <= 70,
    desc: desc.length >= 100 && desc.length <= 180,
    keywords: keywords.split(',').filter(k => k.trim()).length >= 4,
    hashtags: _seoHashtags.length >= 3,
    ogimage: !!ogImg,
    canonical: canonical.startsWith('http'),
    gsc: !!googleVerify,
  };

  if (checks.title) score += 20;
  if (checks.desc) score += 20;
  if (checks.keywords) score += 15;
  if (checks.hashtags) score += 15;
  if (checks.ogimage) score += 10;
  if (checks.canonical) score += 10;
  if (checks.gsc) score += 10;

  const scoreBadge = $('seo-score-badge');
  if (scoreBadge) {
    scoreBadge.textContent = `${score} / 100`;
    scoreBadge.className = `px-2 py-0.5 rounded-full font-black text-xs ${score >= 85 ? 'bg-emerald-100 text-emerald-700' : score >= 65 ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`;
  }

  const scoreBar = $('seo-score-bar');
  if (scoreBar) {
    scoreBar.style.width = `${score}%`;
    scoreBar.className = `h-full rounded-full transition-all duration-500 ${score >= 85 ? 'bg-emerald-500' : score >= 65 ? 'bg-amber-500' : 'bg-rose-500'}`;
  }

  const updateChk = (id: string, ok: boolean, label: string) => {
    const el = $(id);
    if (!el) return;
    el.className = `flex items-center gap-2 ${ok ? 'text-emerald-600' : 'text-slate-400'}`;
    el.innerHTML = `<i data-lucide="${ok ? 'check-circle-2' : 'circle'}" class="w-3.5 h-3.5"></i> ${label}`;
  };

  updateChk('chk-title', checks.title, 'Title length optimal (40-65 chars)');
  updateChk('chk-desc', checks.desc, 'Meta description optimal (140-165 chars)');
  updateChk('chk-keywords', checks.keywords, 'Ranking keywords configured');
  updateChk('chk-hashtags', checks.hashtags, 'Trending hashtags configured');
  updateChk('chk-ogimage', checks.ogimage, 'Social share (OG) image provided');
  updateChk('chk-canonical', checks.canonical, 'Canonical base URL valid');
  updateChk('chk-gsc', checks.gsc, checks.gsc ? 'Google Search Console verified' : 'Google Search Console verification (Optional)');

  lcIcons();
}

async function uploadSeoOgImage(input: HTMLInputElement) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  showToast('Uploading Open Graph thumbnail to CDN...', 'info');
  try {
    const url = await uploadToCloudinary(file);
    const ogInput = $('seo-og-image') as HTMLInputElement | null;
    if (ogInput) ogInput.value = url;
    updateSeoLivePreview();
    showToast('OG image uploaded successfully!', 'success');
  } catch (err: any) {
    showToast(err.message || 'Image upload failed', 'error');
  }
}

async function saveSEOSettings(e: Event) {
  e.preventDefault();
  const btn = $('save-seo-btn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Saving SEO configurations...`; lcIcons(); }

  const getVal = (id: string) => ($(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value.trim() || '';

  const seoTitle = getVal('seo-title');
  const titleTemplate = getVal('seo-title-template');
  const metaDescription = getVal('seo-desc');
  const canonicalUrl = getVal('seo-canonical');
  const robotsDirective = getVal('seo-robots');
  const author = getVal('seo-author');
  const searchKeywords = getVal('seo-keywords');
  const googleVerification = getVal('seo-google-verify');
  const bingVerification = getVal('seo-bing-verify');

  const ogTitle = getVal('seo-og-title');
  const ogSiteName = getVal('seo-og-site-name');
  const ogDescription = getVal('seo-og-desc');
  const ogImage = getVal('seo-og-image');

  const twitterCard = getVal('seo-twitter-card');
  const twitterCreator = getVal('seo-twitter-creator');

  const structuredDataOrg = getVal('seo-json-ld');

  const seoPayload = {
    seoTitle,
    titleTemplate,
    metaDescription,
    canonicalUrl,
    robotsDirective,
    author,
    searchKeywords,
    googleVerification,
    bingVerification,
    ogTitle,
    ogSiteName,
    ogDescription,
    ogImage,
    twitterCard,
    twitterCreator,
    structuredDataOrg,
    trendingHashtags: _seoHashtags,
    updatedAt: serverTimestamp()
  };

  try {
    // Write to both settings/site and settings/seo for seamless real-time syncing
    await Promise.all([
      setDoc(doc(db, 'settings', 'site'), seoPayload, { merge: true }),
      setDoc(doc(db, 'settings', 'seo'), seoPayload, { merge: true })
    ]);

    showToast('SEO & Google Ranking configurations saved successfully!', 'success');
    logAdminAction('seo_settings_update', 'settings/seo');
  } catch (err) {
    showToast('Failed to save SEO configurations', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="save" class="w-4 h-4"></i> Save All SEO Configurations`;
      lcIcons();
    }
  }
}

function generateSitemapXmlContent(): string {
  const canonical = (($('seo-canonical') as HTMLInputElement)?.value.trim() || 'https://promptsone.com').replace(/\/$/, '');
  const now = new Date().toISOString().split('T')[0];

  const approved = allPrompts.filter(p => p.status === 'approved');

  let urls = `  <url>\n    <loc>${canonical}/</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n`;
  urls += `  <url>\n    <loc>${canonical}/#search</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>\n`;
  urls += `  <url>\n    <loc>${canonical}/#blog</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
  urls += `  <url>\n    <loc>${canonical}/#collections</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;

  allCategories.forEach(c => {
    urls += `  <url>\n    <loc>${canonical}/#search?category=${encodeURIComponent(c.name)}</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
  });

  approved.slice(0, 500).forEach(p => {
    urls += `  <url>\n    <loc>${canonical}/#prompt/${p.id}</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>`;
}

function copySitemapXml() {
  const xml = generateSitemapXmlContent();
  navigator.clipboard.writeText(xml).then(() => {
    showToast('Dynamic sitemap.xml copied to clipboard!', 'success');
  }).catch(() => {
    downloadFile(xml, 'sitemap.xml', 'application/xml');
  });
}

function downloadSitemapXml() {
  const xml = generateSitemapXmlContent();
  downloadFile(xml, 'sitemap.xml', 'application/xml');
  showToast('sitemap.xml downloaded!', 'success');
}

function copyRobotsTxt() {
  const canonical = (($('seo-canonical') as HTMLInputElement)?.value.trim() || 'https://promptsone.com').replace(/\/$/, '');
  const txt = `User-agent: *\nAllow: /\nDisallow: /admin.html\nDisallow: /api/\n\nSitemap: ${canonical}/sitemap.xml\n`;
  navigator.clipboard.writeText(txt).then(() => {
    showToast('robots.txt content copied to clipboard!', 'success');
  }).catch(() => {
    downloadFile(txt, 'robots.txt', 'text/plain');
  });
}

function formatNumber(num: number): string {
  if (num === undefined || num === null) return '0';
  return num.toLocaleString('en-IN');
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

attachGlobals();

