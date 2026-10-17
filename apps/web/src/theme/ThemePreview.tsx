import { t } from '@kb/shared';
import { Amount } from '../table/Chips';
import { CardView } from '../table/CardView';
import { TimerBar, TimerRing } from '../table/TimerRing';
import { Badge, Button, Card, DataTable, Td } from '../ui';
import { useThemeToken } from './ThemeProvider';

const SEATS = [
  { name: 'Alena', stack: 1850, cls: 'left-[50%] top-[92%]', cards: ['As', 'Kd'], me: true, bet: 0 },
  { name: 'Brzda', stack: 920, cls: 'left-[10%] top-[60%]', cards: null, bet: 60 },
  { name: 'Cyril', stack: 3400, cls: 'left-[28%] top-[8%]', cards: null, bet: 0, turn: true },
  { name: 'Dana', stack: 410, cls: 'left-[72%] top-[8%]', cards: null, bet: 120, dealer: true },
  { name: 'Emil', stack: 2100, cls: 'left-[90%] top-[60%]', cards: null, bet: 0 },
];

/** Ukázkový stůl s rozdanou handou: ukazuje stůl, karty, žetony, hráče, časovač a tlačítka podle tokenů motivu. */
function TablePreview() {
  const logo = useThemeToken('table.logoText');
  const timer = useThemeToken('timer.style');
  const deadline = Date.now() + 10_000;
  return (
    <div className="tk-room">
      <div className="tk-table relative mx-auto w-full max-w-xl">
        <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-center">
          <div className="tk-table-logo flex items-center justify-center font-heading text-sm text-on-primary">{logo}</div>
          <div className="flex gap-1">
            {['Qh', 'Jh', '2c'].map((c) => (
              <CardView key={c} card={c} small />
            ))}
            <CardView card={null} small />
            <span className="tk-card border border-line opacity-30 [--card-scale:0.7]" />
          </div>
          <div className="rounded-md bg-surface px-3 py-1">
            <Amount amount={540} text="540" />
          </div>
        </div>
        {SEATS.map((s) => (
          <div key={s.name} className={`absolute -translate-x-1/2 -translate-y-1/2 ${s.cls}`}>
            <div className="flex w-24 flex-col items-center gap-1 text-center">
              <div className="flex gap-1">{s.cards ? s.cards.map((c) => <CardView key={c} card={c} small />) : [0, 1].map((i) => <CardView key={i} card={null} small />)}</div>
              <div className={`tk-avatar relative flex items-center justify-center border-2 bg-surface ${s.turn ? 'tk-turn' : 'border-line'}`}>
                {s.turn && timer !== 'bar' && <TimerRing deadline={deadline} offset={0} bank={false} />}
                <span className="truncate px-1 text-xs font-medium">{s.name}</span>
                {s.dealer && <span className="absolute -right-1 -top-1 rounded-full bg-dealer px-1 text-xs text-on-primary">D</span>}
              </div>
              {s.turn && timer === 'bar' && <TimerBar deadline={deadline} offset={0} bank={false} />}
              <div className={`rounded-md px-2 text-xs ${s.me ? 'bg-primary text-on-primary' : 'bg-surface'}`}>
                <Amount amount={s.stack} text={String(s.stack)} />
              </div>
              {s.bet > 0 && (
                <div className="rounded-md bg-raised px-2 text-xs">
                  <Amount amount={s.bet} text={String(s.bet)} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        <button className="tk-act tk-act-fold px-4 py-2 font-medium">{t('table.fold')}</button>
        <button className="tk-act tk-act-call px-4 py-2 font-medium">{t('table.call')} 120</button>
        <button className="tk-act tk-act-raise px-4 py-2 font-medium">{t('table.raise')} 300</button>
        <button className="tk-act tk-act-allin px-4 py-2 font-medium">{t('table.allIn')}</button>
      </div>
    </div>
  );
}

function LobbyPreview() {
  return (
    <Card title={t('lobby.title')}>
      <DataTable head={[t('editor.preview.name'), t('lobby.blinds'), t('lobby.players')]}>
        <tr>
          <Td>Páteční hra</Td>
          <Td className="font-mono">5/10</Td>
          <Td>
            <Badge tone="success">4/9</Badge>
          </Td>
        </tr>
        <tr>
          <Td>Turnaj Turbo</Td>
          <Td className="font-mono">25/50</Td>
          <Td>
            <Badge tone="warning">7/9</Badge>
          </Td>
        </tr>
      </DataTable>
      <div className="mt-2 flex gap-2">
        <Button variant="primary">{t('editor.preview.primary')}</Button>
        <Button>{t('editor.preview.secondary')}</Button>
        <Button variant="danger">{t('editor.preview.danger')}</Button>
      </div>
      <p className="mt-2 text-sm text-muted">{t('editor.preview.muted')}</p>
    </Card>
  );
}

function ChatPreview() {
  return (
    <Card title={t('nav.chat')}>
      <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-2 text-sm">
        <div>
          <strong>Alena</strong> <span className="text-xs text-muted">20:14</span>
          <p>{t('editor.preview.chat1')}</p>
        </div>
        <div className="rounded-sm bg-raised px-2 py-1">
          <strong>Brzda</strong>
          <p>
            @Alena {t('editor.preview.chat2')}
          </p>
        </div>
        <em className="text-muted">{t('editor.preview.chat3')}</em>
      </div>
    </Card>
  );
}

export function ThemePreview() {
  return (
    <div className="flex flex-col gap-3">
      <TablePreview />
      <LobbyPreview />
      <ChatPreview />
    </div>
  );
}
