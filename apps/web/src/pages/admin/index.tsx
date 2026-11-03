import { useEffect, type ReactElement } from 'react';
import { lazyPage } from '../../lazy';
import { t } from '@kb/shared';
import { Link, Redirect, useLocation } from '../../router';
import { NavTabs } from '../../nav-tabs';
import { can, useSession, type Me } from '../../session';
import { saveUserSetting, useSettings } from '../../settings';

// Stránky správy se načítají až při otevření.
const CashierPanel = lazyPage(() => import('../wallet'), 'CashierPanel');
const ApprovalsPage = lazyPage(() => import('./system'), 'ApprovalsPage');
const AuditPage = lazyPage(() => import('./system'), 'AuditPage');
const EmailPage = lazyPage(() => import('./system'), 'EmailPage');
const GlobalSettingsPage = lazyPage(() => import('./system'), 'GlobalSettingsPage');
const SecretsPage = lazyPage(() => import('./system'), 'SecretsPage');
const InvitesPage = lazyPage(() => import('./users'), 'InvitesPage');
const UsersPage = lazyPage(() => import('./users'), 'UsersPage');
const RolesPage = lazyPage(() => import('./roles'), 'RolesPage');
const TablesPage = lazyPage(() => import('./tables'), 'TablesPage');
const TemplatesPage = lazyPage(() => import('./templates'), 'TemplatesPage');
const MaintenancePage = lazyPage(() => import('./maintenance'), 'MaintenancePage');
const MessagesPage = lazyPage(() => import('./messages'), 'MessagesPage');
const HistoryPage = lazyPage(() => import('./history'), 'HistoryPage');
const StructuresPage = lazyPage(() => import('./structures'), 'StructuresPage');
const FinancePage = lazyPage(() => import('./finance'), 'FinancePage');
const TvAdminPage = lazyPage(() => import('./tv'), 'TvAdminPage');
const AnnouncerAdminPage = lazyPage(() => import('./announcer'), 'AnnouncerAdminPage');
const IntegrationsAdminPage = lazyPage(() => import('./integrations'), 'IntegrationsAdminPage');
const AssistantAdminPage = lazyPage(() => import('./assistant'), 'AssistantAdminPage');
const BoardsPage = lazyPage(() => import('./boards'), 'BoardsPage');
const LogoAdminPage = lazyPage(() => import('./logo'), 'LogoAdminPage');
const YearAdminPage = lazyPage(() => import('./year'), 'YearAdminPage');

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
  { group: 'system', path: '/admin/logo', label: 'admin.logo', show: (m) => can(m, 'nastaveni.globalni'), render: () => <LogoAdminPage /> },
  { group: 'system', path: '/admin/osobni-vychozi', label: 'admin.personalDefaults', show: (m) => can(m, 'nastaveni.globalni'), render: () => <GlobalSettingsPage personal /> },
  { group: 'game', path: '/admin/sablony', label: 'admin.templates', show: (m) => can(m, 'nastaveni.sablony.sprava') || can(m, 'nastaveni.globalni'), render: () => <TemplatesPage /> },
  { group: 'game', path: '/admin/struktury', label: 'admin.structures', show: (m) => can(m, 'nastaveni.globalni'), render: () => <StructuresPage /> },
  { group: 'game', path: '/admin/prehledy', label: 'admin.boards', show: (m) => can(m, 'nastaveni.globalni'), render: () => <BoardsPage /> },
  { group: 'game', path: '/admin/rocni-statistika', label: 'admin.year', show: (m) => can(m, 'nastaveni.globalni'), render: () => <YearAdminPage /> },
  { group: 'game', path: '/admin/tv', label: 'admin.tv', show: (m) => can(m, 'tv.spravovat'), render: () => <TvAdminPage /> },
  { group: 'game', path: '/admin/hlasatel', label: 'admin.announcer', show: (m) => can(m, 'hlasatel.spravovat'), render: () => <AnnouncerAdminPage /> },
  { group: 'system', path: '/admin/napojeni', label: 'admin.integrations', show: (m) => can(m, 'integrace.spravovat'), render: () => <IntegrationsAdminPage /> },
  { group: 'system', path: '/admin/asistent', label: 'admin.assistant', show: (m) => can(m, 'asistent.spravovat'), render: () => <AssistantAdminPage /> },
  { group: 'system', path: '/admin/audit', label: 'admin.audit', show: (m) => can(m, 'audit.zobrazit'), render: () => <AuditPage /> },
  { group: 'people', path: '/admin/zpravy', label: 'admin.messages', show: (m) => can(m, 'zpravy.odeslat'), render: () => <MessagesPage /> },
  { group: 'system', path: '/admin/udrzba', label: 'admin.maintenance', show: (m) => can(m, 'nastaveni.globalni'), render: () => <MaintenancePage /> },
];

const GROUPS: AdminGroup[] = ['people', 'game', 'money', 'system'];

const LAST_KEY = 'ui.adminLast';

/** Naposledy otevřené stránky správy: podle kategorie a celkově (`_`); pamatují se v osobním nastavení. */
function parseLast(raw: unknown): Record<string, string> {
  try {
    return JSON.parse(typeof raw === 'string' && raw ? raw : '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** Kam vede kategorie: na poslední použitou stránku v ní, pokud je ještě dostupná, jinak na první. */
export function lastInGroup(paths: string[], last: string | undefined): string {
  return last && paths.includes(last) ? last : paths[0]!;
}

/** Zda má uživatel přístup aspoň k jedné části správy (UI jen skrývá, server kontroluje vždy). */
export const isAdmin = (me: Me): boolean => SECTIONS.some((s) => s.show(me));

export function AdminRouter() {
  const { me } = useSession();
  const { path } = useLocation();
  const raw = useSettings().values[LAST_KEY];
  const visible = me ? SECTIONS.filter((s) => s.show(me)) : [];
  const current = visible.find((s) => path === s.path);
  // Zapamatuje poslední použitou stránku (celkově i v kategorii), ať se příště otevře tam, kde jsem skončil.
  useEffect(() => {
    if (!current) return;
    const last = parseLast(raw);
    if (last._ === current.path && last[current.group] === current.path) return;
    void saveUserSetting(LAST_KEY, JSON.stringify({ ...last, _: current.path, [current.group]: current.path }), true).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  if (!me) return null;
  if (visible.length === 0) return <Redirect to="/" />;
  if (!current) return <Redirect to={lastInGroup(visible.map((s) => s.path), parseLast(raw)._)} />;
  // Kategorie bez oprávněných položek zmizí; kategorie vede na poslední použitou stránku v ní.
  const last = parseLast(raw);
  const groups = GROUPS.map((g) => ({ id: g, items: visible.filter((s) => s.group === g) })).filter((g) => g.items.length > 0);
  const tabs = groups.map((g) => ({ to: lastInGroup(g.items.map((s) => s.path), last[g.id]), label: t(`admin.group.${g.id}`) }));
  const groupOf = new Map(tabs.map((tab, i) => [tab.to, groups[i]!.id]));
  const active = groups.find((g) => g.id === current.group)!;
  return (
    <div className="flex flex-col gap-3">
      <NavTabs label={t('admin.nav')} tabs={tabs} isActive={(to) => groupOf.get(to) === current.group} />
      <nav aria-label={t(`admin.group.${active.id}`)} className="flex flex-wrap gap-1 rounded-md border border-line bg-surface p-1">
        {active.items.map((i) => (
          <Link key={i.path} to={i.path} aria-current={i.path === path ? 'page' : undefined} className={`rounded-md px-3 py-1 ${i.path === path ? 'bg-primary font-semibold text-on-primary' : 'hover:bg-raised'}`}>
            {t(i.label)}
          </Link>
        ))}
      </nav>
      <h1 className="sr-only">{t(current.label)}</h1>
      {current.render()}
    </div>
  );
}
