/**
 * Prerenders every route into dist/ from the built shell (dist/index.html), using the same page modules as the client.
 * Text is rendered as of the build date; charts are drawn on load, and nothing on the page is replaced when the client
 * boots on the same route. Also writes the sitemap, robots.txt, 404.html, the Markdown mirror of each country page with
 * llms-full.txt, and the security headers (with the CSP hash of the inline theme script). Usage: node scripts/prerender.ts
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseHTML } from 'linkedom';
import { buildAtlas } from './build-atlas.ts';
import { CODES, GENERATED, META, MODEL, bps, fmtD, fmtNext, initAtlas, lede, stanceOfPlay, upcoming, vText, voteText } from '../src/lib/atlas.ts';
import { DEFAULT_CC } from '../src/app/shell.ts';
import type { Code } from '../src/lib/atlas.ts';

export const SITE = 'https://rates.ashwingopalsamy.in';
const DIST = new URL('../dist/', import.meta.url).pathname;
/** The repository's current name. GitHub redirects the old one, but the links here should not depend on that. */
const REPO = 'https://github.com/ashwingopalsamy/policy-rates-atlas';
/** The author as one entity, the same node the owner's other sites publish, so search and answer engines see one person. */
const PERSON = { '@type': 'Person', '@id': 'https://ashwingopalsamy.in/#person', name: 'Ashwin Gopalsamy', url: 'https://ashwingopalsamy.in', sameAs: ['https://github.com/ashwingopalsamy', 'https://www.linkedin.com/in/ashwingopalsamy', 'https://x.com/ashwin2125'] };
const OG_IMAGE = `${SITE}/og/home.png`;
const OG_ALT = 'Policy Rate Atlas: central bank policy rates for seven economies';

type Route = { path: string; page: 'world' | 'country' | 'privacy' | 'design' | 'notfound'; cc: Code | null; file: string };
const strip = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** JSON safe inside a <script> element: no "</script" or "<!--" can be formed. */
export const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const countryUrl = (c: Code) => SITE + (c === DEFAULT_CC ? '/' : `/${c.toLowerCase()}/`);
/** The default country's page lives at /, so /in/ points search engines there. */
const canonicalOf = (r: Route) => (r.page === 'country' && r.cc ? countryUrl(r.cc) : SITE + r.path);
/** The Markdown mirror of a country page. The default country's page is the home page, so it mirrors as /index.md. */
const mirrorOf = (c: Code) => (c === DEFAULT_CC ? '/index.md' : `/${c.toLowerCase()}.md`);
const siteDescription = () => `Policy rates for ${CODES.length} central banks, every move since 2000, checked against official sources, with the findings that matter for borrowers and markets.`;

/** A country page as Markdown. Every figure comes from the model the page renders from; nothing is typed in here. */
export function countryMarkdown(c: Code): string {
  const m = META[c], md = MODEL[c], last = md.policyMoves[md.policyMoves.length - 1], dec = last.decision, lc = c.toLowerCase();
  const date = (iso: string) => fmtD(iso, c), nx = upcoming(c)[0], next = nx ? fmtNext(nx, c) : null, v = voteText(dec?.vote ?? null);
  const change = last.action === 'framework' ? `target range introduced ${date(last.date)}: ${vText(last)}`
    : `${bps(last.chg)} to ${vText(last)}, from ${vText(last.prev)}; ${dec ? `decided ${date(dec.date)}${dec.effective && dec.effective !== dec.date ? `, effective ${date(dec.effective)}` : ''}` : `effective ${date(last.date)}`}`;
  const recent = md.policyMoves.slice(-10).reverse().map(x => `- ${date(x.date)}: ${x.action === 'framework' ? `target range ${vText(x)}` : `${bps(x.chg)} to ${vText(x)}`}`);
  return [
    `# ${m.name}: ${m.inst.toLowerCase()} ${vText(md.last)}`, '',
    `Canonical: ${countryUrl(c)}`,
    `Data as of ${fmtD(GENERATED, 'GB')}. Independent of the ${m.bank}; not affiliated with, authorised by or endorsed by it.`, '',
    strip(lede(c)), '',
    '## Position',
    `- Level: ${vText(md.last)}`,
    `- Last change: ${change}`,
    ...(v ? [`- Vote: ${v.tally} (${v.sub.toLowerCase()})`] : []),
    ...(dec?.stance ? [`- Stance: ${dec.stance}`] : []),
    `- Cycle: ${stanceOfPlay(c).txt}`,
    `- Next decision: ${next ? `${next.date}, ${next.time} (${next.inText})` : 'not on our calendar yet'}`,
    ...(dec?.excerpt ? ['', `> ${dec.excerpt}`, `> ${m.body}, ${date(dec.date)}`] : []),
    '', '## Recent moves, newest first', ...recent, '',
    '## Data',
    `- Current release (JSON): ${SITE}/api/v1/countries/${lc}.json`,
    `- Change points (CSV): ${SITE}/api/v1/countries/${lc}/series.csv`,
    `- Decisions (CSV): ${SITE}/api/v1/countries/${lc}/decisions.csv`,
    `- Release ${md.release}, from ${md.sources} official sources`,
    ...(dec?.url ? [`- Latest ${m.doc ?? 'release'}: ${dec.url}`] : []),
    '', '## Licence',
    `- The figures are published records. No blanket licence is asserted for them, and publisher terms apply: ${REPO}/blob/main/DATA-LICENSE.md`,
    '- Nothing here is a forecast.', '',
  ].join('\n');
}

/** Every country page in one file, for agents that read a single document. */
export function llmsFull(): string {
  return [
    '# Policy Rate Atlas: full text', '',
    `> Central bank policy rates for ${CODES.length} economies, computed from the published records shown on each page. The open JSON and CSV API under ${SITE}/api/v1/ is the primary machine interface. Index: ${SITE}/llms.txt`,
    ...CODES.map(c => `\n---\n\n${countryMarkdown(c)}`),
  ].join('\n');
}

/** The <head> tags for one route: description, robots, canonical, Markdown mirror, Open Graph, Twitter and JSON-LD. */
function head(r: Route, title: string): string {
  const url = canonicalOf(r), personId = PERSON['@id'], siteId = `${SITE}/#site`, description = siteDescription();
  const pageDescription = r.page === 'country' && r.cc ? strip(lede(r.cc))
    : r.page === 'privacy' ? 'What Policy Rate Atlas counts, how long it is kept and how to switch it off. No cookies and no personal data.'
    : r.page === 'design' ? 'The colours, type, components and rules Policy Rate Atlas is built from, rendered with the live stylesheet.'
    : description;
  const mirror = r.page === 'country' && r.cc ? mirrorOf(r.cc) : null;
  const page = r.page === 'country' && r.cc ? {
    '@type': 'Dataset', name: `${META[r.cc].bank} ${META[r.cc].inst.toLowerCase()} history`, description: pageDescription, url,
    license: `${REPO}/blob/main/DATA-LICENSE.md`, isAccessibleForFree: true, spatialCoverage: META[r.cc].name,
    temporalCoverage: `2000-01-01/${MODEL[r.cc].last.date}`, creator: { '@id': personId }, publisher: { '@id': personId },
    isBasedOn: META[r.cc].bank, isPartOf: { '@id': siteId },
    distribution: [
      { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${SITE}/api/v1/countries/${r.cc.toLowerCase()}.json` },
      { '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: `${SITE}/api/v1/countries/${r.cc.toLowerCase()}/series.csv` },
    ],
  } : r.page === 'world' ? {
    '@type': 'CollectionPage', name: title, description: pageDescription, url, isPartOf: { '@id': siteId },
    mainEntity: { '@type': 'ItemList', itemListElement: CODES.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: META[c].name, url: countryUrl(c) })) },
  } : r.page === 'privacy' || r.page === 'design' ? { '@type': 'WebPage', name: title, description: pageDescription, url, isPartOf: { '@id': siteId } } : null;
  const graph = page && { '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebSite', '@id': siteId, name: 'Policy Rate Atlas', url: `${SITE}/`, description, inLanguage: 'en', publisher: { '@id': personId } },
    { '@type': 'WebApplication', '@id': `${SITE}/#app`, name: 'Policy Rate Atlas', url: `${SITE}/`, description, applicationCategory: 'FinanceApplication', operatingSystem: 'Any', browserRequirements: 'Requires JavaScript', isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, license: 'https://opensource.org/licenses/MIT', author: { '@id': personId } },
    PERSON,
    page,
  ] };
  return [
    `<meta name="description" content="${attr(pageDescription)}" />`,
    r.page === 'notfound' ? '<meta name="robots" content="noindex" />' : '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />',
    r.page === 'notfound' ? '' : `<link rel="canonical" href="${url}" />`,
    mirror ? `<link rel="alternate" type="text/markdown" href="${mirror}" title="Markdown" />` : '',
    `<meta property="og:type" content="website" />`, `<meta property="og:site_name" content="Policy Rate Atlas" />`,
    `<meta property="og:title" content="${attr(title)}" />`, `<meta property="og:description" content="${attr(pageDescription)}" />`, `<meta property="og:url" content="${url}" />`,
    `<meta property="og:locale" content="en" />`,
    `<meta property="og:image" content="${OG_IMAGE}" />`, `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1200" />`, `<meta property="og:image:height" content="630" />`, `<meta property="og:image:alt" content="${attr(OG_ALT)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`, `<meta name="twitter:site" content="@ashwin2125" />`, `<meta name="twitter:creator" content="@ashwin2125" />`,
    `<meta name="twitter:title" content="${attr(title)}" />`, `<meta name="twitter:description" content="${attr(pageDescription)}" />`,
    `<meta name="twitter:image" content="${OG_IMAGE}" />`, `<meta name="twitter:image:alt" content="${attr(OG_ALT)}" />`,
    graph ? `<script type="application/ld+json">${scriptJson(graph)}</script>` : '',
  ].filter(Boolean).join('\n    ');
}

/** Renders one route by running the page modules against a server-side DOM built from the shell. */
async function render(shell: string, r: Route, state: string): Promise<string> {
  const { document, window } = parseHTML(shell);
  Object.assign(globalThis, { document, window });
  const dom = await import('../src/app/dom.ts'), shellMod = await import('../src/app/shell.ts'), country = await import('../src/app/country.ts');
  const { makeIcons } = await import('../src/lib/icons.ts');
  Object.assign(dom.state, { ssr: true, page: r.page, curSec: null, dday: 'live' });
  if (r.cc) dom.state.code = r.cc;
  const host = document.getElementById('page')!;
  host.innerHTML = shellMod.pageHTML(r.page);
  host.dataset.route = shellMod.routeKey({ page: r.page, cc: r.cc });
  country.renderChip();
  if (r.page === 'country') country.renderCountry();
  else if (r.page === 'world') (await import('../src/app/world.ts')).renderWorld(false);
  else if (r.page === 'privacy') (await import('../src/app/privacy.ts')).renderPrivacy();
  else if (r.page === 'design') (await import('../src/app/design.ts')).renderDesign();
  else (await import('../src/app/notfound.ts')).renderNotFound();
  shellMod.setRail();
  makeIcons(document);
  const title = document.title;
  let html = document.toString();
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${attr(title).replace(/&quot;/g, '"')}</title>`);
  html = html.replace(/<meta name="description"[^>]*>/, '');
  html = html.replace('<!--app-head-->', head(r, title));
  html = html.replace('<!--app-data-->', `<script type="application/json" id="atlas-state">${state}</script>`);
  html = html.replace('<!--app-html-->', '');
  if (!/^<!doctype html>/i.test(html)) html = '<!doctype html>\n' + html;
  return html;
}

/** The security headers. The CSP allows only this origin plus the Cloudflare Web Analytics beacon. */
export function headers(inlineScripts: string[], markdown: string[] = []): string {
  const hashes = inlineScripts.map(s => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' ');
  const csp = [
    "default-src 'self'", `script-src 'self' ${hashes} https://static.cloudflareinsights.com`, "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", "connect-src 'self' https://cloudflareinsights.com", "frame-ancestors 'none'",
    "base-uri 'self'", "form-action 'none'", "object-src 'none'", 'upgrade-insecure-requests',
  ].join('; ');
  return `/*
  ! Cache-Control
  Cache-Control: public, max-age=0, must-revalidate
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Link: </llms.txt>; rel="describedby"; type="text/plain"

/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable

/flags/*
  ! Cache-Control
  Cache-Control: public, max-age=604800

/api/*
  Access-Control-Allow-Origin: *

/api/v1/releases/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable

/data/snapshots/*
  ! Cache-Control
  Cache-Control: public, max-age=86400, immutable
${markdown.map(p => `\n${p}\n  Content-Type: text/markdown; charset=utf-8\n`).join('')}`;
}

async function main() {
  const shell = readFileSync(join(DIST, 'index.html'), 'utf8');
  const data = buildAtlas(), today = new Date().toISOString().slice(0, 10);
  initAtlas(data, today);
  const state = scriptJson(data);
  // The inline head script sends / to a returning visitor's chosen country; it needs the codes other than the default.
  const page = shell.replace('__HOME_CODES__', CODES.filter(c => c !== DEFAULT_CC).join(','));
  const routes: Route[] = [
    { path: '/', page: 'country', cc: DEFAULT_CC, file: 'index.html' },
    { path: '/world/', page: 'world', cc: null, file: 'world/index.html' },
    ...CODES.map(cc => ({ path: `/${cc.toLowerCase()}/`, page: 'country' as const, cc, file: `${cc.toLowerCase()}/index.html` })),
    { path: '/privacy/', page: 'privacy', cc: null, file: 'privacy/index.html' },
    { path: '/design/', page: 'design', cc: null, file: 'design/index.html' },
    { path: '/404', page: 'notfound', cc: null, file: '404.html' },
  ];
  const inline = new Set<string>();
  for (const r of routes) {
    const out = join(DIST, r.file);
    mkdirSync(dirname(out), { recursive: true });
    const html = await render(page, r, state);
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) inline.add(m[1]);
    writeFileSync(out, html);
  }
  writeFileSync(join(DIST, '_headers'), headers([...inline], CODES.map(mirrorOf)));
  writeFileSync(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${routes.filter(r => r.page !== 'notfound' && canonicalOf(r) === SITE + r.path).map(r => `  <url><loc>${SITE}${r.path}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`);
  for (const c of CODES) writeFileSync(join(DIST, mirrorOf(c)), countryMarkdown(c));
  writeFileSync(join(DIST, 'llms-full.txt'), llmsFull());
  writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  console.log(`prerendered ${routes.length} routes as of ${today}, with ${CODES.length} Markdown mirrors`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
