import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '@kb/shared';
import { Button, Notice } from './ui';

interface Props {
  children: ReactNode;
  /** Změna hodnoty (např. cesta) chybu zapomene a zkusí obsah vykreslit znovu. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * Záchytná vrstva: chyba při vykreslení (nenačtený modul po nasazení nové verze, neplatná data) ukáže hlášku
 * s tlačítkem „Načíst znovu“ místo prázdné bílé stránky. Jedna obaluje celou aplikaci, další každou líně načítanou stránku,
 * aby pád jedné stránky nezhasl rozehraný stůl.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('render error', error, info.componentStack);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <ErrorFallback onReload={() => window.location.reload()} />;
  }
}

/** Obsah záchytné vrstvy (zvlášť, aby šel otestovat bez vyvolání chyby). */
export function ErrorFallback({ onReload }: { onReload: () => void }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-2 p-4">
      <Notice kind="error">
        <strong>{t('app.error.title')}</strong>
        <br />
        {t('app.error.hint')}
      </Notice>
      <div>
        <Button variant="primary" onClick={onReload}>
          {t('app.error.reload')}
        </Button>
      </div>
    </div>
  );
}
