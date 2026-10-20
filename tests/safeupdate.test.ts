import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootDb } from "./helpers/db";

/**
 * Supabase loads the pg-safeupdate extension for API requests: any UPDATE or DELETE without a WHERE clause is refused
 * ("UPDATE requires a WHERE clause", error 21000), even inside a database function. The in-process test database does
 * not have that extension, so a function could pass every other test here and still fail on Supabase. This test
 * applies the same rule to every function actually installed after ALL migrations (later migrations replace earlier
 * versions, so it checks what really runs).
 */
let t: Awaited<ReturnType<typeof bootDb>>;
beforeAll(async () => {
  t = await bootDb();
});
afterAll(async () => {
  await t.db.close();
});

/** UPDATE / DELETE statements in a function body that have no WHERE clause. */
export function statementsWithoutWhere(body: string): string[] {
  const code = body
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/'(?:[^']|'')*'/g, "''"); // string literals (a ';' or the word "where" inside a string is not code)
  const found: string[] = [];
  for (const raw of code.split(";")) {
    const stmt = raw.replace(/\s+/g, " ").trim();
    const isUpdate = /\bupdate\s+[\w."]+(\s+(?!set\b)\w+)?\s+set\b/i.test(stmt);
    const isDelete = /\bdelete\s+from\b/i.test(stmt);
    if ((isUpdate || isDelete) && !/\bwhere\b/i.test(stmt)) found.push(stmt.slice(0, 120));
  }
  return found;
}

describe("Supabase pg-safeupdate rule", () => {
  it("the checker itself spots the problem and ignores comments and strings", () => {
    expect(statementsWithoutWhere("update copy_imap set new_path = 'x'")).toHaveLength(1);
    expect(statementsWithoutWhere("delete from t")).toHaveLength(1);
    expect(statementsWithoutWhere("update t set a = 1 where id = 2; delete from t where id = 3")).toEqual([]);
    expect(statementsWithoutWhere("update public.volumes v set c = 1 from x where v.id = x.id")).toEqual([]);
    expect(statementsWithoutWhere("-- update t set a = 1\nselect 1")).toEqual([]);
    expect(statementsWithoutWhere("select 'update t set a = 1'")).toEqual([]);
    expect(statementsWithoutWhere("insert into t values (1) on conflict (id) do update set v = excluded.v")).toEqual([]); // an upsert is allowed
  });

  it("no installed function has an UPDATE or DELETE without a WHERE clause", async () => {
    const fns = (
      await t.db.query<{ name: string; body: string }>(
        `select p.proname as name, p.prosrc as body
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'`,
      )
    ).rows;
    expect(fns.length).toBeGreaterThan(10);
    const offenders = fns.flatMap((f) => statementsWithoutWhere(f.body).map((s) => `${f.name}: ${s}`));
    expect(offenders).toEqual([]);
  });
});
