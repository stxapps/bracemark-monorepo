import type { ExportBundle } from './bundle';
import { toUrlText } from './text';

function bundle(folders: ExportBundle['folders']): ExportBundle {
  return { folders, exportedAt: 0 };
}

function link(url: string) {
  return { url, title: url, tagNames: [], createdAt: 0, updatedAt: 0 };
}

describe('toUrlText', () => {
  it('returns empty output for an empty bundle', () => {
    expect(toUrlText(bundle([]))).toBe('');
    expect(toUrlText(bundle([{ name: 'Empty', links: [], children: [] }]))).toBe('');
  });

  it('writes one url per line in walk order with a trailing newline', () => {
    const text = toUrlText(
      bundle([
        {
          name: 'A',
          links: [link('https://a.example/1'), link('https://a.example/2')],
          children: [{ name: 'B', links: [link('https://b.example/1')], children: [] }],
        },
      ]),
    );
    expect(text).toBe('https://a.example/1\nhttps://a.example/2\nhttps://b.example/1\n');
  });
});
