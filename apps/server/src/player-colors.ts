import { assignPlayerColors } from '@kb/shared';
import { schema, type Db } from './db/index.js';

/** Barvy všech hráčů pro grafy a statistiky (ručně přidělená správcem, jinak automaticky podle pořadí registrace). */
export async function playerColors(db: Db): Promise<Map<string, number>> {
  const rows = await db.select({ id: schema.users.id, chartColor: schema.users.chartColor, createdAt: schema.users.createdAt }).from(schema.users);
  return assignPlayerColors(rows.map((r) => ({ id: r.id, chartColor: r.chartColor, order: r.createdAt.getTime() })));
}
