export function scrapePaperPage() {
  const meta = (name) => [...document.querySelectorAll('meta[name],meta[property]')].find((node) =>
    (node.getAttribute('name') || node.getAttribute('property') || '').toLowerCase() === name.toLowerCase())?.content || null;
  let article = null;
  const metaValues = (selectors) => selectors.flatMap((selector) =>
    [...document.querySelectorAll(selector)].map((element) => element.content || element.href || element.src).filter(Boolean)
  );
  const nodes = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const pending = [JSON.parse(script.textContent || 'null')];
      while (pending.length) {
        const value = pending.shift();
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) { pending.push(...value); continue; }
        nodes.push(value);
        pending.push(...Object.values(value).filter((child) => child && typeof child === 'object'));
      }
    } catch { /* Ignore malformed JSON-LD and continue with citation metadata. */ }
  }
  const isArticle = (value) => (Array.isArray(value['@type']) ? value['@type'] : [value['@type']])
    .some((type) => /^(ScholarlyArticle|Article|TechArticle)$/.test(type || ''));
  const articles = nodes.filter(isArticle);
  article = articles.find((value) => [value.url, value['@id']].some((url) => {
    try { return typeof url === 'string' && new URL(url, location.href).href.split('#')[0] === location.href.split('#')[0]; } catch { return false; }
  })) || articles[0] || null;
  const pdfUrls = [];
  const pending = article ? [article] : [...nodes];
  while (pending.length) {
    const value = pending.shift();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if (article && value !== article && isArticle(value)) continue;
    if (typeof value.contentUrl === 'string' && (/pdf/i.test(value.encodingFormat || value.fileFormat || '') || /\.pdf(?:$|\?)/i.test(value.contentUrl))) pdfUrls.push(value.contentUrl);
    if (typeof value.url === 'string' && /pdf/i.test(value.encodingFormat || value.fileFormat || '')) pdfUrls.push(value.url);
    if (article) pending.push(...Object.values(value).filter((child) => child && typeof child === 'object'));
  }
  const structuredVenue = article?.isPartOf;
  const venueName = typeof structuredVenue === 'string' ? structuredVenue : structuredVenue?.name;
  const pageIcon = [...document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"]')]
    .sort((a, b) => (parseInt(b.sizes?.value || '0') || 0) - (parseInt(a.sizes?.value || '0') || 0))[0]?.href;
  return {
    pageUrl: location.href,
    iconUrl: pageIcon || null,
    title: meta("citation_title") || meta("dc.title") || article?.headline || article?.name || document.querySelector("h1")?.textContent || document.title,
    citationPdfUrl: meta("citation_pdf_url"),
    doi: meta("citation_doi") || meta("dc.identifier.doi") || (typeof article?.identifier === 'string' ? article.identifier : article?.identifier?.value) || null,
    venue: meta("citation_conference_title") || meta("citation_journal_title") || meta("citation_inbook_title") || venueName,
    publicationDate: meta("citation_publication_date") || meta("citation_date") || article?.datePublished,
    metaPdfUrls: [
      ...metaValues([
        'meta[name="eprints.document_url"]',
        'meta[name="pdf_url"]',
        'meta[name="fulltext_pdf"]',
        'meta[property="og:pdf"]',
        'link[type="application/pdf"]',
        'link[rel="alternate"][href$=".pdf"]',
        'embed[type="application/pdf"]',
        'iframe[src$=".pdf"]',
      ]),
      ...pdfUrls,
    ],
    links: [...document.querySelectorAll("a[href]")].slice(0, 500).map((anchor) => ({
      href: anchor.href,
      text: anchor.textContent || "",
      title: anchor.title || "",
      context: anchor.parentElement?.textContent || "",
      rel: anchor.rel || "",
      type: anchor.type || "",
    })),
  };
}
