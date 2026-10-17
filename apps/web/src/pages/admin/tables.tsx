import { useCallback, useEffect, useState } from 'react';
import { t } from '@kb/shared';
import { del, errorText, get } from '../../api';
import { navigate } from '../../router';
import { can, useSession } from '../../session';
import { Badge, Button, DataTable, Notice, Td } from '../../ui';
import { EditDialog } from '../lobby';

interface Row {
  id: string;
  name: string;
  owner: string | null;
  seats: number;
  seated: number;
  smallBlind: number;
  bigBlind: number;
  playing: boolean;
}

/** Přehled všech stolů pro správce: úprava nastavení (stejné okno jako v lobby) a zrušení. */
export function TablesPage() {
  const { me } = useSession();
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<string | null>(null);
  const reload = useCallback(() => {
    get<{ tables: Row[] }>('/api/lobby')
      .then((d) => setRows(d.tables))
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(reload, [reload]);

  return (
    <div className="flex flex-col gap-3">
      {error && <Notice kind="error">{error}</Notice>}
      {rows.length === 0 && !error && <Notice>{t('lobby.empty')}</Notice>}
      {rows.length > 0 && (
        <DataTable head={[t('admin.tableName'), t('lobby.blinds'), t('admin.tableSeats'), t('admin.tableOwner'), '']}>
          {rows.map((r) => (
            <tr key={r.id}>
              <Td>
                <strong>{r.name}</strong> {r.playing && <Badge tone="success">{t('lobby.playing')}</Badge>}
              </Td>
              <Td className="font-mono">
                {r.smallBlind}/{r.bigBlind}
              </Td>
              <Td>
                {r.seated}/{r.seats}
              </Td>
              <Td>{r.owner ?? '–'}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  <Button onClick={() => navigate(`/stul/${r.id}`)}>{t('lobby.watch')}</Button>
                  {can(me, 'cash.upravit_vse') && <Button onClick={() => setEdit(r.id)}>{t('lobby.edit')}</Button>}
                  {can(me, 'cash.zrusit_vse') && (
                    <Button
                      variant="danger"
                      onClick={async () => {
                        if (!confirm(t('lobby.closeConfirm', { name: r.name }))) return;
                        await del(`/api/lobby/tables/${r.id}`).catch((e) => setError(errorText(e)));
                        reload();
                      }}
                    >
                      {t('lobby.close')}
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </DataTable>
      )}
      {edit && (
        <EditDialog
          tableId={edit}
          onClose={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
