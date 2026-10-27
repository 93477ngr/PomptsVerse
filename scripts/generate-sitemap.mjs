import { writeFileSync } from 'fs';

const BASE_URL = 'https://promptsone.com';

const staticRoutes = [
  '/',
  '/search',
  '/collections',
  '/blog',
  '/about',
  '/privacy',
  '/terms',
  '/cookies',
  '/contact',
  '/docs'
];

export function buildSitemapXml(urls = []) {
  const allUrls = [...staticRoutes, ...urls];
  const now = new Date().toISOString().split('T')[0];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls.map(path => `  <url>
    <loc>${BASE_URL}${path}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${path === '/' ? '1.0' : '0.8'}</priority>
  </url>`).join('\n')}
</urlset>`;

  return xml;
}

try {
  const xmlContent = buildSitemapXml();
  writeFileSync('public/sitemap.xml', xmlContent);
  console.log('Successfully generated public/sitemap.xml');
} catch (err) {
  console.warn('Sitemap generation notice:', err);
}
