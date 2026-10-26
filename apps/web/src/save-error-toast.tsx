import { useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { ApiError, errorText } from './api';
import { onSaveError } from './settings';
import { ErrorToast } from './ui';

/** Plovoucí hláška, když se nepodařilo uložit osobní nastavení; s kódem chyby, aby šlo poznat příčinu (síť, původ požadavku, oprávnění). */
export function SaveErrorToast() {
  const [message, setMessage] = useState('');
  useEffect(
    () =>
      onSaveError((e) => {
        const code = e instanceof ApiError ? `${e.status} ${e.code}` : '';
        setMessage(`${t('settings.saveFailed')} ${errorText(e)}${code ? ` (${code})` : ''}`);
      }),
    [],
  );
  return <ErrorToast message={message} onClose={() => setMessage('')} />;
}
