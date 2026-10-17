import type { ReactElement } from 'react';
import { t } from '@kb/shared';
import { Link, Redirect, useLocation } from '../../router';
import { can, useSession, type Me } from '../../session';
import { CashierPanel } from '../wallet';
import { ApprovalsPage, AuditPage, EmailPage, GlobalSettingsPage, SecretsPage } from './system';
import { InvitesPage, UsersPage } from './users';
import { RolesPage } from './roles';
import { TablesPage } from './tables';
import { TemplatesPage } from './templates';
import { FinancePage } from './finance';
import { TvAdminPage } from './tv';
import { AnnouncerAdminPage } from './announcer';
import { IntegrationsAdminPage } from './integrations';
import { AssistantAdminPage } from './assistant';

interface Section {
  path: string;
  label: string;
  show: (me: Me) => boolean;
  render: () => ReactElement;
}

const SECTIONS: Section[] = [
  { path: '/admin/uzivatele', label: 'admin.users', show: (m) => can(m, 'uzivatel.zobrazit'), render: () => <UsersPage /> },
  { path: '/admin/pozvanky', label: 'admin.invites', show: (m) => can(m, 'uzivatel.pozvat'), render: () => <InvitesPage /> },
  { path: '/admin/stoly', label: 'admin.tables', show: (m) => can(m, 'cash.upravit_vse') || can(m, 'cash.zrusit_vse'), render: () => <TablesPage /> },
  { path: '/admin/role', label: 'admin.roles', show: (m) => can(m, 'role.zobrazit'), render: () => <RolesPage /> },
  { path: '/admin/pokladna', label: 'admin.cashier', show: (m) => can(m, 'mena.dobit') || can(m, 'mena.strhnout') || can(m, 'mena.vyridit_zadost') || can(m, 'mena.zobrazit_knihu'), render: () => <CashierPanel /> },
  { path: '/admin/finance', label: 'admin.finance', show: (m) => can(m, 'mena.zobrazit_knihu'), render: () => <FinancePage /> },
  { path: '/admin/schvalovani', label: 'admin.approvals', show: (m) => can(m, 'schvalovani.rozhodovat') || Object.keys(m.approvals).length > 0, render: () => <ApprovalsPage /> },
  { path: '/admin/email', label: 'admin.email', show: (m) => can(m, 'email.spravovat_smtp') || can(m, 'email.sablony') || can(m, 'email.fronta'), render: () => <EmailPage /> },
  { path: '/admin/tajne-udaje', label: 'admin.secrets', show: (m) => can(m, 'email.spravovat_smtp') || can(m, 'system.tajne_udaje'), render: () => <SecretsPage /> },
  { path: '/admin/nastaveni', label: 'admin.settings', show: (m) => can(m, 'nastaveni.globalni'), render: () => <GlobalSettingsPage /> },
  { path: '/admin/sablony', label: 'admin.templates', show: (m) => can(m, 'nastaveni.globalni'), render: () => <TemplatesPage /> },
  { path: '/admin/tv', label: 'admin.tv', show: (m) => can(m, 'tv.spravovat'), render: () => <TvAdminPage /> },
  { path: '/admin/hlasatel', label: 'admin.announcer', show: (m) => can(m, 'hlasatel.spravovat'), render: () => <AnnouncerAdminPage /> },
  { path: '/admin/napojeni', label: 'admin.integrations', show: (m) => can(m, 'integrace.spravovat'), render: () => <IntegrationsAdminPage /> },
  { path: '/admin/asistent', label: 'admin.assistant', show: (m) => can(m, 'asistent.spravovat'), render: () => <AssistantAdminPage /> },
  { path: '/admin/audit', label: 'admin.audit', show: (m) => can(m, 'audit.zobrazit'), render: () => <AuditPage /> },
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
  return (
    <div className="flex flex-col gap-3">
      <nav aria-label={t('admin.nav')} className="flex flex-wrap gap-2">
        {visible.map((s) => (
          <Link key={s.path} to={s.path} aria-current={s.path === path ? 'page' : undefined} className={`rounded-md border border-line px-3 py-1 ${s.path === path ? 'bg-primary text-on-primary' : 'bg-surface'}`}>
            {t(s.label)}
          </Link>
        ))}
      </nav>
      {current.render()}
    </div>
  );
}
