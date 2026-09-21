import { one, q, withTx } from "./db.js";

export type ClassModuleKind = "sort" | "post";

export interface ClassModuleCatalogItem {
  key: string;
  kind: ClassModuleKind;
  id: string;
  title: string;
  createdAt: string;
  moduleNumber: number;
}

export const classModuleKey = (kind: ClassModuleKind, id: string) => `${kind}:${id}`;

/** Published assignment modules applicable to one class, oldest first. */
export async function classModuleCatalog(classId: string | null): Promise<ClassModuleCatalogItem[]> {
  const sortRows = classId
    ? await q<any>(`SELECT id, title, created_at FROM sort_activities WHERE status = 'published' AND (class_id = ? OR class_id IS NULL)`, [classId])
    : await q<any>(`SELECT id, title, created_at FROM sort_activities WHERE status = 'published' AND class_id IS NULL`);
  const postRows = classId
    ? await q<any>(`SELECT id, title, created_at FROM class_posts WHERE status = 'published' AND kind = 'portfolio_mission' AND (class_id = ? OR class_id IS NULL)`, [classId])
    : await q<any>(`SELECT id, title, created_at FROM class_posts WHERE status = 'published' AND kind = 'portfolio_mission' AND class_id IS NULL`);
  return [
    ...sortRows.map((row) => ({ key: classModuleKey("sort", row.id), kind: "sort" as const, id: row.id, title: row.title, createdAt: row.created_at })),
    ...postRows.map((row) => ({ key: classModuleKey("post", row.id), kind: "post" as const, id: row.id, title: row.title, createdAt: row.created_at })),
  ]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))
    .map((item, index) => ({ ...item, moduleNumber: index + 1 }));
}

export async function hiddenClassModuleKeys(classId: string | null): Promise<Set<string>> {
  if (!classId) return new Set();
  const rows = await q<{ module_key: string }>(`SELECT module_key FROM class_hidden_modules WHERE class_id = ?`, [classId]);
  return new Set(rows.map((row) => row.module_key));
}

/** Replace the complete hidden set, matching the teacher's checkbox grid. */
export async function replaceHiddenClassModules(classId: string, requested: unknown[]): Promise<string[]> {
  if (!(await one(`SELECT id FROM classes WHERE id = ?`, [classId]))) throw new Error("Class not found.");
  const allowed = new Set((await classModuleCatalog(classId)).map((item) => item.key));
  const hidden = [...new Set(requested.map((value) => String(value)))].filter((key) => allowed.has(key));
  await withTx(async (tx) => {
    await tx.run(`DELETE FROM class_hidden_modules WHERE class_id = ?`, [classId]);
    for (const key of hidden) {
      await tx.run(`INSERT INTO class_hidden_modules (class_id, module_key) VALUES (?, ?)`, [classId, key]);
    }
  });
  return hidden;
}
