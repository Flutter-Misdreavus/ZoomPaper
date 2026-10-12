import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Native Chrome extension module.
import { scrapePaperPage } from '../browser-extension/scrape.js';
afterEach(() => { document.head.innerHTML = ''; document.body.innerHTML = ''; });
describe('academic page metadata', () => {
  it('reads scholarly JSON-LD metadata and PDF encoding on an unknown venue', () => {
    document.head.innerHTML = `<script type="application/ld+json">{"@graph":[{"@type":"ScholarlyArticle","headline":"New Conference Paper","datePublished":"2026-09-30","isPartOf":{"name":"NewConf"},"encoding":{"@type":"MediaObject","encodingFormat":"application/pdf","contentUrl":"https://example.org/fulltext?id=42"}}]}</script>`;
    const result = scrapePaperPage();
    expect(result.title).toBe('New Conference Paper');
    expect(result.venue).toBe('NewConf');
    expect(result.publicationDate).toBe('2026-09-30');
    expect(result.metaPdfUrls).toContain('https://example.org/fulltext?id=42');
  });
  it('prefers citation metadata and reads mixed-case meta names', () => {
    document.head.innerHTML = `<meta name="Citation_Title" content="Official title"><meta name="citation_doi" content="10.1145/example"><script type="application/ld+json">{"@type":"Article","name":"Other title"}</script><link rel="icon" sizes="32x32" href="https://example.org/icon.png">`;
    const result = scrapePaperPage();
    expect(result.title).toBe('Official title');
    expect(result.iconUrl).toBe('https://example.org/icon.png');
    expect(result.doi).toBe('10.1145/example');
  });
});

it('does not use the full text of a related JSON-LD article', () => {
  document.head.innerHTML = `<script type="application/ld+json">{"@graph":[{"@type":"ScholarlyArticle","headline":"Current paper","encoding":{"contentUrl":"https://example.org/current.pdf"},"citation":{"@type":"ScholarlyArticle","encoding":{"contentUrl":"https://example.org/reference.pdf"}}},{"@type":"ScholarlyArticle","headline":"Related","encoding":{"contentUrl":"https://example.org/related.pdf"}}]}</script>`;
  expect(scrapePaperPage().metaPdfUrls).toEqual(['https://example.org/current.pdf']);
});
