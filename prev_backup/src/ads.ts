// =============================================================================
// PROMPTVERSE ADS MODULE — Google AdSense + Sponsored Ads Engine
// Handles ad loading, rendering, tracking, and performance optimization.
// =============================================================================

import {
  db,
  auth,
  optimizeCloudinaryUrl,
} from './firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
  increment,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';

// =============================================================================
// INTERFACES
// =============================================================================

export interface SponsoredAd {
  id: string;
  type: 'banner' | 'prompt-card' | 'category' | 'hero-banner' | 'sidebar' | 'popup';
  title: string;
  description: string;
  imageUrl: string;
  targetUrl: string;
  sponsorName: string;
  sponsorLogo?: string;
  ctaText: string;
  priority: number;
  isActive: boolean;
  startDate: any; // Firestore Timestamp
  endDate: any;   // Firestore Timestamp
  placement: string;
  impressions: number;
  clicks: number;
  createdAt?: any;
  updatedAt?: any;
}

export interface AdSenseConfig {
  publisherId: string;
  autoAdsEnabled: boolean;
  manualSlots: {
    feedInline: string;
    detailBottom: string;
    searchBottom: string;
    sidebarWidget: string;
    footerBanner: string;
  };
}

// =============================================================================
// STATE
// =============================================================================

let adsenseConfig: AdSenseConfig | null = null;
let sponsoredAdsCache: SponsoredAd[] = [];
let adsenseScriptLoaded = false;
let adObserver: IntersectionObserver | null = null;
const trackedImpressions = new Set<string>(); // Prevent duplicate impression tracking
const pendingImpressionWrites: { adId: string; timestamp: number }[] = [];
let impressionFlushTimer: ReturnType<typeof setTimeout> | null = null;

// =============================================================================
// ADSENSE INITIALIZATION
// =============================================================================

/**
 * Loads AdSense config from Firestore settings/adsense and initializes.
 * Uses requestIdleCallback/setTimeout for deferred loading to avoid blocking paint.
 */
export async function initAdSense(): Promise<void> {
  try {
    const configSnap = await getDoc(doc(db, 'settings', 'adsense'));
    if (configSnap.exists()) {
      adsenseConfig = configSnap.data() as AdSenseConfig;
    }
  } catch (err) {
    console.warn('[Ads] Could not load AdSense config:', err);
  }

  if (!adsenseConfig?.publisherId) {
    console.info('[Ads] No AdSense publisher ID configured. Skipping AdSense init.');
    return;
  }

  // Deferred script injection — load after main content is interactive
  const loadScript = () => {
    if (adsenseScriptLoaded) return;
    adsenseScriptLoaded = true;

    // Check if script already exists in document head to avoid duplicates
    if (document.querySelector('script[src*="adsbygoogle.js"]')) {
      if (adsenseConfig!.autoAdsEnabled) {
        console.info('[Ads] Auto Ads enabled via publisher script.');
      }
      return;
    }

    const script = document.createElement('script');
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adsenseConfig!.publisherId}`;
    document.head.appendChild(script);

    // If Auto Ads is enabled, the script handles everything
    if (adsenseConfig!.autoAdsEnabled) {
      console.info('[Ads] Auto Ads enabled via publisher script.');
    }
  };

  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(loadScript, { timeout: 3000 });
  } else {
    setTimeout(loadScript, 2000);
  }
}

// =============================================================================
// SPONSORED ADS — FIRESTORE LOADING
// =============================================================================

/**
 * Loads all active, currently-scheduled sponsored ads from Firestore.
 * Results are cached for the session to minimize reads.
 */
export async function loadActiveAds(): Promise<SponsoredAd[]> {
  if (sponsoredAdsCache.length > 0) return sponsoredAdsCache;

  try {
    const q = query(
      collection(db, 'sponsoredAds'),
      where('isActive', '==', true),
      orderBy('priority', 'desc')
    );
    const snap = await getDocs(q);
    const now = new Date();

    sponsoredAdsCache = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as SponsoredAd))
      .filter(ad => {
        const start = ad.startDate?.toDate ? ad.startDate.toDate() : new Date(ad.startDate);
        const end = ad.endDate?.toDate ? ad.endDate.toDate() : new Date(ad.endDate);
        return start <= now && end >= now;
      });

    return sponsoredAdsCache;
  } catch (err) {
    console.warn('[Ads] Failed to load sponsored ads:', err);
    return [];
  }
}

/**
 * Invalidate the sponsored ads cache (call after admin CRUD operations).
 */
export function invalidateAdCache(): void {
  sponsoredAdsCache = [];
}

/**
 * Get scheduled ads for a specific placement.
 */
export function getScheduledAds(placement: string): SponsoredAd[] {
  return sponsoredAdsCache.filter(ad => ad.placement === placement);
}

// =============================================================================
// AD RENDERING — SPONSORED BANNERS
// =============================================================================

/**
 * Renders a sponsored banner into a container element.
 * Includes "Sponsored" label for AdSense policy compliance.
 */
export function renderSponsoredBanner(ad: SponsoredAd, containerId: string): void {
  const container = document.getElementById(containerId);
  if (!container) return;

  const imgUrl = ad.imageUrl ? optimizeCloudinaryUrl(ad.imageUrl, 800) : '';
  const logoUrl = ad.sponsorLogo ? optimizeCloudinaryUrl(ad.sponsorLogo, 100) : '';

  container.innerHTML = `
    <div class="ad-sponsored-banner group relative bg-gradient-to-r from-blue-50/80 via-white to-indigo-50/80 rounded-3xl p-5 border border-blue-200/80 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4 transition hover:shadow-md"
         data-ad-id="${ad.id}" data-ad-tracked="false">
      <span class="ad-sponsored-label">Sponsored</span>
      <div class="flex items-center gap-3.5">
        ${imgUrl ? `
          <div class="w-12 h-12 rounded-2xl overflow-hidden shrink-0 shadow-md border border-slate-200/60">
            <img src="${imgUrl}" alt="${ad.sponsorName}" class="w-full h-full object-cover" loading="lazy" />
          </div>
        ` : `
          <div class="w-12 h-12 rounded-2xl bg-blue-600 text-white font-bold flex items-center justify-center text-lg shrink-0 shadow-md shadow-blue-500/20">
            <i data-lucide="zap" class="w-6 h-6"></i>
          </div>
        `}
        <div>
          <div class="flex items-center gap-2 flex-wrap">
            ${logoUrl ? `<img src="${logoUrl}" alt="${ad.sponsorName}" class="h-4 rounded" loading="lazy" />` : ''}
            <h4 class="font-bold text-sm text-slate-900">${escapeHtml(ad.title)}</h4>
          </div>
          <p class="text-xs text-slate-600 mt-0.5 line-clamp-2">${escapeHtml(ad.description)}</p>
        </div>
      </div>
      <a href="${escapeHtml(ad.targetUrl)}" target="_blank" rel="noopener noreferrer sponsored"
         onclick="event.stopPropagation(); window.__pvAdClick && window.__pvAdClick('${ad.id}')"
         class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow transition shrink-0 inline-flex items-center gap-1.5">
        ${escapeHtml(ad.ctaText || 'Learn More')}
        <i data-lucide="external-link" class="w-3 h-3"></i>
      </a>
    </div>
  `;

  // Re-render Lucide icons in the new content
  try { (window as any).lucide?.createIcons(); } catch (_) {}

  // Set up impression tracking for this banner
  observeAdElement(container.querySelector('[data-ad-id]') as HTMLElement, ad.id);
}

/**
 * Renders a sponsored prompt card that blends with existing prompt cards.
 * Returns the HTML string for injection into the masonry grid.
 */
export function renderSponsoredPromptCard(ad: SponsoredAd): string {
  const imgUrl = ad.imageUrl ? optimizeCloudinaryUrl(ad.imageUrl, 400) : 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=400&q=80';

  return `
    <div class="break-inside-avoid mb-5 ad-sponsored-card" data-ad-id="${ad.id}" data-ad-tracked="false">
      <div class="bg-white rounded-2xl overflow-hidden border border-blue-200/80 shadow-card hover:shadow-card-hover transition-all duration-300 group cursor-pointer relative">
        <span class="ad-sponsored-label">Sponsored</span>
        <a href="${escapeHtml(ad.targetUrl)}" target="_blank" rel="noopener noreferrer sponsored"
           onclick="window.__pvAdClick && window.__pvAdClick('${ad.id}')">
          <div class="relative aspect-[4/3] overflow-hidden bg-slate-100">
            <img src="${imgUrl}" alt="${escapeHtml(ad.title)}" 
                 class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                 loading="lazy" />
            <div class="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
          </div>
          <div class="p-4 space-y-2">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-blue-100 text-blue-700 uppercase">Sponsored</span>
              ${ad.sponsorName ? `<span class="text-[10px] text-slate-400 font-semibold">by ${escapeHtml(ad.sponsorName)}</span>` : ''}
            </div>
            <h3 class="font-bold text-sm text-slate-900 leading-snug line-clamp-2">${escapeHtml(ad.title)}</h3>
            <p class="text-xs text-slate-500 line-clamp-2">${escapeHtml(ad.description)}</p>
            <div class="pt-2 border-t border-slate-100">
              <span class="text-xs font-bold text-blue-600 flex items-center gap-1">
                ${escapeHtml(ad.ctaText || 'Learn More')}
                <i data-lucide="arrow-right" class="w-3 h-3"></i>
              </span>
            </div>
          </div>
        </a>
      </div>
    </div>
  `;
}

// =============================================================================
// AD RENDERING — ADSENSE UNITS
// =============================================================================

/**
 * Creates a responsive AdSense ad unit in a container.
 * Wraps in CLS-safe container with reserved height.
 */
export function renderAdSenseUnit(
  slotId: string | undefined,
  containerId: string,
  format: 'auto' | 'fluid' | 'rectangle' | 'horizontal' = 'auto',
  minHeight = 90
): void {
  if (!slotId || !adsenseConfig?.publisherId) return;

  const container = document.getElementById(containerId);
  if (!container) return;

  container.style.minHeight = `${minHeight}px`;
  container.innerHTML = `
    <div class="ad-adsense-wrapper" style="min-height:${minHeight}px; display:flex; align-items:center; justify-content:center;">
      <ins class="adsbygoogle"
           style="display:block; width:100%;"
           data-ad-client="${adsenseConfig.publisherId}"
           data-ad-slot="${slotId}"
           data-ad-format="${format}"
           data-full-width-responsive="true"></ins>
    </div>
  `;

  // Push the ad only when AdSense script is loaded
  try {
    ((window as any).adsbygoogle = (window as any).adsbygoogle || []).push({});
  } catch (err) {
    console.warn('[Ads] AdSense push failed:', err);
  }
}

// =============================================================================
// AD TRACKING — IMPRESSIONS & CLICKS
// =============================================================================

/**
 * Track an impression for a sponsored ad.
 * Uses debounced batch writes to avoid excessive Firestore calls.
 */
export function trackImpression(adId: string): void {
  if (trackedImpressions.has(adId)) return;
  trackedImpressions.add(adId);

  pendingImpressionWrites.push({ adId, timestamp: Date.now() });

  // Debounce: flush after 2 seconds of inactivity
  if (impressionFlushTimer) clearTimeout(impressionFlushTimer);
  impressionFlushTimer = setTimeout(flushImpressions, 2000);
}

async function flushImpressions(): Promise<void> {
  const batch = [...pendingImpressionWrites];
  pendingImpressionWrites.length = 0;

  for (const { adId } of batch) {
    try {
      // Increment impression counter on the ad document
      await updateDoc(doc(db, 'sponsoredAds', adId), {
        impressions: increment(1),
      });

      // Log the event
      await addDoc(collection(db, 'adEvents'), {
        adId,
        type: 'impression',
        userId: auth.currentUser?.uid || null,
        timestamp: serverTimestamp(),
        page: window.location.hash || '#home',
      });
    } catch (err) {
      // Silent — non-critical analytics
    }
  }
}

/**
 * Track a click on a sponsored ad and increment click counter.
 * Exposed to window as window.__pvAdClick for onclick handlers.
 */
export async function trackClick(adId: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'sponsoredAds', adId), {
      clicks: increment(1),
    });

    await addDoc(collection(db, 'adEvents'), {
      adId,
      type: 'click',
      userId: auth.currentUser?.uid || null,
      timestamp: serverTimestamp(),
      page: window.location.hash || '#home',
    });
  } catch (err) {
    // Silent — non-critical
  }
}

// =============================================================================
// INTERSECTION OBSERVER — LAZY LOADING & IMPRESSION TRACKING
// =============================================================================

/**
 * Sets up IntersectionObserver for all ad containers.
 * Ads are rendered/loaded only when their container enters the viewport.
 */
export function setupAdObservers(): void {
  if (adObserver) adObserver.disconnect();

  adObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target as HTMLElement;
          const adId = el.dataset.adId;
          const placement = el.dataset.adPlacement;

          // Track impression for sponsored ads
          if (adId && el.dataset.adTracked !== 'true') {
            trackImpression(adId);
            el.dataset.adTracked = 'true';
          }

          // Lazy-load AdSense unit if not yet loaded
          if (placement && !el.dataset.adLoaded) {
            el.dataset.adLoaded = 'true';
            loadAdForPlacement(placement, el.id);
          }
        }
      });
    },
    {
      rootMargin: '200px 0px', // Start loading 200px before viewport
      threshold: 0.1,
    }
  );

  // Observe all ad containers
  document.querySelectorAll('.ad-container, [data-ad-id]').forEach(el => {
    adObserver!.observe(el);
  });
}

/**
 * Observe a specific ad element for impression tracking.
 */
function observeAdElement(el: HTMLElement | null, adId: string): void {
  if (!el || !adObserver) return;
  el.dataset.adId = adId;
  adObserver.observe(el);
}

/**
 * Load the appropriate ad for a given placement.
 */
async function loadAdForPlacement(placement: string, containerId: string): Promise<void> {
  // First try sponsored ads
  const ads = await loadActiveAds();
  const matchingAd = ads.find(a => a.placement === placement);

  if (matchingAd) {
    renderSponsoredBanner(matchingAd, containerId);
    return;
  }

  // Fallback to AdSense if configured
  if (adsenseConfig?.publisherId) {
    const slotMap: Record<string, string | undefined> = {
      'detail-after-prompt': adsenseConfig.manualSlots?.detailBottom,
      'search-bottom': adsenseConfig.manualSlots?.searchBottom,
      'sidebar': adsenseConfig.manualSlots?.sidebarWidget,
      'footer-banner': adsenseConfig.manualSlots?.footerBanner,
      'feed-inline': adsenseConfig.manualSlots?.feedInline,
    };
    const slotId = slotMap[placement];
    if (slotId) {
      renderAdSenseUnit(slotId, containerId, 'auto', 90);
    }
  }
}

// =============================================================================
// FEED AD INJECTION — Insert ads between prompt cards
// =============================================================================

/**
 * Injects sponsored cards and/or AdSense units between prompt cards in a masonry grid.
 * Called after renderPromptsGallery() or equivalent.
 * @param containerId — ID of the grid container (e.g., 'prompts-grid')
 * @param interval — Insert an ad every N cards (default: 8)
 */
export async function injectFeedAds(containerId: string, interval = 8): Promise<void> {
  const container = document.getElementById(containerId);
  if (!container) return;

  const cards = container.querySelectorAll(':scope > .break-inside-avoid:not(.ad-sponsored-card)');
  if (cards.length < interval) return; // Not enough cards for ad insertion

  const ads = await loadActiveAds();
  const feedAds = ads.filter(a => a.placement === 'feed-inline' || a.type === 'prompt-card');

  let adIndex = 0;

  // Remove any previously injected feed ads
  container.querySelectorAll('.ad-sponsored-card, .ad-feed-adsense').forEach(el => el.remove());

  // Insert ads after every `interval` cards
  for (let i = interval; i < cards.length; i += interval + 1) {
    const referenceCard = cards[i];
    if (!referenceCard) break;

    if (adIndex < feedAds.length) {
      // Insert sponsored card
      const adHtml = renderSponsoredPromptCard(feedAds[adIndex]);
      const wrapper = document.createElement('div');
      wrapper.innerHTML = adHtml;
      const adEl = wrapper.firstElementChild as HTMLElement;
      if (adEl) {
        referenceCard.parentNode?.insertBefore(adEl, referenceCard);
        observeAdElement(adEl, feedAds[adIndex].id);
      }
      adIndex++;
    } else if (adsenseConfig?.manualSlots?.feedInline) {
      // Insert AdSense unit
      const adsenseContainer = document.createElement('div');
      adsenseContainer.className = 'break-inside-avoid mb-5 ad-feed-adsense';
      adsenseContainer.id = `ad-feed-adsense-${i}`;
      adsenseContainer.style.minHeight = '250px';
      referenceCard.parentNode?.insertBefore(adsenseContainer, referenceCard);
      renderAdSenseUnit(adsenseConfig.manualSlots.feedInline, adsenseContainer.id, 'fluid', 250);
    }
  }

  // Re-render Lucide icons for injected content
  try { (window as any).lucide?.createIcons(); } catch (_) {}
}

// =============================================================================
// PLACEMENT-SPECIFIC RENDERERS
// =============================================================================

/**
 * Render ads on the prompt detail page.
 */
export async function renderDetailPageAds(): Promise<void> {
  const ads = await loadActiveAds();

  // Sponsored banner after prompt content
  const afterPromptAd = ads.find(a => a.placement === 'detail-after-prompt');
  if (afterPromptAd) {
    renderSponsoredBanner(afterPromptAd, 'ad-detail-after-prompt');
  } else {
    renderAdSenseUnit(adsenseConfig?.manualSlots?.detailBottom, 'ad-detail-after-prompt', 'auto', 90);
  }

  // Native sponsored cards in detail page
  const nativeAds = ads.filter(a => a.placement === 'detail-native-1' || a.placement === 'detail-native-2');
  if (nativeAds[0]) renderSponsoredBanner(nativeAds[0], 'ad-detail-sponsored-1');
  if (nativeAds[1]) renderSponsoredBanner(nativeAds[1], 'ad-detail-sponsored-2');
}

/**
 * Render ad below search results.
 */
export async function renderSearchAds(): Promise<void> {
  const ads = await loadActiveAds();
  const searchAd = ads.find(a => a.placement === 'search-bottom');

  if (searchAd) {
    renderSponsoredBanner(searchAd, 'ad-search-bottom');
  } else {
    renderAdSenseUnit(adsenseConfig?.manualSlots?.searchBottom, 'ad-search-bottom', 'auto', 90);
  }
}

/**
 * Render sidebar ad widget.
 */
export async function renderSidebarAds(): Promise<void> {
  const ads = await loadActiveAds();
  const sidebarAd = ads.find(a => a.placement === 'sidebar');

  if (sidebarAd) {
    renderSponsoredBanner(sidebarAd, 'ad-sidebar-widget');
  } else {
    renderAdSenseUnit(adsenseConfig?.manualSlots?.sidebarWidget, 'ad-sidebar-widget', 'rectangle', 250);
  }
}

/**
 * Render footer banner ad.
 */
export async function renderFooterAds(): Promise<void> {
  const ads = await loadActiveAds();
  const footerAd = ads.find(a => a.placement === 'footer-banner');

  if (footerAd) {
    renderSponsoredBanner(footerAd, 'ad-footer-banner');
  } else {
    renderAdSenseUnit(adsenseConfig?.manualSlots?.footerBanner, 'ad-footer-banner', 'horizontal', 90);
  }
}

// =============================================================================
// INITIALIZATION — Master init function
// =============================================================================

/**
 * Master initialization function. Call this from app.ts on DOMContentLoaded.
 */
export async function initAdsSystem(): Promise<void> {
  // Expose click handler globally for onclick attributes
  (window as any).__pvAdClick = trackClick;

  // Initialize AdSense (deferred)
  await initAdSense();

  // Load sponsored ads from Firestore
  await loadActiveAds();

  // Setup IntersectionObserver for lazy loading
  setupAdObservers();

  // Render placement-specific ads
  renderSidebarAds();
  renderFooterAds();

  console.info(`[Ads] System initialized. ${sponsoredAdsCache.length} active sponsored ads loaded.`);
}

// =============================================================================
// UTILITY
// =============================================================================

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
