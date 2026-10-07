/* ============================================================================
   SQUAD UP — storage
   Two adapters behind one interface:
     - "file"     JSON on disk. Local dev and tests. No external service.
     - "supabase" production.
   The server only ever talks to this interface, so swapping backends (or
   testing without a network) never touches route code.
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const { newId, newToken } = require("./core");

/* ------------------------------------------------------------------ file -- */
function fileAdapter(file) {
  const blank = {
    people: [], tags: [], subscriptions: [],
    activities: [], activity_options: [], responses: [],
    ideas: [], idea_members: [], invites: [], sends: []
  };
  let mem = null;

  function load() {
    if (mem) return mem;
    try { mem = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { mem = JSON.parse(JSON.stringify(blank)); }
    for (const k of Object.keys(blank)) if (!mem[k]) mem[k] = [];
    return mem;
  }
  function save() {
    if (!file) return;
    try { fs.writeFileSync(file, JSON.stringify(mem, null, 2)); }
    catch (e) { console.error("db save failed:", e.message); }
  }
  const clone = v => JSON.parse(JSON.stringify(v));

  return {
    kind: "file",

    async listPeople() { return clone(load().people); },
    async getPersonByToken(t) {
      return clone(load().people.find(p => p.personal_token === t) || null);
    },
    async getPersonByEmail(e) {
      const key = String(e || "").trim().toLowerCase();
      if (!key) return null;
      return clone(load().people.find(p => p.email && p.email.toLowerCase() === key) || null);
    },
    async getPersonByPhone(ph) {
      if (!ph) return null;
      return clone(load().people.find(p => p.phone === ph) || null);
    },
    async updatePerson(id, patch) {
      const p = load().people.find(x => x.id === id);
      if (!p) return null;
      Object.assign(p, patch); save();
      return clone(p);
    },
    async countPeopleInvitedBy(personId, sinceIso) {
      return load().people.filter(p => p.invited_by === personId && p.created_at >= sinceIso).length;
    },
    async getPerson(id) {
      return clone(load().people.find(p => p.id === id) || null);
    },
    async createPerson({ name, email, phone, invited_by, confirmed }) {
      const db = load();
      const now = new Date().toISOString();
      const p = {
        id: newId(), name, email: email ? String(email).trim() : null,
        phone: phone || null, personal_token: newToken(),
        invited_by: invited_by || null, confirmed_at: confirmed === false ? null : now,
        opted_out_at: null, created_at: now
      };
      db.people.push(p); save();
      return clone(p);
    },
    async resetToken(personId) {
      const db = load();
      const p = db.people.find(x => x.id === personId);
      if (!p) return null;
      p.personal_token = newToken(); save();
      return clone(p);
    },

    async listTags() {
      return clone(load().tags).sort((a, b) => a.name.localeCompare(b.name));
    },
    async getTag(id) { return clone(load().tags.find(t => t.id === id) || null); },
    async getTagByName(name) {
      const key = String(name || "").trim().toLowerCase();
      return clone(load().tags.find(t => t.name.toLowerCase() === key) || null);
    },
    async createTag({ name, created_by }) {
      const db = load();
      const t = {
        id: newId(), name: String(name).trim(), created_by,
        created_at: new Date().toISOString()
      };
      db.tags.push(t);
      // New tags reach everyone by default -- otherwise the first activity
      // under a brand-new tag would notify nobody. People prune from their
      // own page afterward.
      // ...everyone who's actually joined, that is -- not people who were
      // invited and haven't answered yet
      db.people.filter(p => p.confirmed_at !== null).forEach(p => {
        if (!db.subscriptions.some(s => s.person_id === p.id && s.tag_id === t.id))
          db.subscriptions.push({ person_id: p.id, tag_id: t.id });
      });
      save();
      return clone(t);
    },

    async listSubscriptions(personId) {
      return load().subscriptions
        .filter(s => s.person_id === personId).map(s => s.tag_id);
    },
    async setSubscription(personId, tagId, on) {
      const db = load();
      const i = db.subscriptions
        .findIndex(s => s.person_id === personId && s.tag_id === tagId);
      if (on && i < 0) db.subscriptions.push({ person_id: personId, tag_id: tagId });
      if (!on && i >= 0) db.subscriptions.splice(i, 1);
      save();
    },
    async subscribersOfTag(tagId) {
      const db = load();
      const ids = db.subscriptions
        .filter(s => s.tag_id === tagId).map(s => s.person_id);
      return clone(db.people.filter(p => ids.includes(p.id)));
    },

    async createActivity(a) {
      const db = load();
      const row = {
        id: newId(), created_at: new Date().toISOString(), location: null,
        locked_option_id: null, canceled_at: null, canceled_reason: null,
        finalize_nudge_sent_at: null, ...a
      };
      db.activities.push(row); save();
      return clone(row);
    },
    async getActivity(id) {
      return clone(load().activities.find(a => a.id === id) || null);
    },
    async listActivities() { return clone(load().activities); },
    async updateActivity(id, patch) {
      const db = load();
      const a = db.activities.find(x => x.id === id);
      if (!a) return null;
      Object.assign(a, patch); save();
      return clone(a);
    },

    async createOption(o) {
      const db = load();
      const row = { id: newId(), created_at: new Date().toISOString(), ...o };
      db.activity_options.push(row); save();
      return clone(row);
    },
    async listOptions(activityId) {
      return clone(load().activity_options.filter(o => o.activity_id === activityId));
    },
    async getOption(id) {
      return clone(load().activity_options.find(o => o.id === id) || null);
    },
    async updateOption(id, patch) {
      const db = load();
      const o = db.activity_options.find(x => x.id === id);
      if (!o) return null;
      Object.assign(o, patch); save();
      return clone(o);
    },
    async deleteOption(id) {
      const db = load();
      const i = db.activity_options.findIndex(x => x.id === id);
      if (i >= 0) db.activity_options.splice(i, 1);
      save();
    },

    async listResponses(activityId) {
      return clone(load().responses.filter(r => r.activity_id === activityId));
    },
    async upsertResponse(r) {
      const db = load();
      const found = db.responses.find(
        x => x.activity_id === r.activity_id && x.person_id === r.person_id);
      if (found) Object.assign(found, r);
      else db.responses.push({ ...r, created_at: new Date().toISOString() });
      save();
      return clone(found || r);
    },

    /* ideas -- "Let's do this sometime" */
    async createIdea({ creator_id, title, tag_id, note }) {
      const db = load();
      const now = new Date().toISOString();
      const row = {
        id: newId(), creator_id, title, tag_id, note: note || null,
        created_at: now, last_joined_at: now,
        last_nudge_at: null, last_nudge_by: null,
        archived_at: null, converted_activity_id: null
      };
      db.ideas.push(row); save();
      return clone(row);
    },
    async getIdea(id) { return clone(load().ideas.find(i => i.id === id) || null); },
    async listIdeas() { return clone(load().ideas.filter(i => !i.archived_at)); },
    async updateIdea(id, patch) {
      const db = load();
      const i = db.ideas.find(x => x.id === id);
      if (!i) return null;
      Object.assign(i, patch); save();
      return clone(i);
    },
    async listIdeaMembers(ideaId) {
      return clone(load().idea_members.filter(m => m.idea_id === ideaId));
    },
    async listAllIdeaMembers() { return clone(load().idea_members); },
    async addIdeaMember(ideaId, personId) {
      const db = load();
      if (db.idea_members.some(m => m.idea_id === ideaId && m.person_id === personId))
        return false;
      db.idea_members.push({ idea_id: ideaId, person_id: personId,
                             joined_at: new Date().toISOString() });
      save();
      return true;
    },
    async removeIdeaMember(ideaId, personId) {
      const db = load();
      const i = db.idea_members
        .findIndex(m => m.idea_id === ideaId && m.person_id === personId);
      if (i >= 0) db.idea_members.splice(i, 1);
      save();
    },

    /* invites */
    async listInvites(activityId) {
      return clone(load().invites.filter(i => i.activity_id === activityId));
    },
    async listInvitesForPerson(personId) {
      return clone(load().invites.filter(i => i.person_id === personId));
    },
    async addInvite({ activity_id, person_id, invited_by }) {
      const db = load();
      if (db.invites.some(i => i.activity_id === activity_id && i.person_id === person_id)) return false;
      db.invites.push({ activity_id, person_id, invited_by, invited_at: new Date().toISOString() });
      save();
      return true;
    },
    async countInvitesBy(personId, sinceIso) {
      return load().invites.filter(i => i.invited_by === personId && i.invited_at >= sinceIso).length;
    },
    async listRespondedActivityIds(personId) {
      return load().responses.filter(r => r.person_id === personId).map(r => r.activity_id);
    },

    /* send log -- what the daily limits count */
    async logSend({ person_id, channel, kind, activity_id, ask_options }) {
      const db = load();
      db.sends.push({ id: newId(), person_id, channel, kind: kind || null,
                      activity_id: activity_id || null, ask_options: ask_options || null,
                      sent_at: new Date().toISOString() });
      save();
    },
    // the last thing we asked this person -- what a bare "yes" or "2" answers
    async latestAsk(personId, sinceIso) {
      const asks = load().sends.filter(x => x.person_id === personId && x.activity_id && x.sent_at >= sinceIso);
      const a = asks[asks.length - 1];
      return a ? { activity_id: a.activity_id, option_ids: a.ask_options ? a.ask_options.split(",") : [] } : null;
    },
    async countSends({ channel, sinceIso, person_id, kind }) {
      return load().sends.filter(x => x.channel === channel && x.sent_at >= sinceIso &&
        (!person_id || x.person_id === person_id) && (!kind || x.kind === kind)).length;
    },
    async pruneSends(beforeIso) {
      const db = load();
      const before = db.sends.length;
      db.sends = db.sends.filter(x => x.sent_at >= beforeIso);
      if (db.sends.length !== before) save();
      return before - db.sends.length;
    },

    _raw: load, _save: save
  };
}

/* -------------------------------------------------------------- supabase -- */
// Every table carries a squad_ prefix so Squad Up's tables sort together in
// a Supabase project shared with other extrarandom apps.
const T = {
  people: "squad_people", tags: "squad_tags", subscriptions: "squad_subscriptions",
  activities: "squad_activities", activity_options: "squad_activity_options",
  responses: "squad_responses", ideas: "squad_ideas", idea_members: "squad_idea_members",
  invites: "squad_invites", sends: "squad_sends"
};

function supabaseAdapter(url, key) {
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const one = async q => { const { data, error } = await q; if (error) throw error; return data; };
  const many = async q => { const { data, error } = await q; if (error) throw error; return data || []; };

  return {
    kind: "supabase",

    async listPeople() { return many(sb.from(T.people).select("*")); },
    async getPersonByToken(t) {
      return one(sb.from(T.people).select("*").eq("personal_token", t).maybeSingle());
    },
    async getPersonByEmail(e) {
      const key = String(e || "").trim();
      if (!key) return null;
      // ilike treats _ and % as wildcards; escape them so it's an exact match
      return one(sb.from(T.people).select("*")
        .ilike("email", key.replace(/[\\%_]/g, m => "\\" + m)).maybeSingle());
    },
    async getPersonByPhone(ph) {
      if (!ph) return null;
      const rows = await many(sb.from(T.people).select("*").eq("phone", ph).limit(1));
      return rows[0] || null;
    },
    async updatePerson(id, patch) {
      return one(sb.from(T.people).update(patch).eq("id", id).select().single());
    },
    async countPeopleInvitedBy(personId, sinceIso) {
      const { count, error } = await sb.from(T.people).select("id", { count: "exact", head: true })
        .eq("invited_by", personId).gte("created_at", sinceIso);
      if (error) throw error;
      return count || 0;
    },
    async getPerson(id) {
      return one(sb.from(T.people).select("*").eq("id", id).maybeSingle());
    },
    async createPerson({ name, email, phone, invited_by, confirmed }) {
      return one(sb.from(T.people).insert({
        id: newId(), name, email: email ? String(email).trim() : null,
        phone: phone || null, personal_token: newToken(),
        invited_by: invited_by || null,
        confirmed_at: confirmed === false ? null : new Date().toISOString()
      }).select().single());
    },
    async resetToken(personId) {
      return one(sb.from(T.people).update({ personal_token: newToken() })
        .eq("id", personId).select().single());
    },

    async listTags() { return many(sb.from(T.tags).select("*").order("name")); },
    async getTag(id) { return one(sb.from(T.tags).select("*").eq("id", id).maybeSingle()); },
    async getTagByName(name) {
      return one(sb.from(T.tags).select("*")
        .ilike("name", String(name || "").trim()).maybeSingle());
    },
    async createTag({ name, created_by }) {
      const tag = await one(sb.from(T.tags)
        .insert({ id: newId(), name: String(name).trim(), created_by })
        .select().single());
      const people = await many(sb.from(T.people).select("id").not("confirmed_at", "is", null));
      if (people.length) {
        await one(sb.from(T.subscriptions).upsert(
          people.map(p => ({ person_id: p.id, tag_id: tag.id })),
          { onConflict: "person_id,tag_id", ignoreDuplicates: true }
        ).select());
      }
      return tag;
    },

    async listSubscriptions(personId) {
      const rows = await many(sb.from(T.subscriptions)
        .select("tag_id").eq("person_id", personId));
      return rows.map(r => r.tag_id);
    },
    async setSubscription(personId, tagId, on) {
      if (on) {
        await one(sb.from(T.subscriptions).upsert(
          { person_id: personId, tag_id: tagId },
          { onConflict: "person_id,tag_id", ignoreDuplicates: true }).select());
      } else {
        await one(sb.from(T.subscriptions).delete()
          .eq("person_id", personId).eq("tag_id", tagId).select());
      }
    },
    async subscribersOfTag(tagId) {
      const rows = await many(sb.from(T.subscriptions)
        .select(`person_id, ${T.people}(*)`).eq("tag_id", tagId));
      return rows.map(r => r[T.people]).filter(Boolean);
    },

    async createActivity(a) {
      return one(sb.from(T.activities).insert({ id: newId(), ...a }).select().single());
    },
    async getActivity(id) {
      return one(sb.from(T.activities).select("*").eq("id", id).maybeSingle());
    },
    async listActivities() { return many(sb.from(T.activities).select("*")); },
    async updateActivity(id, patch) {
      return one(sb.from(T.activities).update(patch).eq("id", id).select().single());
    },

    async createOption(o) {
      return one(sb.from(T.activity_options).insert({ id: newId(), ...o })
        .select().single());
    },
    async listOptions(activityId) {
      return many(sb.from(T.activity_options).select("*")
        .eq("activity_id", activityId).order("starts_at"));
    },
    async getOption(id) {
      return one(sb.from(T.activity_options).select("*").eq("id", id).maybeSingle());
    },
    async updateOption(id, patch) {
      return one(sb.from(T.activity_options).update(patch).eq("id", id)
        .select().single());
    },
    async deleteOption(id) {
      await one(sb.from(T.activity_options).delete().eq("id", id).select());
    },

    async listResponses(activityId) {
      return many(sb.from(T.responses).select("*").eq("activity_id", activityId));
    },
    async upsertResponse(r) {
      return one(sb.from(T.responses).upsert(r,
        { onConflict: "activity_id,person_id" }).select().single());
    },

    /* ideas -- "Let's do this sometime" */
    async createIdea({ creator_id, title, tag_id, note }) {
      const now = new Date().toISOString();
      return one(sb.from(T.ideas).insert({
        id: newId(), creator_id, title, tag_id, note: note || null,
        created_at: now, last_joined_at: now
      }).select().single());
    },
    async getIdea(id) {
      return one(sb.from(T.ideas).select("*").eq("id", id).maybeSingle());
    },
    async listIdeas() {
      return many(sb.from(T.ideas).select("*").is("archived_at", null));
    },
    async updateIdea(id, patch) {
      return one(sb.from(T.ideas).update(patch).eq("id", id).select().single());
    },
    async listIdeaMembers(ideaId) {
      return many(sb.from(T.idea_members).select("*").eq("idea_id", ideaId));
    },
    async listAllIdeaMembers() {
      return many(sb.from(T.idea_members).select("*"));
    },
    async addIdeaMember(ideaId, personId) {
      const have = await one(sb.from(T.idea_members).select("idea_id")
        .eq("idea_id", ideaId).eq("person_id", personId).maybeSingle());
      if (have) return false;
      await one(sb.from(T.idea_members).upsert(
        { idea_id: ideaId, person_id: personId },
        { onConflict: "idea_id,person_id", ignoreDuplicates: true }).select());
      return true;
    },
    async removeIdeaMember(ideaId, personId) {
      await one(sb.from(T.idea_members).delete()
        .eq("idea_id", ideaId).eq("person_id", personId).select());
    },

    /* invites */
    async listInvites(activityId) {
      return many(sb.from(T.invites).select("*").eq("activity_id", activityId));
    },
    async listInvitesForPerson(personId) {
      return many(sb.from(T.invites).select("*").eq("person_id", personId));
    },
    async addInvite({ activity_id, person_id, invited_by }) {
      const rows = await many(sb.from(T.invites).upsert(
        { activity_id, person_id, invited_by },
        { onConflict: "activity_id,person_id", ignoreDuplicates: true }).select());
      return rows.length > 0;
    },
    async countInvitesBy(personId, sinceIso) {
      const { count, error } = await sb.from(T.invites).select("activity_id", { count: "exact", head: true })
        .eq("invited_by", personId).gte("invited_at", sinceIso);
      if (error) throw error;
      return count || 0;
    },
    async listRespondedActivityIds(personId) {
      const rows = await many(sb.from(T.responses).select("activity_id").eq("person_id", personId));
      return rows.map(r => r.activity_id);
    },

    /* send log -- what the daily limits count */
    async logSend({ person_id, channel, kind, activity_id, ask_options }) {
      await one(sb.from(T.sends).insert({ id: newId(), person_id, channel, kind: kind || null,
        activity_id: activity_id || null, ask_options: ask_options || null }).select());
    },
    async latestAsk(personId, sinceIso) {
      const rows = await many(sb.from(T.sends).select("activity_id, ask_options").eq("person_id", personId)
        .not("activity_id", "is", null).gte("sent_at", sinceIso)
        .order("sent_at", { ascending: false }).limit(1));
      const a = rows[0];
      return a ? { activity_id: a.activity_id, option_ids: a.ask_options ? a.ask_options.split(",") : [] } : null;
    },
    async countSends({ channel, sinceIso, person_id, kind }) {
      let q = sb.from(T.sends).select("id", { count: "exact", head: true })
        .eq("channel", channel).gte("sent_at", sinceIso);
      if (person_id) q = q.eq("person_id", person_id);
      if (kind) q = q.eq("kind", kind);
      const { count, error } = await q;
      if (error) throw error;
      return count || 0;
    },
    async pruneSends(beforeIso) {
      const rows = await many(sb.from(T.sends).delete().lt("sent_at", beforeIso).select("id"));
      return rows.length;
    }
  };
}

function makeDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (url && key) return supabaseAdapter(url, key);
  const file = process.env.SQUAD_DB_FILE || process.env.HANG_DB_FILE ||
               path.join(__dirname, "..", "squad-data.json");
  return fileAdapter(file);
}

module.exports = { makeDb, fileAdapter, supabaseAdapter, TABLES: T };
