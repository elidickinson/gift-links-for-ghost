import { describe, it, expect } from 'vitest';
import { extractContent } from '../src/gift-content.js';
import accessFixture from './fixtures/ghost-post-with-access.html?raw';
import paywallFixture from './fixtures/ghost-post-with-paywall.html?raw';

describe('extractContent', () => {
  it('extracts full article content from Ghost HTML', () => {
    const html = extractContent(accessFixture);

    expect(html).toContain('I keep thinking about the ICE agent');
    expect(html).toContain('Among these three things');
    expect(html).toContain('edited by s.e. smith');
    // Preserves nested inline elements: <a><u>...</u></a>
    expect(html).toMatch(/<a [^>]*><u>caught on tape<\/u><\/a>/);
    // Preserves attributes with special chars
    expect(html).toContain('data-layout="immersive"');
    // Does NOT contain content outside the section
    expect(html).not.toContain('<header');
    expect(html).not.toMatch(/^<section/);
  });

  it('extracts truncated content from paywalled page', () => {
    const html = extractContent(paywallFixture);

    expect(html).toContain('I keep thinking about the ICE agent');
    expect(html).toContain('paying subscribers only');
    expect(html).not.toContain('Among these three things');
  });
});
