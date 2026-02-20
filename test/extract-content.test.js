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

  it('falls back to article.post when no gh-content section', () => {
    const html = extractContent('<html><body><article class="post type-post"><p>Post body</p></article></body></html>');
    expect(html).toBe('<p>Post body</p>');
  });

  it('falls back to bare article when unique', () => {
    const html = extractContent('<html><body><article><p>Article body</p></article></body></html>');
    expect(html).toBe('<p>Article body</p>');
  });

  it('skips ambiguous article matches', () => {
    const html = extractContent('<html><body><article><p>One</p></article><article><p>Two</p></article></body></html>');
    expect(html).toBe('');
  });

  it('falls back to element with content class', () => {
    const html = extractContent('<html><body><div class="content"><p>Div content</p></div></body></html>');
    expect(html).toBe('<p>Div content</p>');
  });

  it('matches exact class "post", not "post-card"', () => {
    // Simulates coyotemedia.org: post-card sidebar articles + one article.post
    const page = `<html><body>
      <article class="post-card has-img"><p>Card 1</p></article>
      <article class="post-card has-img"><p>Card 2</p></article>
      <article class="post tag-food content post-access-tiers"><p>Real content</p></article>
    </body></html>`;
    const html = extractContent(page);
    expect(html).toBe('<p>Real content</p>');
  });

  it('matches exact class "content", not "content-width"', () => {
    const page = `<html><body>
      <div class="social-share content-width"><p>Sidebar</p></div>
      <div class="content"><p>Main content</p></div>
    </body></html>`;
    const html = extractContent(page);
    expect(html).toBe('<p>Main content</p>');
  });

  it('handles nested sections without truncating at first closing tag', () => {
    // The old regex [\s\S]*? was non-greedy and would stop at the first </section>,
    // breaking on nested sections. htmlparser2 handles this correctly.
    const page = `<html><body>
      <section class="gh-content">
        <p>Before nested</p>
        <section class="gh-card">
          <p>Inside nested section</p>
        </section>
        <p>After nested</p>
      </section>
    </body></html>`;
    const html = extractContent(page);
    expect(html).toContain('Before nested');
    expect(html).toContain('Inside nested section');
    expect(html).toContain('After nested');
    expect(html).toContain('<section class="gh-card">');
  });

  it('handles deeply nested same-tag elements', () => {
    const page = `<html><body>
      <section class="gh-content">
        <section class="level-1">
          <section class="level-2">
            <p>Deep content</p>
          </section>
        </section>
      </section>
    </body></html>`;
    const html = extractContent(page);
    expect(html).toContain('Deep content');
    expect(html).toContain('<section class="level-2">');
    expect(html).toContain('<section class="level-1">');
  });

  it('uses custom selector when provided', () => {
    const page = `<html><body>
      <section class="gh-content"><p>Default content</p></section>
      <div class="my-theme-content"><p>Custom content</p></div>
    </body></html>`;
    const html = extractContent(page, 'div.my-theme-content');
    expect(html).toBe('<p>Custom content</p>');
    expect(html).not.toContain('Default content');
  });

  it('custom selector returns empty string when no match', () => {
    const page = '<html><body><section class="gh-content"><p>Content</p></section></body></html>';
    const html = extractContent(page, '.nonexistent');
    expect(html).toBe('');
  });

  it('custom selector with complex CSS (attribute + descendant)', () => {
    const page = `<html><body>
      <main data-post="true">
        <div class="post-body">
          <p>Paragraph one</p>
          <figure><img src="photo.jpg"><figcaption>A photo</figcaption></figure>
          <p>Paragraph two</p>
        </div>
      </main>
    </body></html>`;
    const html = extractContent(page, 'main[data-post] .post-body');
    expect(html).toContain('Paragraph one');
    expect(html).toContain('Paragraph two');
    expect(html).toContain('<figcaption>');
  });

  it('preserves void elements and their attributes', () => {
    const page = `<html><body><section class="gh-content"><p>Text</p><img src="pic.jpg" alt="A &quot;great&quot; photo" loading="lazy"><hr></section></body></html>`;
    const html = extractContent(page);
    expect(html).toContain('<img src="pic.jpg"');
    expect(html).toContain('alt=');
    expect(html).toContain('<hr>');
  });
});
