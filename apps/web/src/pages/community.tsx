import { useState } from 'react';
import { t } from '@kb/shared';
import { useFeatures } from '../features';
import { navigate, Redirect, useLocation } from '../router';
import { can, useSession } from '../session';
import { Tabs } from '../ui';
import { ChatPage } from './chat';
import { PollsPage } from './polls';

type Tab = 'chat' | 'ankety';

/** Chat a ankety na jedné stránce: dvě záložky, adresa `?tab=ankety` otevře ankety přímo. */
export function CommunityPage() {
  const { me } = useSession();
  const features = useFeatures();
  const { search } = useLocation();
  const chatOn = features.chat && (can(me, 'chat.psat') || can(me, 'prihlizet.zobrazit'));
  const pollsOn = features.polls;
  const [picked, setPicked] = useState<Tab | null>(() => (new URLSearchParams(search).get('tab') === 'ankety' ? 'ankety' : null));
  if (!chatOn && !pollsOn) return <Redirect to="/" />;
  const tab: Tab = picked === 'ankety' && pollsOn ? 'ankety' : picked === 'chat' && chatOn ? 'chat' : chatOn ? 'chat' : 'ankety';
  const change = (next: Tab) => {
    setPicked(next);
    navigate(next === 'ankety' ? '/chat?tab=ankety' : '/chat', true);
  };
  return (
    <div className="flex flex-col gap-3">
      <h1 className="font-heading text-2xl font-bold">{t('nav.chat')}</h1>
      {chatOn && pollsOn && <Tabs tabs={[{ id: 'chat' as const, label: `💬 ${t('lobby.chatLink')}` }, { id: 'ankety' as const, label: `🗳️ ${t('lobby.pollsLink')}` }]} value={tab} onChange={change} />}
      {tab === 'chat' ? <ChatPage /> : <PollsPage embedded />}
    </div>
  );
}
