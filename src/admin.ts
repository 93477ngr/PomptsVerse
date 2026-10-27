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
  limit
} from 'firebase/firestore';
import {
  escapeHtml,
  escapeAttr,
  safeUrl,
  sanitizeHtml,
  getElementSafe
} from './utils/dom';
import { createIcons, icons } from 'lucide';

// Interface definitions
interface PromptItem {
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
  status: 'approved' | 'pending' | 'rejected';
  tags?: string[];
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

let currentAdminUser: User | null = null;
let allPrompts: PromptItem[] = [];
let allCategories: CategoryItem[] = [];
let allUsers: AdminUser[] = [];
let currentSection = 'overview';
let currentConfirmCallback: (() => void) | null = null;

// DOM Helpers
const $ = (id: string) => getElementSafe(id);
const show = (id: string) => { const el = $(id); if (el) el.classList.remove('hidden'); };
const hide = (id: string) => { const el = $(id); if (el) el.classList.add('hidden'); };

function refreshIcons() {
  try {
    createIcons({ icons });
  } catch {
    /* ignore icon errors */
  }
}

function showToast(message: string, type: 'success' | 'error' | 'info' | 'warning' = 'success') {
  const container = $('admin-toast-container');
  if (!container) return;
  const colors = {
    success: 'bg-emerald-600 border-emerald-500',
    error: 'bg-rose-600 border-rose-500',
    info: 'bg-blue-600 border-blue-500',
    warning: 'bg-amber-500 border-amber-400'
  };
  const toast = document.createElement('div');
  toast.className = `${colors[type]} text-white px-4 py-2.5 rounded-xl text-xs font-bold shadow-2xl flex items-center gap-2 border pointer-events-auto max-w-xs`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  refreshIcons();
  setTimeout(() => toast.remove(), 4000);
}

// Activity Audit Log
async function logAdminActivity(action: string, target: string, details?: any) {
  if (!currentAdminUser) return;
  try {
    await addDoc(collection(db, 'adminLogs'), {
      action,
      target,
      details: details || {},
      adminUid: currentAdminUser.uid,
      adminEmail: currentAdminUser.email || '',
      timestamp: serverTimestamp()
    });
  } catch (err) {
    console.warn('Failed to log admin action:', err);
  }
}

// Confirmation Modal
function showConfirm(title: string, message: string, callback: () => void, danger = true) {
  const titleEl = $('confirm-title');
  const msgEl = $('confirm-message');
  const btn = $('execute-confirm-btn') as HTMLButtonElement;

  if (titleEl) titleEl.innerText = title;
  if (msgEl) msgEl.innerText = message;
  if (btn) {
    btn.className = `px-4 py-2 ${danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-blue-600 hover:bg-blue-700'} text-white rounded-xl text-sm font-bold transition`;
    btn.textContent = danger ? 'Delete' : 'Confirm';
  }
  currentConfirmCallback = callback;
  show('confirm-modal');
  refreshIcons();
}

function closeConfirmModal() {
  hide('confirm-modal');
  currentConfirmCallback = null;
}

function executeConfirm() {
  if (currentConfirmCallback) currentConfirmCallback();
  closeConfirmModal();
}

// Auth State Init
window.addEventListener('DOMContentLoaded', () => {
  show('admin-loading');
  hide('admin-login');
  hide('admin-denied');
  hide('admin-dashboard');

  setupAdminEventListeners();

  onAuthStateChanged(auth, async (user) => {
    hide('admin-loading');

    if (!user) {
      show('admin-login');
      refreshIcons();
      return;
    }

    try {
      await syncUserDoc(user);
      const role = await getUserRole(user);

      if (role !== 'admin') {
        show('admin-denied');
        refreshIcons();
        return;
      }

      currentAdminUser = user;
      updateAdminUserUI(user);
      show('admin-dashboard');
      refreshIcons();
      initDashboard();
    } catch (err) {
      console.error('Admin auth error:', err);
      show('admin-denied');
      refreshIcons();
    }
  });
});

function setupAdminEventListeners() {
  const googleBtn = $('admin-google-signin');
  if (googleBtn) googleBtn.addEventListener('click', handleAdminGoogleSignIn);

  const loginForm = $('admin-login-form');
  if (loginForm) loginForm.addEventListener('submit', handleAdminEmailLogin);

  const logoutBtn = $('admin-logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', handleAdminLogout);

  const deniedLogoutBtn = $('denied-logout-btn');
  if (deniedLogoutBtn) deniedLogoutBtn.addEventListener('click', handleAdminLogout);

  const openSidebarBtn = $('open-sidebar-mobile-btn');
  const closeSidebarBtn = $('close-sidebar-mobile-btn');
  const sidebarBackdrop = $('admin-sidebar-backdrop');

  if (openSidebarBtn) openSidebarBtn.addEventListener('click', toggleMobileSidebar);
  if (closeSidebarBtn) closeSidebarBtn.addEventListener('click', toggleMobileSidebar);
  if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', toggleMobileSidebar);

  const cancelConfirm = $('cancel-confirm-btn');
  const executeConfirmBtn = $('execute-confirm-btn');
  if (cancelConfirm) cancelConfirm.addEventListener('click', closeConfirmModal);
  if (executeConfirmBtn) executeConfirmBtn.addEventListener('click', executeConfirm);

  const promptForm = $('prompt-form');
  if (promptForm) promptForm.addEventListener('submit', handleSavePromptSubmit);

  const cancelPromptBtn = $('cancel-prompt-btn');
  const closePromptBtn = $('close-prompt-modal-btn');
  if (cancelPromptBtn) cancelPromptBtn.addEventListener('click', () => hide('prompt-modal'));
  if (closePromptBtn) closePromptBtn.addEventListener('click', () => hide('prompt-modal'));

  // Delegated navigation clicks
  document.addEventListener('click', (e) => {
    const navBtn = (e.target as HTMLElement).closest('[data-admin-nav]') as HTMLElement;
    if (navBtn) {
      const target = navBtn.dataset.adminNav;
      if (target) adminNav(target);
    }
  });
}

function toggleMobileSidebar() {
  const sidebar = $('admin-sidebar');
  const backdrop = $('admin-sidebar-backdrop');
  if (sidebar) sidebar.classList.toggle('-translate-x-full');
  if (backdrop) backdrop.classList.toggle('hidden');
}

function updateAdminUserUI(user: User) {
  const letter = (user.displayName || user.email || 'A').charAt(0).toUpperCase();
  const name = user.displayName || user.email?.split('@')[0] || 'Admin';

  const sAvatar = $('sidebar-avatar');
  const hAvatar = $('header-avatar');
  if (sAvatar) sAvatar.innerText = letter;
  if (hAvatar) hAvatar.innerText = letter;

  const sName = $('sidebar-name');
  const sEmail = $('sidebar-email');
  const hName = $('header-name');

  if (sName) sName.innerText = name;
  if (sEmail) sEmail.innerText = user.email || '';
  if (hName) hName.innerText = name;
}

// Auth Handlers
async function handleAdminGoogleSignIn() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err: any) {
    showLoginError(err.message || 'Google sign-in failed');
  }
}

async function handleAdminEmailLogin(e: Event) {
  e.preventDefault();
  const emailEl = $('admin-email-input') as HTMLInputElement;
  const passEl = $('admin-password-input') as HTMLInputElement;
  if (!emailEl || !passEl) return;

  try {
    await signInWithEmailAndPassword(auth, emailEl.value.trim(), passEl.value);
  } catch (err: any) {
    showLoginError(err.message || 'Invalid email or password');
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
  if (txt) txt.innerText = msg;
}

// Dashboard Sections
async function initDashboard() {
  await loadAllPrompts();
  await loadAllCategories();
  adminNav('overview');
}

function adminNav(section: string) {
  currentSection = section;

  document.querySelectorAll('.admin-nav-item').forEach(btn => {
    btn.classList.remove('admin-nav-active');
  });
  const activeBtn = $(`nav-${section}`);
  if (activeBtn) activeBtn.classList.add('admin-nav-active');

  const titleEl = $('page-title');
  if (titleEl) titleEl.innerText = section.charAt(0).toUpperCase() + section.slice(1);

  renderAdminSection(section);
  refreshIcons();
}

async function loadAllPrompts() {
  try {
    const snap = await getDocs(query(collection(db, 'prompts'), orderBy('createdAt', 'desc'), limit(200)));
    allPrompts = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as PromptItem));
    
    const pendingCount = allPrompts.filter(p => p.status === 'pending').length;
    const badge = $('nav-badge-pending');
    if (badge) {
      if (pendingCount > 0) {
        badge.innerText = String(pendingCount);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'prompts');
  }
}

async function loadAllCategories() {
  try {
    const snap = await getDocs(collection(db, 'categories'));
    allCategories = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as CategoryItem));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'categories');
  }
}

function renderAdminSection(section: string) {
  const container = $('admin-content');
  if (!container) return;

  if (section === 'overview') {
    const totalViews = allPrompts.reduce((sum, p) => sum + (p.views || 0), 0);
    const totalLikes = allPrompts.reduce((sum, p) => sum + (p.likes || 0), 0);
    const pendingCount = allPrompts.filter(p => p.status === 'pending').length;

    container.innerHTML = `
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-1">
          <p class="text-xs font-bold text-slate-500 uppercase">Total Prompts</p>
          <p class="text-2xl font-extrabold text-slate-900">${allPrompts.length}</p>
        </div>
        <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-1">
          <p class="text-xs font-bold text-slate-500 uppercase">Total Views</p>
          <p class="text-2xl font-extrabold text-blue-600">${totalViews}</p>
        </div>
        <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-1">
          <p class="text-xs font-bold text-slate-500 uppercase">Total Likes</p>
          <p class="text-2xl font-extrabold text-rose-600">${totalLikes}</p>
        </div>
        <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-1">
          <p class="text-xs font-bold text-slate-500 uppercase">Pending Submissions</p>
          <p class="text-2xl font-extrabold text-amber-600">${pendingCount}</p>
        </div>
      </div>

      <div class="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
        <div class="flex items-center justify-between">
          <h3 class="font-bold text-slate-900 text-sm">Recent Submissions</h3>
          <button data-admin-nav="prompts" class="text-xs font-bold text-blue-600 hover:underline">Manage All</button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 border-b border-slate-200">
              <tr>
                <th class="p-3 text-left font-bold text-slate-600">Prompt</th>
                <th class="p-3 text-left font-bold text-slate-600">Tool</th>
                <th class="p-3 text-left font-bold text-slate-600">Status</th>
                <th class="p-3 text-right font-bold text-slate-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${allPrompts.slice(0, 5).map(p => `
                <tr class="border-b border-slate-100 hover:bg-slate-50">
                  <td class="p-3 font-bold text-slate-900">${escapeHtml(p.title)}</td>
                  <td class="p-3 text-slate-600">${escapeHtml(p.tool)}</td>
                  <td class="p-3">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold ${p.status === 'approved' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">
                      ${escapeHtml(p.status)}
                    </span>
                  </td>
                  <td class="p-3 text-right space-x-1">
                    ${p.status === 'pending' ? `
                      <button onclick="window.approvePromptAdmin('${escapeAttr(p.id)}')" class="px-2 py-1 bg-emerald-600 text-white rounded font-bold text-[10px]">Approve</button>
                    ` : ''}
                    <button onclick="window.deletePromptAdmin('${escapeAttr(p.id)}')" class="px-2 py-1 bg-rose-600 text-white rounded font-bold text-[10px]">Delete</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } else if (section === 'prompts') {
    renderAdminPromptsList(container);
  } else if (section === 'categories') {
    renderAdminCategoriesList(container);
  } else if (section === 'aitools') {
    renderAdminAIToolsList(container);
  } else if (section === 'blogs') {
    renderAdminBlogsList(container);
  } else if (section === 'contacts') {
    renderAdminContactsList(container);
  } else if (section === 'users') {
    renderAdminUsersList(container);
  } else if (section === 'logs') {
    renderAdminLogs(container);
  } else {
    container.innerHTML = `<div class="p-8 text-center text-slate-400">Section "${escapeHtml(section)}" is active.</div>`;
  }
}

function renderAdminPromptsList(container: HTMLElement) {
  container.innerHTML = `
    <div class="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h3 class="font-bold text-slate-900 text-base">All Prompts (${allPrompts.length})</h3>
          <p class="text-xs text-slate-500">Manage, approve, edit and curate all AI prompts</p>
        </div>
        <button id="admin-create-prompt-btn" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-xs transition flex items-center gap-1.5">
          <i data-lucide="plus" class="w-4 h-4"></i> Create Prompt
        </button>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead class="bg-slate-50 border-b border-slate-200">
            <tr>
              <th class="p-3 text-left font-bold text-slate-600">Title</th>
              <th class="p-3 text-left font-bold text-slate-600">Tool</th>
              <th class="p-3 text-left font-bold text-slate-600">Category</th>
              <th class="p-3 text-left font-bold text-slate-600">Status</th>
              <th class="p-3 text-left font-bold text-slate-600">Views/Likes</th>
              <th class="p-3 text-right font-bold text-slate-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${allPrompts.map(p => `
              <tr class="border-b border-slate-100 hover:bg-slate-50 transition">
                <td class="p-3 font-bold text-slate-900 flex items-center gap-2.5">
                  <img src="${escapeAttr(safeUrl(p.image))}" class="w-8 h-8 rounded-lg object-cover border border-slate-200" />
                  <div>
                    <p class="truncate max-w-[220px] font-extrabold text-slate-900">${escapeHtml(p.title)}</p>
                    <p class="text-[10px] text-slate-400">By ${escapeHtml(p.creator || 'Admin')}</p>
                  </div>
                </td>
                <td class="p-3 text-slate-600 font-semibold">${escapeHtml(p.tool)}</td>
                <td class="p-3 text-slate-600 font-semibold">${escapeHtml(p.category)}</td>
                <td class="p-3">
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold ${p.status === 'approved' ? 'bg-emerald-100 text-emerald-800' : p.status === 'rejected' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}">
                    ${escapeHtml(p.status)}
                  </span>
                </td>
                <td class="p-3 text-slate-600 font-medium">${p.views || 0} / ${p.likes || 0}</td>
                <td class="p-3 text-right space-x-1">
                  ${p.status === 'pending' ? `
                    <button onclick="window.approvePromptAdmin('${escapeAttr(p.id)}')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-[10px] transition">Approve</button>
                    <button onclick="window.rejectPromptAdmin('${escapeAttr(p.id)}')" class="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-lg font-bold text-[10px] transition">Reject</button>
                  ` : ''}
                  <button onclick="window.editPromptAdmin('${escapeAttr(p.id)}')" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold text-[10px] transition">Edit</button>
                  <button onclick="window.deletePromptAdmin('${escapeAttr(p.id)}')" class="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-bold text-[10px] transition">Delete</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  const createBtn = $('admin-create-prompt-btn');
  if (createBtn) {
    createBtn.addEventListener('click', () => {
      const pfId = $('pf-id') as HTMLInputElement;
      const pfTitle = $('pf-title') as HTMLInputElement;
      const pfPrompt = $('pf-prompt') as HTMLTextAreaElement;
      if (pfId) pfId.value = '';
      if (pfTitle) pfTitle.value = '';
      if (pfPrompt) pfPrompt.value = '';
      const titleEl = $('prompt-modal-title');
      if (titleEl) titleEl.innerText = 'Create Prompt';
      show('prompt-modal');
    });
  }
}

function renderAdminCategoriesList(container: HTMLElement) {
  container.innerHTML = `
    <div class="bg-white rounded-2xl border border-slate-200 p-5 space-y-5">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h3 class="font-bold text-slate-900 text-base">Category Management</h3>
          <p class="text-xs text-slate-500">Add or manage system category taxonomy</p>
        </div>
      </div>

      <!-- Add Category Inline Form -->
      <form id="add-category-form" class="bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center gap-3">
        <input type="text" id="new-cat-name" required placeholder="Category Name (e.g. Photography)" class="w-full sm:flex-1 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold" />
        <input type="text" id="new-cat-icon" placeholder="Lucide Icon (e.g. camera)" class="w-full sm:w-48 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold" />
        <button type="submit" class="w-full sm:w-auto px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl transition shrink-0">
          + Add Category
        </button>
      </form>

      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        ${allCategories.map(c => `
          <div class="p-4 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between shadow-xs">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center font-bold">
                <i data-lucide="${escapeAttr(c.icon || 'folder')}" class="w-4 h-4"></i>
              </div>
              <span class="font-bold text-xs text-slate-800">${escapeHtml(c.name)}</span>
            </div>
            <button onclick="window.deleteCategoryAdmin('${escapeAttr(c.id)}')" class="p-1.5 text-slate-400 hover:text-rose-600 transition">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  const form = $('add-category-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = $('new-cat-name') as HTMLInputElement;
      const iconInput = $('new-cat-icon') as HTMLInputElement;
      if (!nameInput || !nameInput.value.trim()) return;

      try {
        await addDoc(collection(db, 'categories'), {
          name: nameInput.value.trim(),
          icon: iconInput && iconInput.value.trim() ? iconInput.value.trim() : 'folder',
          count: 0
        });
        showToast('Category added!');
        await loadAllCategories();
        renderAdminSection('categories');
      } catch (err: any) {
        showToast(`Failed: ${err.message}`, 'error');
      }
    });
  }
}

async function renderAdminAIToolsList(container: HTMLElement) {
  try {
    const snap = await getDocs(collection(db, 'aiTools'));
    const tools = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    container.innerHTML = `
      <div class="bg-white rounded-2xl border border-slate-200 p-5 space-y-5">
        <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h3 class="font-bold text-slate-900 text-base">AI Tools Management</h3>
            <p class="text-xs text-slate-500">Manage supported generative AI platforms</p>
          </div>
        </div>

        <form id="add-tool-form" class="bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-center gap-3">
          <input type="text" id="new-tool-name" required placeholder="AI Tool Name (e.g. Midjourney)" class="w-full sm:flex-1 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold" />
          <button type="submit" class="w-full sm:w-auto px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl transition shrink-0">
            + Add Tool
          </button>
        </form>

        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          ${tools.map(t => `
            <div class="p-4 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between">
              <span class="font-bold text-xs text-slate-800">${escapeHtml(t.name)}</span>
              <button onclick="window.deleteToolAdmin('${escapeAttr(t.id)}')" class="p-1.5 text-slate-400 hover:text-rose-600 transition">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    const form = $('add-tool-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = $('new-tool-name') as HTMLInputElement;
        if (!input || !input.value.trim()) return;
        try {
          await addDoc(collection(db, 'aiTools'), { name: input.value.trim() });
          showToast('AI Tool added!');
          renderAdminSection('aitools');
        } catch (err: any) {
          showToast(`Failed: ${err.message}`, 'error');
        }
      });
    }
  } catch {
    container.innerHTML = `<div class="p-8 text-center text-slate-400">Failed to load AI tools.</div>`;
  }
}

async function renderAdminBlogsList(container: HTMLElement) {
  try {
    const snap = await getDocs(query(collection(db, 'blogs'), orderBy('publishedAt', 'desc'), limit(50)));
    const blogs = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    container.innerHTML = `
      <div class="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-bold text-slate-900 text-base">Blog Posts (${blogs.length})</h3>
            <p class="text-xs text-slate-500">Manage guides and tutorials</p>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 border-b border-slate-200">
              <tr>
                <th class="p-3 text-left font-bold text-slate-600">Title</th>
                <th class="p-3 text-left font-bold text-slate-600">Author</th>
                <th class="p-3 text-left font-bold text-slate-600">Status</th>
                <th class="p-3 text-right font-bold text-slate-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${blogs.map(b => `
                <tr class="border-b border-slate-100 hover:bg-slate-50">
                  <td class="p-3 font-bold text-slate-900">${escapeHtml(b.title)}</td>
                  <td class="p-3 text-slate-600">${escapeHtml(b.author || 'Admin')}</td>
                  <td class="p-3">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">${escapeHtml(b.status || 'published')}</span>
                  </td>
                  <td class="p-3 text-right">
                    <button onclick="window.deleteBlogAdmin('${escapeAttr(b.id)}')" class="px-2.5 py-1 bg-rose-600 text-white rounded font-bold text-[10px]">Delete</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch {
    container.innerHTML = `<div class="p-8 text-center text-slate-400">Failed to load blogs.</div>`;
  }
}

async function renderAdminContactsList(container: HTMLElement) {
  try {
    const snap = await getDocs(query(collection(db, 'contactSubmissions'), orderBy('timestamp', 'desc'), limit(50)));
    const contacts = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    container.innerHTML = `
      <div class="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
        <div>
          <h3 class="font-bold text-slate-900 text-base">Contact Inquiries (${contacts.length})</h3>
          <p class="text-xs text-slate-500">Messages submitted through the public contact form</p>
        </div>

        <div class="space-y-3">
          ${contacts.map(c => `
            <div class="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-1.5 text-xs">
              <div class="flex items-center justify-between">
                <span class="font-bold text-slate-900">${escapeHtml(c.name)} (${escapeHtml(c.email)})</span>
                <span class="text-[10px] text-slate-400">${c.timestamp ? new Date(c.timestamp.seconds * 1000).toLocaleString() : ''}</span>
              </div>
              <p class="text-slate-700 leading-relaxed font-medium">${escapeHtml(c.message)}</p>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } catch {
    container.innerHTML = `<div class="p-8 text-center text-slate-400">No contact submissions found.</div>`;
  }
}

async function renderAdminUsersList(container: HTMLElement) {
  try {
    const snap = await getDocs(query(collection(db, 'users'), limit(100)));
    const users = snap.docs.map(d => ({ uid: d.id, ...(d.data() as any) })) as AdminUser[];

    container.innerHTML = `
      <div class="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
        <div>
          <h3 class="font-bold text-slate-900 text-base">Registered Users (${users.length})</h3>
          <p class="text-xs text-slate-500">Audit user accounts and access credentials</p>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 border-b border-slate-200">
              <tr>
                <th class="p-3 text-left font-bold text-slate-600">User</th>
                <th class="p-3 text-left font-bold text-slate-600">Email</th>
                <th class="p-3 text-left font-bold text-slate-600">Role</th>
                <th class="p-3 text-right font-bold text-slate-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${users.map(u => `
                <tr class="border-b border-slate-100 hover:bg-slate-50">
                  <td class="p-3 font-bold text-slate-900">${escapeHtml(u.displayName || 'User')}</td>
                  <td class="p-3 text-slate-600">${escapeHtml(u.email)}</td>
                  <td class="p-3">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold ${u.role === 'admin' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-800'}">
                      ${escapeHtml(u.role || 'user')}
                    </span>
                  </td>
                  <td class="p-3 text-right">
                    <button onclick="window.toggleUserRoleAdmin('${escapeAttr(u.uid)}', '${u.role === 'admin' ? 'user' : 'admin'}')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-900 text-white rounded font-bold text-[10px]">
                      Make ${u.role === 'admin' ? 'User' : 'Admin'}
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch {
    container.innerHTML = `<div class="p-8 text-center text-slate-400">Failed to load users.</div>`;
  }
}

async function renderAdminLogs(container: HTMLElement) {
  try {
    const snap = await getDocs(query(collection(db, 'adminLogs'), orderBy('timestamp', 'desc'), limit(50)));
    const logs = snap.docs.map(d => d.data());

    container.innerHTML = `
      <div class="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
        <h3 class="font-bold text-slate-900 text-base">Admin Audit Logs</h3>
        <div class="space-y-2">
          ${logs.map(l => `
            <div class="p-3 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between text-xs">
              <div>
                <span class="font-bold text-slate-800">${escapeHtml(l.action)}</span>
                <span class="text-slate-500"> on ${escapeHtml(l.target)}</span>
              </div>
              <span class="text-[10px] text-slate-400">${escapeHtml(l.adminEmail)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } catch {
    container.innerHTML = `<div class="p-8 text-center text-slate-400">No logs found.</div>`;
  }
}

// Prompt Modal Save
async function handleSavePromptSubmit(e: Event) {
  e.preventDefault();
  const pfId = $('pf-id') as HTMLInputElement;
  const pfTitle = $('pf-title') as HTMLInputElement;
  const pfTool = $('pf-tool') as HTMLSelectElement;
  const pfCategory = $('pf-category') as HTMLSelectElement;
  const pfStatus = $('pf-status') as HTMLSelectElement;
  const pfPrompt = $('pf-prompt') as HTMLTextAreaElement;
  const pfNegative = $('pf-negative') as HTMLTextAreaElement;
  const pfTags = $('pf-tags') as HTMLInputElement;
  const pfImage = $('pf-image-url') as HTMLInputElement;
  const pfFile = $('pf-image-file') as HTMLInputElement;
  const pfFeatured = $('pf-featured') as HTMLInputElement;
  const pfTrending = $('pf-trending') as HTMLInputElement;

  if (!pfTitle || !pfPrompt) return;

  try {
    let imageUrl = pfImage && pfImage.value.trim() ? pfImage.value.trim() : '';
    if (pfFile && pfFile.files && pfFile.files[0]) {
      imageUrl = await uploadToCloudinary(pfFile.files[0]);
    }
    if (!imageUrl) imageUrl = 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80';

    const tagsRaw = pfTags ? pfTags.value.trim() : '';
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    const id = pfId ? pfId.value : '';
    const payload = {
      title: pfTitle.value.trim(),
      tool: pfTool ? pfTool.value : 'ChatGPT',
      category: pfCategory ? pfCategory.value : 'AI Art',
      status: pfStatus ? pfStatus.value as any : 'approved',
      prompt: pfPrompt.value.trim(),
      negative: pfNegative ? pfNegative.value.trim() : '',
      tags,
      featured: pfFeatured ? pfFeatured.checked : false,
      trending: pfTrending ? pfTrending.checked : false,
      image: imageUrl,
      updatedAt: serverTimestamp()
    };

    if (id) {
      await updateDoc(doc(db, 'prompts', id), payload);
      await logAdminActivity('UPDATE_PROMPT', id, { title: payload.title });
      showToast('Prompt updated!');
    } else {
      const docRef = await addDoc(collection(db, 'prompts'), {
        ...payload,
        creator: currentAdminUser?.displayName || 'Admin',
        creatorId: currentAdminUser?.uid || '',
        views: 0,
        likes: 0,
        downloads: 0,
        copyCount: 0,
        createdAt: serverTimestamp()
      });
      await logAdminActivity('CREATE_PROMPT', docRef.id, { title: payload.title });
      showToast('Prompt created!');
    }

    hide('prompt-modal');
    await loadAllPrompts();
    renderAdminSection(currentSection);
  } catch (err: any) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// Window Global Helper Attachments
function attachAdminGlobals() {
  const w = window as any;

  w.editPromptAdmin = (id: string) => {
    const p = allPrompts.find(x => x.id === id);
    if (!p) return;
    const pfId = $('pf-id') as HTMLInputElement;
    const pfTitle = $('pf-title') as HTMLInputElement;
    const pfTool = $('pf-tool') as HTMLSelectElement;
    const pfCategory = $('pf-category') as HTMLSelectElement;
    const pfStatus = $('pf-status') as HTMLSelectElement;
    const pfPrompt = $('pf-prompt') as HTMLTextAreaElement;
    const pfNegative = $('pf-negative') as HTMLTextAreaElement;
    const pfTags = $('pf-tags') as HTMLInputElement;
    const pfImage = $('pf-image-url') as HTMLInputElement;
    const pfFeatured = $('pf-featured') as HTMLInputElement;
    const pfTrending = $('pf-trending') as HTMLInputElement;

    if (pfId) pfId.value = p.id;
    if (pfTitle) pfTitle.value = p.title;
    if (pfTool) pfTool.value = p.tool;
    if (pfCategory) pfCategory.value = p.category;
    if (pfStatus) pfStatus.value = p.status;
    if (pfPrompt) pfPrompt.value = p.prompt;
    if (pfNegative) pfNegative.value = p.negative || '';
    if (pfTags) pfTags.value = p.tags ? p.tags.join(', ') : '';
    if (pfImage) pfImage.value = p.image || '';
    if (pfFeatured) pfFeatured.checked = !!p.featured;
    if (pfTrending) pfTrending.checked = !!p.trending;

    const titleEl = $('prompt-modal-title');
    if (titleEl) titleEl.innerText = 'Edit Prompt';
    show('prompt-modal');
  };

  w.approvePromptAdmin = async (id: string) => {
    try {
      await updateDoc(doc(db, 'prompts', id), { status: 'approved', updatedAt: serverTimestamp() });
      await logAdminActivity('APPROVE_PROMPT', id);
      showToast('Prompt approved!');
      await loadAllPrompts();
      renderAdminSection(currentSection);
    } catch (err: any) {
      showToast(`Approval failed: ${err.message}`, 'error');
    }
  };

  w.rejectPromptAdmin = async (id: string) => {
    try {
      await updateDoc(doc(db, 'prompts', id), { status: 'rejected', updatedAt: serverTimestamp() });
      await logAdminActivity('REJECT_PROMPT', id);
      showToast('Prompt rejected');
      await loadAllPrompts();
      renderAdminSection(currentSection);
    } catch (err: any) {
      showToast(`Rejection failed: ${err.message}`, 'error');
    }
  };

  w.deletePromptAdmin = (id: string) => {
    showConfirm('Delete Prompt', 'Are you sure you want to delete this prompt? This cannot be undone.', async () => {
      try {
        await deleteDoc(doc(db, 'prompts', id));
        await logAdminActivity('DELETE_PROMPT', id);
        showToast('Prompt deleted');
        await loadAllPrompts();
        renderAdminSection(currentSection);
      } catch (err: any) {
        showToast(`Deletion failed: ${err.message}`, 'error');
      }
    });
  };

  w.deleteCategoryAdmin = (id: string) => {
    showConfirm('Delete Category', 'Are you sure you want to delete this category?', async () => {
      try {
        await deleteDoc(doc(db, 'categories', id));
        showToast('Category deleted');
        await loadAllCategories();
        renderAdminSection('categories');
      } catch (err: any) {
        showToast(`Deletion failed: ${err.message}`, 'error');
      }
    });
  };

  w.deleteToolAdmin = (id: string) => {
    showConfirm('Delete AI Tool', 'Are you sure you want to delete this tool?', async () => {
      try {
        await deleteDoc(doc(db, 'aiTools', id));
        showToast('AI Tool deleted');
        renderAdminSection('aitools');
      } catch (err: any) {
        showToast(`Deletion failed: ${err.message}`, 'error');
      }
    });
  };

  w.deleteBlogAdmin = (id: string) => {
    showConfirm('Delete Blog Post', 'Are you sure you want to delete this blog post?', async () => {
      try {
        await deleteDoc(doc(db, 'blogs', id));
        showToast('Blog post deleted');
        renderAdminSection('blogs');
      } catch (err: any) {
        showToast(`Deletion failed: ${err.message}`, 'error');
      }
    });
  };

  w.toggleUserRoleAdmin = async (uid: string, newRole: string) => {
    try {
      await updateDoc(doc(db, 'users', uid), { role: newRole, updatedAt: serverTimestamp() });
      await logAdminActivity('UPDATE_USER_ROLE', uid, { newRole });
      showToast(`User role updated to ${newRole}`);
      renderAdminSection('users');
    } catch (err: any) {
      showToast(`Role update failed: ${err.message}`, 'error');
    }
  };
}

attachAdminGlobals();

