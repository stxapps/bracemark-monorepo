import { payloadFromInitialProps, urlFromSharedText } from './share-payload';

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
  // On a phone the controller moves the copy to a file before the props exist, and hands
  // over the file's name (ShareViewController.swift). Only a name it could have minted
  // passes — a path that climbs out of `share/copies/` is dropped like any bad copy.
  it('carries the name of the file the controller wrote the copy to, and only such a name', () => {
    const name = '0A1B2C3D-0000-4000-8000-000000000001.json';
    expect(
      payloadFromInitialProps({
        url: 'https://a.example',
        preprocessingResults: { readModeFile: name },
      }).readModeFile,
    ).toBe(name);
    for (const readModeFile of ['../outbox/x.json', 'copy.json', `${name}/..`, 7, null]) {
      expect(
        payloadFromInitialProps({
          url: 'https://a.example',
          preprocessingResults: { readModeFile },
        }),
      ).not.toHaveProperty('readModeFile');
    }
  });

  // The copy itself never crosses: the controller writes it to a file first. One that
  // arrives inline anyway — a controller older than the bundle — is not carried.
  it('never carries the read-mode copy itself', () => {
    const json = JSON.stringify({ version: 1, capturedAt: 1, blocks: [] });
    expect(
      payloadFromInitialProps({
        url: 'https://a.example',
        preprocessingResults: { readMode: json },
      }),
    ).toEqual({ url: 'https://a.example' });
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
