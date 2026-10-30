#!/usr/bin/env node
/* ============================================================================
   SQUAD UP — put a backup back
   Usage (from the squad-up folder, after `npm install`):
     node tools/restore.js squad-up-backup-2026-10-22.json         shows what it would do
     node tools/restore.js squad-up-backup-2026-10-22.json --yes   does it
   Needs SUPABASE_URL and SUPABASE_SERVICE_KEY set (the same two Render has).

   Every row in the file goes back in, and rows that changed since the backup
   are set back to how they were. Nothing is ever deleted: anything added
   after the backup stays.
   ========================================================================== */
const fs = require("fs");

// parents before children, so every reference has something to point at
const ORDER = [
  ["squad_people", "id"], ["squad_tags", "id"], ["squad_activities", "id"],
  ["squad_activity_options", "id"], ["squad_ideas", "id"], ["squad_polls", "id"],
  ["squad_poll_options", "id"], ["squad_poll_votes", "id"],
  ["squad_subscriptions", "person_id,tag_id"], ["squad_responses", "activity_id,person_id"],
  ["squad_idea_members", "idea_id,person_id"], ["squad_invites", "activity_id,person_id"],
  ["squad_poll_invites", "poll_id,person_id"], ["squad_sends", "id"], ["squad_comments", "id"], ["squad_updates", "id"]
];

async function main() {
  const file = process.argv[2];
  const go = process.argv.includes("--yes");
  if (!file) { console.log("Which file? node tools/restore.js <backup.json> [--yes]"); process.exit(1); }
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!b || b.app !== "Squad Up" || !b.tables) { console.log("That isn't a Squad Up backup file."); process.exit(1); }
  console.log(`Backup from ${b.made_at} (Squad Up ${b.version}):`);
  for (const [t] of ORDER) console.log(`  ${t}: ${(b.tables[t] || []).length} rows`);
  if (!go) { console.log("\nNothing changed. Add --yes to put these rows back."); return; }

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.log("Set SUPABASE_URL and SUPABASE_SERVICE_KEY first."); process.exit(1); }
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const put = async (table, rows, onConflict) => {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from(table).upsert(rows.slice(i, i + 500), { onConflict });
      if (error) throw new Error(`${table}: ${error.message}`);
    }
  };

  // people point at each other (who added a guest): in first without that,
  // then fill it back in once everyone exists
  const people = b.tables.squad_people || [];
  for (const [table, onConflict] of ORDER) {
    const rows = table === "squad_people" ? people.map(p => ({ ...p, invited_by: null })) : (b.tables[table] || []);
    if (rows.length) await put(table, rows, onConflict);
    console.log(`  restored ${table} (${rows.length})`);
  }
  for (const p of people.filter(x => x.invited_by)) {
    const { error } = await sb.from("squad_people").update({ invited_by: p.invited_by }).eq("id", p.id);
    if (error) throw new Error(`squad_people invited_by: ${error.message}`);
  }
  console.log("\nDone. Open Squad Up and check that things look right.");
}
main().catch(e => { console.error("Restore stopped:", e.message); process.exit(1); });
