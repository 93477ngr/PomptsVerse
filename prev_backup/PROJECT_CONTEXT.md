# PROJECT_CONTEXT.md — PromptVerse AI

> **Read this file before touching any code.** Update the "Completed Phases" section after every phase.

---

## 1. What This Project Is

**PromptVerse AI** — A production-grade, single-page AI prompt search engine. Described as "Google for AI Prompts." Users discover, search, bookmark, copy, and share AI-generation prompts for tools like ChatGPT, Midjourney, Flux, Gemini, Claude, Ideogram, Leonardo AI, and Sora.

---

## 2. Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Vanilla TypeScript (no React/Next.js) |
| Build tool | Vite 6 + `@vitejs/plugin-react` (needed for JSX in vite pipeline only) |
| CSS | Tailwind CSS v4 (via CDN in `index.html` + `@tailwindcss/vite` plugin) |
| Icons | Lucide (CDN in index.html `lucide.createIcons()`) |
| Auth | Firebase Authentication (Email/Password + Google) |
| Database | Firebase Firestore |
| Hosting | Firebase Hosting (`dist/`) |
| Images | Cloudinary (unsigned upload preset) |
| Analytics | Firebase Analytics |
| Fonts | Plus Jakarta Sans (Google Fonts) |

---

## 3. File & Directory Map

```
d:\Promtverse\
├── index.html            ← MAIN APP FILE: all HTML structure, 3246 lines
│                           - Lines 1–190: <head>, Tailwind config, inline <style> (CSS keyframes/utilities)
│                           - Lines 192–1612: <body> HTML — navbar, views, modals, footer elements
│                           - Lines 1864–1869: <script type="module" src="/src/app.ts"> (live entry)
│                           - Lines 1870–3243: <script type="text/template"> LEGACY BACKUP (dead code, never executes)
│                           - Lines 3244–3246: </body></html>
│
├── src/
│   ├── app.ts            ← PRIMARY LOGIC: 1566 lines, TypeScript
│   │                       - Firebase imports & init
│   │                       - Data interfaces (PromptItem, CategoryItem)
│   │                       - Seed data (INITIAL_PROMPTS, INITIAL_CATEGORIES)
│   │                       - App state variables
│   │                       - DOMContentLoaded listener & init flow
│   │                       - Auth listener + role resolution
│   │                       - Firestore real-time listeners
│   │                       - All render functions
│   │                       - Search, filter, sort
│   │                       - Admin CRUD
│   │                       - Modals, toasts, typewriter
│   │                       - attachWindowGlobalFunctions() — exposes all functions to window.*
│   │
│   ├── firebase.ts       ← Firebase init, helpers: 169 lines
│   │                       - firebaseConfig (project: promptsverse-ai)
│   │                       - auth, db, analytics, googleProvider exports
│   │                       - OperationType enum
│   │                       - handleFirestoreError()
│   │                       - testConnection()
│   │                       - getUserRole() ← CURRENTLY checks email hardcode first (MUST FIX)
│   │                       - syncUserDoc()
│   │                       - uploadToCloudinary() ← CURRENTLY uses demo/fallback (MUST FIX)
│   │
│   ├── main.tsx          ← Unused React entry (boilerplate, not loaded by index.html)
│   ├── App.tsx           ← Unused React component (boilerplate stub)
│   └── index.css         ← Near-empty (only 23 bytes), styles live in index.html <style>
│
├── firestore.rules       ← Security rules (correct structure, needs role-check improvements)
├── firebase.json         ← Hosting: public=dist, SPA rewrite, firestore rules ref
├── .firebaserc           ← project: promptsverse-ai
├── vite.config.ts        ← react plugin + tailwindcss plugin, alias @→root, HMR config
├── package.json          ← firebase v12, tailwindcss v4, vite v6, lucide-react, react, typescript
├── tsconfig.json
├── .env.example          ← GEMINI_API_KEY, APP_URL (neither currently used by app.ts)
└── assets/               ← (empty or not inspected)
```

---

## 4. Application Views / Pages

All views are `<div id="view-X" class="view-panel">` — shown/hidden by JS via `navigateTo()`.

| View ID | Description |
|---|---|
| `view-home` | Hero, categories, trending, gallery, sidebar |
| `view-search` | Full-text search with category/tool filters |
| `view-collections` | Curated collection grid |
| `view-pricing` | Pricing tiers (Starter / Pro / Agency) |
| `view-admin` | Admin dashboard (stats, prompts table, categories tab, analytics tab) |
| `view-details` | Full prompt detail page with related, recommendations, sidebar widgets |

---

## 5. Firestore Data Collections

| Collection | Fields | Notes |
|---|---|---|
| `prompts` | id, title, tool, category, image, prompt, negative, views, likes, downloads, creator, creatorId, featured, trending, status, createdAt, updatedAt | status: 'approved'|'pending'|'rejected' |
| `categories` | id, name, icon, count | icon = lucide icon name |
| `users/{uid}` | uid, email, displayName, photoURL, role, createdAt, updatedAt | role: 'admin'|'user' |
| `users/{uid}/bookmarks/{promptId}` | promptId, createdAt | subcollection |

**Planned additions (Phase 3+):**
- `prompts.rankScore` (precomputed field for efficient sorting)
- `prompts.copyCount` (tracked separately from downloads)
- `prompts.seasonalTags[]` (for seasonal ranking boosts)

---

## 6. Application State (in app.ts)

```typescript
let prompts: PromptItem[] = [];
let categories: CategoryItem[] = [];
let bookmarks: string[] = [];
let currentSelectedPrompt: PromptItem | null = null;
let activeView = 'home';
let currentUser: User | null = null;
let currentUserRole: 'admin' | 'user' = 'user';
let isAuthLoading = true;
let unsubscribeBookmarks: (() => void) | null = null;
```

---

## 7. Key Functions in app.ts

### Initialization
- `DOMContentLoaded` → `renderCategoryPills()`, `populateFormCategoryOptions()`, `renderAll()`, `testConnection()`, `setupAuthListener()`, `setupFirestoreListeners()`, `initTypewriter()`, `handleHashRouting()`, cursor glow listener, `attachWindowGlobalFunctions()`

### Auth
- `setupAuthListener()` — `onAuthStateChanged` → `syncUserDoc()`, `getUserRole()`, `listenToUserBookmarks()`
- `handleGoogleSignIn()` — popup, fallback to demo session on domain restriction
- `handleEmailAuthSubmit()` — sign-in, auto-register if not found, fallback to demo
- `handleUserLogout()` — sign out + navigate home
- `activateDemoAdminSession()` — injects a fake currentUser object (REMOVE after real auth works)
- `renderAuthUI()` — updates navbar auth section based on auth state

### Navigation
- `navigateTo(viewName)` — show/hide `.view-panel` divs, update nav highlights, scroll to top
- `handleHashRouting()` — maps URL hash to views
- `scrollToSection(id)` — used for Categories/Trending navbar links
- `toggleAdminView()` — toggles admin view if role = 'admin'

### Rendering
- `renderAll()` — calls all render functions
- `renderCategoryPills()` — fills `#categories-container`
- `renderAIToolsList()` — fills `#ai-tools-list`
- `renderTrendingPrompts()` — fills `#trending-prompts-container` (5 trending prompts)
- `renderPromptsGallery(arr)` — fills `#prompts-grid`
- `createPromptCardHTML(p)` — generates card HTML for a single prompt
- `renderPopularSearches()` — fills `#popular-searches-list` (hardcoded list)
- `renderCollections()` — fills `#featured-collections-list` (hardcoded list)
- `renderAdminDashboard()` — fills stat counters + calls `renderAdminTable()`
- `renderAdminTable()` — fills `#admin-prompts-tbody`
- `populateFormCategoryOptions()` — fills `#form-category` and `#search-category-select`

### Search & Filter
- `quickSearch(query)` — pre-fills hero input, calls `executeSearch()`
- `executeSearch()` — navigate to search, mirror query to search page input, call `triggerSearchFilter()`
- `triggerSearchFilter()` — client-side filter on cached `prompts[]` by query+cat+tool
- `filterByTool(tool)` — filter gallery by tool
- `filterBySort(sortType)` — sort gallery by likes/popular/trending
- `handleLiveSearchInput(query)` — autocomplete dropdown in hero search
- `resetSearchFilters()` — clears filter inputs

### Prompt Detail
- `openPromptDetail(id, updateHash?)` — populate `view-details`, increment views in Firestore
- `openPromptModal(id)` — populate `#prompt-modal` (quick-view modal)

### Bookmarks & Likes
- `toggleBookmarkCard(id, e?)` — Firestore set/delete in `users/{uid}/bookmarks/{id}`
- `toggleLikeCurrent()` — Firestore increment on `prompts/{id}.likes`
- `listenToUserBookmarks(uid)` — real-time listener on `users/{uid}/bookmarks`

### Admin CRUD
- `openAddPromptModal()` — opens the create/edit modal, resets form
- `handleSavePromptForm(e)` — save/update prompt to Firestore, handles Cloudinary upload
- `editPromptAdmin(id)` — populates form for edit
- `approvePromptAdmin(id)` / `rejectPromptAdmin(id)` — update `status` in Firestore
- `deletePromptAdmin(id)` — delete from Firestore
- `bulkApprovePrompts()` / `bulkDeletePrompts()` — batch Firestore operations
- `addNewCategoryAdmin()` — add category to Firestore
- `deleteCategoryAdmin(id)` — delete category from Firestore

### UI Helpers
- `showToast(msg)` — creates toast notification
- `initTypewriter()` — hero search box animated typewriter
- `toggleMobileMenu()` — mobile nav drawer
- `openAiAssistantModal()` / `closeAiAssistantModal()` — AI Builder modal
- `generateAiPromptAssist()` — creates engineered prompt from idea+tool+style inputs
- `closeModal(modalId)` — hides any modal by ID
- `setEventTheme(theme)` — NOT YET IN app.ts (referenced in index.html inline onclick)
- `switchAdminTab(tab)` — NOT YET IN app.ts (referenced in index.html inline onclick)

### Window Globals
- `attachWindowGlobalFunctions()` — runs on module load AND on DOMContentLoaded
  - Exposes: quickSearch, executeSearch, triggerSearchFilter, filterByTool, filterBySort, openPromptDetail, openPromptModal, toggleBookmarkCard, toggleBookmarkCurrentDetail, toggleBookmarkCurrent, toggleLikeCurrent, navigateTo, scrollToSection, toggleMobileMenu, openAiAssistantModal, closeAiAssistantModal, generateAiPromptAssist, handleLiveSearchInput, loadMorePrompts, resetSearchFilters, toggleSelectAllAdminPrompts, copyModalPrompt, toggleAdminView, openAddPromptModal, handleSavePromptForm, editPromptAdmin, approvePromptAdmin, rejectPromptAdmin, deletePromptAdmin, bulkApprovePrompts, bulkDeletePrompts, addNewCategoryAdmin, deleteCategoryAdmin, uploadToCloudinary, openAuthModal, activateDemoAdminSession, handleGoogleSignIn, handleEmailAuthSubmit, handleUserLogout, closeModal, showToast, copyPromptText, copyCurrentDetailPrompt, shareCurrentDetailPrompt, generateInAITool

---

## 8. Functions Missing from app.ts (currently inline/broken)

These are called from `index.html` onclick attributes but are NOT in `src/app.ts`. They exist only in the dead legacy script block (`<script type="text/template">`):

| Function | Location in HTML | Status |
|---|---|---|
| `setEventTheme(theme)` | Hero seasonal theme buttons (line ~378) | ❌ Not in app.ts |
| `switchAdminTab(tab)` | Admin nav tabs (line ~1125) | ❌ Not in app.ts |
| `filterBySort(sortType)` | Home gallery sort select (line ~824) | ❌ Not in app.ts (exists in legacy block only) |
| `copyAiAssistPrompt()` | AI Assistant modal (line ~1807) | ❌ Not in app.ts |
| `saveDataToLocalStorage()` | Used in legacy admin CRUD | ❌ Not in app.ts (legacy, do not re-add) |

---

## 9. Known Issues / Technical Debt

| Issue | Location | Priority |
|---|---|---|
| Admin role check uses hardcoded email `localride369@gmail.com` in `getUserRole()` and `syncUserDoc()` | `firebase.ts` L107, L124 | HIGH — replace with pure Firestore role |
| `uploadToCloudinary()` uses demo cloud (`demo`/`unsigned_preset`) with base64 fallback | `firebase.ts` L142-168 | HIGH — needs real cloud name + preset |
| `activateDemoAdminSession()` injects fake User object | `app.ts` L1161 | HIGH — remove after real auth works |
| `setEventTheme()` not in app.ts — seasonal buttons broken | `index.html` L378 | HIGH — implement in app.ts |
| `switchAdminTab()` not in app.ts — admin tabs broken | `index.html` L1125 | HIGH — implement in app.ts |
| `filterBySort()` not exposed to window via attachWindowGlobalFunctions | `app.ts` | MEDIUM |
| `copyAiAssistPrompt()` not in app.ts | `index.html` AI modal | MEDIUM |
| Legacy script block (lines 1870-3243) never executes but pollutes file | `index.html` | MEDIUM — remove after migration |
| `loadMorePrompts()` duplicates seed data instead of loading from Firestore | `app.ts` L1406 | MEDIUM |
| `renderPopularSearches()` and `renderCollections()` hardcoded | `app.ts` | LOW — acceptable for now |
| No pagination/cursor-based Firestore queries (loads all prompts) | `setupFirestoreListeners()` | MEDIUM |
| No `rankScore` field on prompts — all ranking is client-side | `app.ts` | MEDIUM |
| Admin seeding runs every time collection is empty — no idempotent guard | `setupFirestoreListeners()` | MEDIUM |
| `renderAll()` called on every auth state change (expensive) | `app.ts` L302 | LOW |

---

## 10. Seasonal Theme System

Themes are driven by `setEventTheme(theme)` in `index.html`. The theme buttons call this function with one of:
`'ai_core' | 'ganesh' | 'diwali' | 'christmas' | 'newyear' | 'valentine' | 'holi' | 'eid' | 'raksha' | 'halloween'`

The function must:
1. Update the active button styling
2. Update the hero badge text + gradient
3. Influence ranking/filtering (boost matching category prompts)

The `#hero-event-badge` element and all `.event-theme-btn` buttons are in `index.html`.

---

## 11. Admin Dashboard Structure

The admin view (`#view-admin`) contains:
- Stats row: `#admin-stat-total`, `#admin-stat-pending`, `#admin-stat-approved`, `#admin-stat-rejected`, `#admin-stat-views`, `#admin-stat-downloads`
- Tab buttons: `switchAdminTab('prompts')`, `switchAdminTab('categories')`, `switchAdminTab('analytics')`
- Panels: `#admin-panel-prompts`, `#admin-panel-categories` (hidden by default), `#admin-panel-analytics` (hidden by default)
- Prompts table: `#admin-prompts-tbody` (rendered by `renderAdminTable()`)
- Add/Edit modal: `#add-prompt-modal` with form `#prompt-crud-form`
- Form fields: `#form-prompt-id`, `#form-title`, `#form-tool`, `#form-category`, `#form-image-url`, `#form-image-file`, `#form-prompt-text`

---

## 12. HTML Element ID Registry (critical DOM anchors)

```
Navigation:    navbar-auth-section, mobile-menu, nav-home, nav-search, nav-collections, nav-pricing
Hero:          cursor-glow, hero-event-badge, hero-typewriter-text, hero-search-input
               search-autocomplete, autocomplete-results, hero-popular-chips
Categories:    categories-container, categories-section
Home Layout:   ai-tools-list, trending-section, trending-prompts-container, gallery-tag-pills
               prompts-grid, load-more-btn, popular-searches-list, featured-collections-list
Search:        main-search-page-input, search-category-select, search-tool-select
               search-results-count, search-results-grid
Admin:         admin-stat-total/pending/approved/rejected/views/downloads
               admin-tab-prompts/categories/analytics
               admin-panel-prompts/categories/analytics
               admin-search-input, admin-prompts-tbody, select-all-prompts
               add-prompt-modal, add-modal-title, prompt-crud-form
               form-prompt-id, form-title, form-tool, form-category
               form-image-url, form-image-file, form-prompt-text
Detail View:   detail-breadcrumb-category, detail-breadcrumb-title
               detail-image, detail-image-bg, detail-tool-text, detail-category-badge
               detail-title, detail-creator-name, detail-creator-avatar
               detail-views, detail-likes, detail-downloads, detail-generate-text
               detail-tags-container, detail-full-prompt, detail-char-count
               detail-negative-text, detail-output-samples, detail-tips-list
               detail-related-prompts-grid, rec-trending-today, rec-people-viewed
               rec-recently-added, rec-recommended-for-you
               sidebar-trending-categories, sidebar-popular-tools, sidebar-top-creators
               sidebar-festival-collections, sidebar-business-collections
               mobile-sticky-title, mobile-sticky-tool, mobile-prompt-sticky-bar
               detail-setting-ar, detail-setting-cfg, detail-setting-stylize, detail-setting-model
Modal:         prompt-modal, modal-image, modal-tool, modal-category, modal-title
               modal-prompt-text, modal-negative-prompt, modal-creator-name, modal-creator-avatar
               modal-like-count, modal-bookmark-btn, modal-like-btn
AI Assistant:  ai-assistant-modal, ai-assist-idea, ai-assist-tool, ai-assist-style
               ai-assist-result, ai-assist-output-text
Auth:          auth-modal, auth-title, auth-email-input, auth-password-input
Toast:         toast-container
Event Themes:  event-btn-ai_core, event-btn-ganesh, event-btn-diwali, event-btn-christmas,
               event-btn-newyear, event-btn-valentine, event-btn-holi, event-btn-eid,
               event-btn-raksha, event-btn-halloween
```

---

## 13. Cloudinary Configuration (To Be Set)

The app needs:
- `VITE_CLOUDINARY_CLOUD_NAME` — your Cloudinary cloud name
- `VITE_CLOUDINARY_UPLOAD_PRESET` — an **unsigned** upload preset name

These will be stored in `.env` (gitignored) and accessed via `import.meta.env.VITE_CLOUDINARY_CLOUD_NAME`.

**Current broken state:** `firebase.ts` line 145 uses `'demo'` cloud + `'unsigned_preset'` with base64 fallback.

---

## 14. Completed Phases

_(Update this section after each phase is executed and verified.)_

| Phase | Description | Status |
|---|---|---|
| 0 | Audit, PROJECT_CONTEXT.md, dependency map | ✅ Done |
| 1 | Fix broken functions (setEventTheme, switchAdminTab, filterBySort, copyAiAssistPrompt), fix window globals | ✅ Done |
| 2 | Fix Cloudinary (real cloud name/preset, no base64), fix uploadToCloudinary in firebase.ts | ✅ Done |
| 3 | Fix admin role security (remove hardcoded email, pure Firestore role via Security Rules) | ✅ Done |
| 4 | Implement rankScore precomputation + ranking algorithm in app.ts | ✅ Done |
| 5 | Implement pagination / cursor-based Firestore queries | ✅ Done |
| 6 | Extract CSS from index.html <style> block into src/index.css | ✅ Done |
| 7 | Remove legacy dead script block from index.html (lines 1870–3243) | 🔲 Pending |
| 8 | Extract modules: state.ts, auth.ts, admin.ts, ui.ts, ranking.ts from app.ts | 🔲 Pending |
| 9 | Firestore Security Rules review + deployment | 🔲 Pending |
| 10 | Production build validation + Firebase Hosting deploy | 🔲 Pending |
