# PROJECT_CONTEXT.md — PromptsOne / PromptsVerse AI

> **Last Updated**: October 2026 — Master Prompt Full Audit, Bug Fix & Production Hardening Completed.

---

## 1. What This Project Is

**PromptsOne** (PromptsVerse AI) — A production-grade, single-page AI prompt search engine ("Google for AI Prompts"). Users discover, search, bookmark, copy, and share AI-generation prompts for engines like ChatGPT, Midjourney, Flux, Gemini, Claude, Ideogram, Leonardo AI, and Sora. Includes a separate, dedicated Admin Control Panel at `/admin` (`admin.html`).

---

## 2. Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Vanilla TypeScript (ES2020) |
| Build Tool | Vite 6 + `@tailwindcss/vite` plugin |
| CSS | Tailwind CSS v4 (`@import "tailwindcss";` in `src/index.css`) |
| Icons | Lucide icons (`lucide` npm package, tree-shaken with `createIcons`) |
| Routing | History API with real path routing (`src/router.ts`) |
| Auth | Firebase Authentication (Email/Password + Google Popup/Redirect fallback) |
| Database | Firebase Firestore (hardened rules, composite indexing) |
| Hosting | Firebase Hosting (`dist/` with CSP, security headers, SPA rewrites) |
| Images | Cloudinary (unsigned upload helper + responsive transformations) |
| XSS Protection | DOMPurify + HTML escaping utilities (`src/utils/dom.ts`) |
| Analytics | Firebase Analytics (guarded with `isSupported()`) |
| Fonts | Plus Jakarta Sans & JetBrains Mono (Google Fonts) |

---

## 3. File & Directory Map

```
/
├── index.html            ← PUBLIC SITE ENTRY (Navbar, gallery, detail view, search, modals, footer)
├── admin.html            ← ADMIN CONTROL PANEL ENTRY (Login, overview, prompt/category CRUD, logs)
├── firestore.rules       ← HARDENED FIRESTORE SECURITY RULES (status restrictions, counter limits)
├── firestore.indexes.json← FIRESTORE COMPOSITE INDEXES (prompts, collections, ads, media)
├── firebase.json         ← FIREBASE HOSTING (CSP, security headers, SPA rewrites)
├── vite.config.ts        ← VITE 6 CONFIG (Vite MPA build, vendor chunking)
├── package.json          ← DEPS (Firebase v12, Tailwind v4, Vite 6, Lucide, DOMPurify)
│
├── src/
│   ├── app.ts            ← PUBLIC SITE APPLICATION MODULE
│   ├── admin.ts          ← ADMIN PANEL APPLICATION MODULE
│   ├── auth.ts           ← AUTHENTICATION ENGINE (Email/Pass + Google Popup/Redirect)
│   ├── router.ts         ← HISTORY API ROUTER & SESSION VIEW GUARD
│   ├── firebase.ts       ← FIREBASE & CLOUDINARY INTEGRATION
│   ├── ads.ts            ← MONETIZATION ENGINE (AdSense + Sponsored Ads)
│   ├── index.css         ← TAILWIND V4 STYLESHEET & BRAND DESIGN SYSTEM
│   └── utils/
│       └── dom.ts        ← XSS ESCAPING, SANITIZATION & SAFE DOM HELPERS
│
└── scripts/
    ├── set-admin.mjs     ← CLI SCRIPT TO SET ADMIN CUSTOM CLAIMS
    └── generate-sitemap.mjs ← SITEMAP BUILD GENERATOR
```

---

## 4. Application Views & Routing Table

Driven by `src/router.ts` with browser History API (`pushState`/`popstate`).

| Path | View ID | Description |
|---|---|---|
| `/` | `view-home` | Hero, category pills, trending, feed, bottom stats |
| `/search` | `view-search` | Advanced search engine with filter selects & keyword query (`?q=`) |
| `/prompt/:id` | `view-details` | Dedicated prompt detail page (image preview, 1-click copy, WhatsApp share, studio palette switcher, related prompts) |
| `/collections` | `view-collections` | Curated collection bundles |
| `/blog` | `view-blog` | Blog post list |
| `/blog/:slug` | `view-blog-detail` | Blog post detail view |
| `/dashboard` | `view-dashboard` | Creator workspace (my submissions & user prompt CRUD) |
| `/about` | `view-about` | About PromptsOne |
| `/privacy` | `view-privacy` | Privacy Policy |
| `/terms` | `view-terms` | Terms of Service |
| `/cookies` | `view-cookies` | Cookie Policy |
| `/contact` | `view-contact` | Contact form & office details |
| `/docs` | `view-docs` | Help Center & FAQ |
| `/admin` | `admin.html` | Separate Admin Control Panel |

---

## 5. Audit & Master Fix Progress Summary

| Phase | Task | Status |
|---|---|---|
| Phase 1 | History API Routing, Card Clickability, `handleSavePromptForm`, Firestore Composite Indexes, Guarded Analytics | ✅ Completed & Verified |
| Phase 2 | Authentication End-to-End (Login/Signup toggle, Google Redirect Fallback, Admin Custom Claims) | ✅ Completed & Verified |
| Phase 3 | Security Hardening (Firestore rules rewrite, XSS escaping with DOMPurify, CSP & security headers) | ✅ Completed & Verified |
| Phase 4 | Performance & Loading (Tailwind v4 native build, npm Lucide icons, bundle splitting, pruned React deps) | ✅ Completed & Verified |
| Phase 5 | Responsive UI / UX (Mobile drawer sidebar, touch targets, 100dvh layouts, studio palette switcher) | ✅ Completed & Verified |
| Phase 6 | SEO & Deployment Pipeline (Dynamic Sitemap Generator, custom claims script, build verification) | ✅ Completed & Verified |
| Phase 7 | Code Structure & Cleanup (Deleted React boilerplate, modularized router/auth/dom/ads) | ✅ Completed & Verified |

---

## 6. Verification Status

- `npm run lint` (`tsc --noEmit`): **Passed with 0 errors**
- `npm run build` (`vite build`): **Passed with 0 errors**
- Applet Compilation: **Build succeeded**
