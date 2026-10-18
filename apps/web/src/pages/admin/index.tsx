import type { ReactElement } from 'react';
import { t } from '@kb/shared';
import { Redirect, useLocation } from '../../router';
import { MainMenu, type MenuGroup, type MenuTone } from '../../main-menu';
import { can, useSession, type Me } from '../../session';
import { CashierPanel } from '../wallet';
import { ApprovalsPage, AuditPage, EmailPage, GlobalSettingsPage, SecretsPage } from './system';
import { InvitesPage, UsersPage } from './users';
import { RolesPage } from './roles';
import { TablesPage } from './tables';
import { TemplatesPage } from './templates';
import { MaintenancePage } from './maintenance';
import { HistoryPage } from './history';
import { StructuresPage } from './structures';
import { FinancePage } from './finance';
import { TvAdminPage } from './tv';
import { AnnouncerAdminPage } from './announcer';
import { IntegrationsAdminPage } from './integrations';
import { AssistantAdminPage } from './assistant';

type AdminGroup = 'people' | 'game' | 'money' | 'system';

interface Section {
  group: AdminGroup;
  path: string;
  label: string;
  show: (me: Me) => boolean;
  render: () => ReactElement;
}

const SECTIONS: Section[] = [
  { group: 'people', path: '/admin/uzivatele', label: 'admin.users', show: (m) => can(m, 'uzivatel.zobrazit'), render: () => <UsersPage /> },
  { group: 'people', path: '/admin/pozvanky', label: 'admin.invites', show: (m) => can(m, 'uzivatel.pozvat'), render: () => <InvitesPage /> },
  { group: 'game', path: '/admin/stoly', label: 'admin.tables', show: (m) => can(m, 'cash.upravit_vse') || can(m, 'cash.zrusit_vse'), render: () => <TablesPage /> },
  { group: 'game', path: '/admin/historie', label: 'admin.history', show: (m) => can(m, 'historie.spravovat'), render: () => <HistoryPage /> },
  { group: 'people', path: '/admin/role', label: 'admin.roles', show: (m) => can(m, 'role.zobrazit'), render: () => <RolesPage /> },
  { group: 'money', path: '/admin/pokladna', label: 'admin.cashier', show: (m) => can(m, 'mena.dobit') || can(m, 'mena.strhnout') || can(m, 'mena.vyridit_zadost') || can(m, 'mena.zobrazit_knihu'), render: () => <CashierPanel /> },
  { group: 'money', path: '/admin/finance', label: 'admin.finance', show: (m) => can(m, 'mena.zobrazit_knihu'), render: () => <FinancePage /> },
  { group: 'people', path: '/admin/schvalovani', label: 'admin.approvals', show: (m) => can(m, 'schvalovani.rozhodovat') || Object.keys(m.approvals).length > 0, render: () => <ApprovalsPage /> },
  { group: 'system', path: '/admin/email', label: 'admin.email', show: (m) => can(m, 'email.spravovat_smtp') || can(m, 'email.sablony') || can(m, 'email.fronta'), render: () => <EmailPage /> },
  { group: 'system', path: '/admin/tajne-udaje', label: 'admin.secrets', show: (m) => can(m, 'email.spravovat_smtp') || can(m, 'system.tajne_udaje'), render: () => <SecretsPage /> },
  { group: 'system', path: '/admin/nastaveni', label: 'admin.settings', show: (m) => can(m, 'nastaveni.globalni'), render: () => <GlobalSettingsPage /> },
  { group: 'game', path: '/admin/sablony', label: 'admin.templates', show: (m) => can(m, 'nastaveni.globalni'), render: () => <TemplatesPage /> },
  { group: 'game', path: '/admin/struktury', label: 'admin.structures', show: (m) => can(m, 'nastaveni.globalni'), render: () => <StructuresPage /> },
  { group: 'game', path: '/admin/tv', label: 'admin.tv', show: (m) => can(m, 'tv.spravovat'), render: () => <TvAdminPage /> },
  { group: 'game', path: '/admin/hlasatel', label: 'admin.announcer', show: (m) => can(m, 'hlasatel.spravovat'), render: () => <AnnouncerAdminPage /> },
  { group: 'system', path: '/admin/napojeni', label: 'admin.integrations', show: (m) => can(m, 'integrace.spravovat'), render: () => <IntegrationsAdminPage /> },
  { group: 'system', path: '/admin/asistent', label: 'admin.assistant', show: (m) => can(m, 'asistent.spravovat'), render: () => <AssistantAdminPage /> },
  { group: 'system', path: '/admin/audit', label: 'admin.audit', show: (m) => can(m, 'audit.zobrazit'), render: () => <AuditPage /> },
  { group: 'system', path: '/admin/udrzba', label: 'admin.maintenance', show: (m) => can(m, 'nastaveni.globalni'), render: () => <MaintenancePage /> },
];

const GROUPS: { id: AdminGroup; tone: MenuTone }[] = [
  { id: 'people', tone: 'success' },
  { id: 'game', tone: 'info' },
  { id: 'money', tone: 'warning' },
  { id: 'system', tone: 'accent' },
];

/** Zda má uživatel přístup aspoň k jedné části správy (UI jen skrývá, server kontroluje vždy). */
export const isAdmin = (me: Me): boolean => SECTIONS.some((s) => s.show(me));

export function AdminRouter() {
  const { me } = useSession();
  const { path } = useLocation();
  if (!me) return null;
  const visible = SECTIONS.filter((s) => s.show(me));
  if (visible.length === 0) return <Redirect to="/" />;
  const current = visible.find((s) => path === s.path);
  if (!current) return <Redirect to={visible[0]!.path} />;
  // Skupina bez oprávněných položek zmizí.
  const menu: MenuGroup[] = GROUPS.map((g) => ({ id: g.id, tone: g.tone, label: t('admin.group.' + g.id), items: visible.filter((s) => s.group === g.id).map((s) => ({ to: s.path, label: t(s.label) })) })).filter((g) => g.items.length > 0);
  return (
    <div className="flex flex-col gap-3">
      <nav aria-label={t('admin.nav')}>
        <MainMenu groups={menu} isActive={(to) => to === path} path={path} />
      </nav>
      <h1 className="sr-only">{t(current.label)}</h1>
      {current.render()}
    </div>
  );
}
