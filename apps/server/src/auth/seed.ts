import { and, eq } from 'drizzle-orm';
import { PERMISSIONS, PRESET_ROLES, t } from '@kb/shared';
import { schema, type Db } from '../db/index.js';
import type { PermissionService } from './permissions.js';

/**
 * Při prvním startu vytvoří předpřipravené role. Existující role (podle klíče) se nepřepisují,
 * takže úpravy provedené v GUI zůstanou. Texty se berou z překladů, v DB jsou pak běžná data.
 */
export async function seedRoles(db: Db, permissions: PermissionService): Promise<void> {
  await permissions.reload();
  for (const preset of PRESET_ROLES) {
    if (permissions.roleByKey(preset.key)) continue;
    await permissions.insertRole(
      {
        key: preset.key,
        name: t(`role.${preset.key}.name`),
        description: t(`role.${preset.key}.desc`),
        power: preset.power,
        color: preset.color,
        icon: preset.icon,
        permissions: preset.permissions.map((p) => ({ key: p.key, limits: p.limits, needsApproval: p.needsApproval })),
      },
      true,
      !!preset.locked,
    );
  }
  await grantNewPermissions(db);
  await permissions.reload();
}

/** Oprávnění přidaná v novějších verzích, o kterých starší instalace nemohou vědět (jen jednou při upgradu). */
const ADDED_AFTER_FIRST_RELEASES = ['turnaj.hrat'];

/**
 * Nová položka katalogu oprávnění se při aktualizaci jednorázově přidá předpřipraveným rolím, které ji
 * v předvolbě mají. Co správce ručně odebral dřív, se nevrací (každá položka se rozdává jen jednou).
 */
async function grantNewPermissions(db: Db): Promise<void> {
  const current = PERMISSIONS.map((p) => p.key);
  const [row] = await db.select().from(schema.systemMeta).where(eq(schema.systemMeta.key, 'permissionCatalog'));
  const known = (row?.value as string[] | undefined) ?? current.filter((k) => !ADDED_AFTER_FIRST_RELEASES.includes(k));
  const added = current.filter((k) => !known.includes(k));
  if (added.length) {
    for (const preset of PRESET_ROLES) {
      if (preset.locked) continue;
      const [role] = await db.select({ id: schema.roles.id }).from(schema.roles).where(and(eq(schema.roles.key, preset.key), eq(schema.roles.isSystem, true)));
      if (!role) continue;
      for (const p of preset.permissions.filter((x) => added.includes(x.key))) {
        await db
          .insert(schema.rolePermissions)
          .values({ roleId: role.id, permission: p.key, effect: 'allow', limits: p.limits ?? null, needsApproval: p.needsApproval ?? false })
          .onConflictDoNothing();
      }
    }
  }
  await db.insert(schema.systemMeta).values({ key: 'permissionCatalog', value: current }).onConflictDoUpdate({ target: schema.systemMeta.key, set: { value: current } });
}
