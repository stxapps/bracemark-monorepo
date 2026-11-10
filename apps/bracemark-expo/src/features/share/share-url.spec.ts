import { payloadFromInitialProps, urlFromSharedText } from './share-url';

describe('urlFromSharedText', () => {
  it('pulls the first http(s) URL out of prose (Chrome EXTRA_TEXT)', () => {
    expect(urlFromSharedText('Check this out https://example.com/a?b=1 amazing')).toBe(
      'https://example.com/a?b=1',
    );
  });

  it('promotes a bare dotted host, rejects prose', () => {
    expect(urlFromSharedText('example.com/path')).toBe('https://example.com/path');
    expect(urlFromSharedText('note to self')).toBeNull();
    expect(urlFromSharedText(undefined)).toBeNull();
  });
});

describe('payloadFromInitialProps', () => {
  it('prefers the URL attachment, then preprocessing, then text', () => {
    expect(
      payloadFromInitialProps({
        url: 'https://a.example',
        text: 'https://c.example',
        preprocessingResults: { url: 'https://b.example' },
      }).url,
    ).toBe('https://a.example');
    expect(
      payloadFromInitialProps({
        text: 'https://c.example',
        preprocessingResults: { url: 'https://b.example' },
      }).url,
    ).toBe('https://b.example');
    expect(payloadFromInitialProps({ text: 'https://c.example' }).url).toBe('https://c.example');
  });

  // Text in, the same text out — never parsed in the sheet, which only writes it
  // to the draft. An object is what a preprocessing.js older than this bundle
  // sent, and the iOS share extension has no memory for an article as a graph.
  it('carries Safari’s read-mode copy through as the text it arrived as, and nothing else', () => {
    const json = JSON.stringify({ version: 1, capturedAt: 1, blocks: [] });
    expect(
      payloadFromInitialProps({
        url: 'https://a.example',
        preprocessingResults: { readMode: json },
      }).readMode,
    ).toBe(json);
    for (const readMode of [null, '', { version: 1, capturedAt: 1, blocks: [] }, 7]) {
      expect(
        payloadFromInitialProps({ url: 'https://a.example', preprocessingResults: { readMode } }),
      ).not.toHaveProperty('readMode');
    }
  });

  it('takes the title from preprocessing, else the Android subject', () => {
    expect(
      payloadFromInitialProps({
        url: 'https://a.example',
        subject: 'Subject line',
        preprocessingResults: { title: 'Page Title' },
      }).title,
    ).toBe('Page Title');
    expect(
      payloadFromInitialProps({ url: 'https://a.example', subject: 'Subject line' }).title,
    ).toBe('Subject line');
    expect(payloadFromInitialProps({ url: 'https://a.example' }).title).toBeUndefined();
  });

  it('survives a malformed preprocessing result', () => {
    expect(
      payloadFromInitialProps({ text: 'https://a.example', preprocessingResults: 42 }),
    ).toEqual({ url: 'https://a.example' });
    expect(payloadFromInitialProps({ preprocessingResults: { title: 7, url: [] } }).url).toBeNull();
  });

  it('reads as no-url when nothing shareable arrived', () => {
    expect(payloadFromInitialProps({})).toEqual({ url: null });
  });
});
