import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { t } from '@kb/shared';
import { ErrorBoundary, ErrorFallback } from './error-boundary';

describe('záchytná vrstva (ErrorBoundary)', () => {
  it('po chybě potomka vykreslí přeloženou hlášku s tlačítkem „Načíst znovu“ místo prázdné stránky', () => {
    const boundary = new ErrorBoundary({ children: createElement('p', null, 'obsah') });
    expect(renderToStaticMarkup(boundary.render() as never)).toContain('obsah');
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('ChunkLoadError'));
    const html = renderToStaticMarkup(boundary.render() as never);
    expect(html).not.toContain('obsah');
    expect(html).toContain(t('app.error.title'));
    expect(html).toContain(t('app.error.reload'));
    expect(html).not.toContain('app.error.');
  });

  it('náhradní obsah jde zavřít tlačítkem obnovení', () => {
    const html = renderToStaticMarkup(createElement(ErrorFallback, { onReload: () => undefined }));
    expect(html).toContain('<button');
    expect(html).toContain(t('app.error.hint'));
  });
});
