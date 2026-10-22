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
    ideas: [], idea_members: [], invites: [], sends: [],
    polls: [], poll_options: [], poll_votes: [], poll_invites: []
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
  // the same rule the database enforces: one person per name, ignoring case
  const nameKey = n => String(n || "").trim().toLowerCase();
  function nameFree(name, exceptId) {
    if (load().people.some(p => p.id !== exceptId && nameKey(p.name) === nameKey(name))) {
      const e = new Error('duplicate key value violates unique constraint "squad_people_name_lower"');
      e.code = "23505";
      throw e;
    }
  }

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
      if (patch.name != null) nameFree(patch.name, id);
      Object.assign(p, patch); save();
      return clone(p);
    },
    async countPeopleInvitedBy(personId, sinceIso) {
      return load().people.filter(p => p.invited_by === personId && p.created_at >= sinceIso).length;
    },
    async getPerson(id) {
      return clone(load().people.find(p => p.id === id) || null);
    },
    async createPerson({ name, email, phone, invited_by, confirmed, email_confirmed }) {
      const db = load();
      const now = new Date().toISOString();
      nameFree(name);
      const p = {
        id: newId(), name, email: email ? String(email).trim() : null,
        phone: phone || null, personal_token: newToken(),
        invited_by: invited_by || null, confirmed_at: confirmed === false ? null : now,
        opted_out_at: null, invite_sent_at: null, created_at: now,
        email_confirmed_at: email_confirmed === false ? null : now
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
    // the database cascades these; the file copy does it by hand
    async deletePerson(id) {
      const db = load();
      db.people = db.people.filter(p => p.id !== id);
      for (const k of ["responses", "invites", "subscriptions", "idea_members", "poll_invites", "sends"])
        db[k] = db[k].filter(r => r.person_id !== id);
      db.poll_votes.forEach(v => { if (v.person_id === id) v.person_id = null; });
      // plans they organized stay (history), with nobody as organizer
      db.activities.forEach(a => { if (a.creator_id === id) a.creator_id = null; });
      db.tags.forEach(t => { if (t.created_by === id) t.created_by = null; });
      // their polls and ideas go with them
      const polls = new Set(db.polls.filter(x => x.creator_id === id).map(x => x.id));
      db.polls = db.polls.filter(x => !polls.has(x.id));
      for (const k of ["poll_options", "poll_votes", "poll_invites"]) db[k] = db[k].filter(r => !polls.has(r.poll_id));
      const ideas = new Set(db.ideas.filter(x => x.creator_id === id).map(x => x.id));
      db.ideas = db.ideas.filter(x => !ideas.has(x.id));
      db.idea_members = db.idea_members.filter(m => !ideas.has(m.idea_id));
      save();
    },

    async listTags() {
      return clone(load().tags).sort((a, b) => a.name.localeCompare(b.name));
    },
    async getTag(id) { return clone(load().tags.find(t => t.id === id) || null); },
    async getTagByName(name) {
      const key = String(name || "").trim().toLowerCase();
      return clone(load().tags.find(t => t.name.toLowerCase() === key) || null);
    },
    async createTag({ name, created_by, created_at, note }) {
      const db = load();
      if (db.tags.some(x => x.name.toLowerCase() === String(name).trim().toLowerCase())) {
        const e = new Error('duplicate key value violates unique constraint "squad_tags_name_lower"');
        e.code = "23505"; throw e;
      }
      const t = {
        id: newId(), name: String(name).trim(), created_by,
        created_at: created_at || new Date().toISOString(), note: note || null, archived_at: null
      };
      db.tags.push(t);
      // nobody else is signed up: people choose new activities on their page
      save();
      return clone(t);
    },
    async updateTag(id, patch) {
      const db = load();
      const t = db.tags.find(x => x.id === id);
      if (!t) return null;
      if (patch.name && db.tags.some(x => x.id !== id && x.name.toLowerCase() === String(patch.name).trim().toLowerCase())) {
        const e = new Error('duplicate key value violates unique constraint "squad_tags_name_lower"');
        e.code = "23505"; throw e;
      }
      Object.assign(t, patch); save();
      return clone(t);
    },
    async deleteTag(id) {
      const db = load();
      db.tags = db.tags.filter(t => t.id !== id);
      db.subscriptions = db.subscriptions.filter(s => s.tag_id !== id);
      db.polls.forEach(x => { if (x.tag_id === id) x.tag_id = null; });
      save();
    },

    async listSubscriptions(personId) {
      return load().subscriptions
        .filter(s => s.person_id === personId).map(s => s.tag_id);
    },
    async setSubscription(personId, tagId, on) {
      const db = load();
      const i = db.subscriptions
        .findIndex(s => s.person_id === personId && s.tag_id === tagId);
      if (on && i < 0) db.subscriptions.push({ person_id: personId, tag_id: tagId, muted: false,
        created_at: new Date().toISOString() });
      if (!on && i >= 0) db.subscriptions.splice(i, 1);
      save();
    },
    // the bell: still interested, but no messages about new plans
    async setMuted(personId, tagId, muted) {
      const s = load().subscriptions.find(x => x.person_id === personId && x.tag_id === tagId);
      if (s) { s.muted = !!muted; save(); }
      return !!s;
    },
    async listAllSubscriptions() {
      return clone(load().subscriptions.map(s => ({ muted: false, created_at: null, ...s })));
    },
    // everyone interested, each marked _muted when their bell is off
    async subscribersOfTag(tagId) {
      const db = load();
      const subs = db.subscriptions.filter(s => s.tag_id === tagId);
      return clone(db.people.filter(p => subs.some(s => s.person_id === p.id))
        .map(p => ({ ...p, _muted: !!subs.find(s => s.person_id === p.id).muted })));
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
    async deleteResponse(activityId, personId) {
      const db = load();
      db.responses = db.responses.filter(r => !(r.activity_id === activityId && r.person_id === personId));
      save();
    },
    async listResponsesForPerson(personId) {
      return clone(load().responses.filter(r => r.person_id === personId));
    },
    async listIdeasForPerson(personId) {
      const db = load();
      return clone(db.idea_members.filter(m => m.person_id === personId));
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

    /* "Find a time" polls */
    async createPoll({ creator_id, title, location, note, idea_id, tag_id }) {
      const db = load();
      const row = { id: newId(), creator_id, title, location: location || null, note: note || null,
        idea_id: idea_id || null, tag_id: tag_id || null, created_at: new Date().toISOString(),
        finalized_at: null, activity_id: null, canceled_at: null };
      db.polls.push(row); save();
      return clone(row);
    },
    async getPoll(id) { return clone(load().polls.find(x => x.id === id) || null); },
    async listPolls() { return clone(load().polls.filter(x => !x.canceled_at)); },
    async updatePoll(id, patch) {
      const x = load().polls.find(r => r.id === id);
      if (!x) return null;
      Object.assign(x, patch); save();
      return clone(x);
    },
    async addPollOptions(pollId, list) {
      const db = load();
      const have = new Set(db.poll_options.filter(o => o.poll_id === pollId).map(o => o.day + " " + (o.time || "")));
      const added = [];
      for (const o of list) {
        const k = o.day + " " + (o.time || "");
        if (have.has(k)) continue;
        have.add(k);
        const row = { id: newId(), poll_id: pollId, day: o.day, time: o.time || null, created_at: new Date().toISOString() };
        db.poll_options.push(row); added.push(row);
      }
      save();
      return clone(added);
    },
    async listPollOptions(pollId) { return clone(load().poll_options.filter(o => o.poll_id === pollId)); },
    async updatePollOption(id, patch) {
      const x = load().poll_options.find(o => o.id === id);
      if (!x) return null;
      Object.assign(x, patch); save();
      return clone(x);
    },
    async deletePollOption(id) {
      const db = load();
      db.poll_options = db.poll_options.filter(o => o.id !== id);
      save();
    },
    async listPollInvites(pollId) { return clone(load().poll_invites.filter(i => i.poll_id === pollId)); },
    async listPollInvitesForPerson(personId) { return clone(load().poll_invites.filter(i => i.person_id === personId)); },
    async addPollInvite({ poll_id, person_id, invited_by }) {
      const db = load();
      if (db.poll_invites.some(i => i.poll_id === poll_id && i.person_id === person_id)) return false;
      db.poll_invites.push({ poll_id, person_id, invited_by, invited_at: new Date().toISOString() });
      save();
      return true;
    },
    async countPollInvitesBy(personId, sinceIso) {
      return load().poll_invites.filter(i => i.invited_by === personId && i.invited_at >= sinceIso).length;
    },
    async listPollVotes(pollId) { return clone(load().poll_votes.filter(v => v.poll_id === pollId)); },
    async listPollVotesForPerson(personId) { return clone(load().poll_votes.filter(v => v.person_id === personId)); },
    async createPollVote({ poll_id, name, person_id, voter_key, option_ids, maybe_ids }) {
      const db = load();
      const now = new Date().toISOString();
      const row = { id: newId(), poll_id, name, person_id: person_id || null, voter_key,
        option_ids: option_ids || [], maybe_ids: maybe_ids || [], created_at: now, updated_at: now };
      db.poll_votes.push(row); save();
      return clone(row);
    },
    async getPollVoteByKey(key) {
      return clone(load().poll_votes.find(v => v.voter_key === key) || null);
    },
    async deletePollVote(id) {
      const db = load();
      db.poll_votes = db.poll_votes.filter(v => v.id !== id); save();
    },
    async updatePollVote(id, patch) {
      const x = load().poll_votes.find(v => v.id === id);
      if (!x) return null;
      Object.assign(x, patch, { updated_at: new Date().toISOString() }); save();
      return clone(x);
    },

    // many plans (or polls) at once: one read instead of one per plan
    async listOptionsForActivities(ids) {
      const want = new Set(ids);
      return clone(load().activity_options.filter(o => want.has(o.activity_id)));
    },
    async listResponsesForActivities(ids) {
      const want = new Set(ids);
      return clone(load().responses.filter(r => want.has(r.activity_id)));
    },
    async listPollOptionsForPolls(ids) {
      const want = new Set(ids);
      return clone(load().poll_options.filter(o => want.has(o.poll_id)));
    },
    async listPollVotesForPolls(ids) {
      const want = new Set(ids);
      return clone(load().poll_votes.filter(v => want.has(v.poll_id)));
    },
    // the whole database, table by table, for the nightly backup
    async dumpAll() {
      const d = load(), out = {};
      for (const k of Object.keys(blank)) out[T[k] || k] = clone(d[k] || []);
      return out;
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
  invites: "squad_invites", sends: "squad_sends",
  polls: "squad_polls", poll_options: "squad_poll_options", poll_votes: "squad_poll_votes",
  poll_invites: "squad_poll_invites"
};

function supabaseAdapter(url, key) {
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const one = async q => { const { data, error } = await q; if (error) throw error; return data; };
  const many = async q => { const { data, error } = await q; if (error) throw error; return data || []; };
  // Supabase hands back at most 1000 rows per request: keep asking until a
  // short page comes back. `build` makes a fresh, ordered query each time.
  const PAGE = 1000;
  async function allRows(build) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await many(build().range(from, from + PAGE - 1));
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }
  // rows whose `col` is any of `ids`, in batches small enough for a URL
  async function whereIn(table, col, ids, orderBy) {
    const uniq = [...new Set((ids || []).filter(Boolean))];
    if (!uniq.length) return [];
    const batches = [];
    for (let i = 0; i < uniq.length; i += 100) batches.push(uniq.slice(i, i + 100));
    const parts = await Promise.all(batches.map(b =>
      allRows(() => [].concat(orderBy || "id").reduce((q, k) => q.order(k), sb.from(table).select("*").in(col, b)))));
    return parts.flat();
  }
  // a stable order for paging through each table (its primary key)
  const KEY = { squad_subscriptions: ["person_id", "tag_id"], squad_responses: ["activity_id", "person_id"],
    squad_idea_members: ["idea_id", "person_id"], squad_invites: ["activity_id", "person_id"],
    squad_poll_invites: ["poll_id", "person_id"] };

  return {
    kind: "supabase",

    async listPeople() { return allRows(() => sb.from(T.people).select("*").order("id")); },
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
    async createPerson({ name, email, phone, invited_by, confirmed, email_confirmed }) {
      const now = new Date().toISOString();
      return one(sb.from(T.people).insert({
        id: newId(), name, email: email ? String(email).trim() : null,
        phone: phone || null, personal_token: newToken(),
        invited_by: invited_by || null,
        confirmed_at: confirmed === false ? null : now,
        email_confirmed_at: email_confirmed === false ? null : now
      }).select().single());
    },
    async resetToken(personId) {
      return one(sb.from(T.people).update({ personal_token: newToken() })
        .eq("id", personId).select().single());
    },
    async deletePerson(id) {
      await one(sb.from(T.people).delete().eq("id", id).select());
    },

    async listTags() { return many(sb.from(T.tags).select("*").order("name")); },
    async getTag(id) { return one(sb.from(T.tags).select("*").eq("id", id).maybeSingle()); },
    async getTagByName(name) {
      // ilike treats _ and % as wildcards; escape them so it's an exact match
      return one(sb.from(T.tags).select("*")
        .ilike("name", String(name || "").trim().replace(/[\\%_]/g, m => "\\" + m)).maybeSingle());
    },
    async createTag({ name, created_by, created_at, note }) {
      const row = { id: newId(), name: String(name).trim(), created_by };
      if (created_at) row.created_at = created_at;
      if (note) row.note = note;
      // nobody else is signed up: people choose new activities on their page
      return one(sb.from(T.tags).insert(row).select().single());
    },
    async updateTag(id, patch) {
      return one(sb.from(T.tags).update(patch).eq("id", id).select().single());
    },
    async deleteTag(id) {
      await one(sb.from(T.tags).delete().eq("id", id).select());
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
    async setMuted(personId, tagId, muted) {
      const rows = await many(sb.from(T.subscriptions).update({ muted: !!muted })
        .eq("person_id", personId).eq("tag_id", tagId).select());
      return rows.length > 0;
    },
    async listAllSubscriptions() {
      return (await allRows(() => sb.from(T.subscriptions).select("*").order("person_id").order("tag_id")))
        .map(s => ({ muted: false, created_at: null, ...s }));
    },
    async subscribersOfTag(tagId) {
      const rows = await many(sb.from(T.subscriptions)
        .select(`*, ${T.people}(*)`).eq("tag_id", tagId));
      return rows.filter(r => r[T.people]).map(r => ({ ...r[T.people], _muted: !!r.muted }));
    },

    async createActivity(a) {
      return one(sb.from(T.activities).insert({ id: newId(), ...a }).select().single());
    },
    async getActivity(id) {
      return one(sb.from(T.activities).select("*").eq("id", id).maybeSingle());
    },
    async listActivities() { return allRows(() => sb.from(T.activities).select("*").order("id")); },
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
    async deleteResponse(activityId, personId) {
      await one(sb.from(T.responses).delete().eq("activity_id", activityId).eq("person_id", personId).select());
    },
    async listResponsesForPerson(personId) {
      return many(sb.from(T.responses).select("*").eq("person_id", personId));
    },
    async listIdeasForPerson(personId) {
      return many(sb.from(T.idea_members).select("*").eq("person_id", personId));
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
    },

    /* "Find a time" polls */
    async createPoll({ creator_id, title, location, note, idea_id, tag_id }) {
      return one(sb.from(T.polls).insert({ id: newId(), creator_id, title, location: location || null,
        note: note || null, idea_id: idea_id || null, tag_id: tag_id || null }).select().single());
    },
    async getPoll(id) { return one(sb.from(T.polls).select("*").eq("id", id).maybeSingle()); },
    async listPolls() { return many(sb.from(T.polls).select("*").is("canceled_at", null)); },
    async updatePoll(id, patch) { return one(sb.from(T.polls).update(patch).eq("id", id).select().single()); },
    async addPollOptions(pollId, list) {
      const have = await many(sb.from(T.poll_options).select("day, time").eq("poll_id", pollId));
      const seen = new Set(have.map(o => o.day + " " + (o.time || "")));
      const rows = [];
      for (const o of list) {
        const k = o.day + " " + (o.time || "");
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({ id: newId(), poll_id: pollId, day: o.day, time: o.time || null });
      }
      return rows.length ? many(sb.from(T.poll_options).insert(rows).select()) : [];
    },
    async listPollOptions(pollId) { return many(sb.from(T.poll_options).select("*").eq("poll_id", pollId)); },
    async updatePollOption(id, patch) {
      return one(sb.from(T.poll_options).update(patch).eq("id", id).select().single());
    },
    async deletePollOption(id) { await one(sb.from(T.poll_options).delete().eq("id", id).select()); },
    async listPollInvites(pollId) { return many(sb.from(T.poll_invites).select("*").eq("poll_id", pollId)); },
    async listPollInvitesForPerson(personId) { return many(sb.from(T.poll_invites).select("*").eq("person_id", personId)); },
    async addPollInvite({ poll_id, person_id, invited_by }) {
      const rows = await many(sb.from(T.poll_invites).upsert({ poll_id, person_id, invited_by },
        { onConflict: "poll_id,person_id", ignoreDuplicates: true }).select());
      return rows.length > 0;
    },
    async countPollInvitesBy(personId, sinceIso) {
      const { count, error } = await sb.from(T.poll_invites).select("poll_id", { count: "exact", head: true })
        .eq("invited_by", personId).gte("invited_at", sinceIso);
      if (error) throw error;
      return count || 0;
    },
    async listPollVotes(pollId) { return many(sb.from(T.poll_votes).select("*").eq("poll_id", pollId)); },
    async listOptionsForActivities(ids) { return whereIn(T.activity_options, "activity_id", ids); },
    async listResponsesForActivities(ids) {
      return whereIn(T.responses, "activity_id", ids, ["activity_id", "person_id"]); },
    async listPollOptionsForPolls(ids) { return whereIn(T.poll_options, "poll_id", ids); },
    async listPollVotesForPolls(ids) { return whereIn(T.poll_votes, "poll_id", ids); },
    async dumpAll() {
      const out = {};
      await Promise.all(Object.values(T).map(async table => {
        const keys = KEY[table] || ["id"];
        out[table] = await allRows(() => keys.reduce((q, k) => q.order(k), sb.from(table).select("*")));
      }));
      return out;
    },
    async listPollVotesForPerson(personId) { return many(sb.from(T.poll_votes).select("*").eq("person_id", personId)); },
    async createPollVote({ poll_id, name, person_id, voter_key, option_ids, maybe_ids }) {
      return one(sb.from(T.poll_votes).insert({ id: newId(), poll_id, name, person_id: person_id || null,
        voter_key, option_ids: option_ids || [], maybe_ids: maybe_ids || [] }).select().single());
    },
    async getPollVoteByKey(key) {
      return one(sb.from(T.poll_votes).select("*").eq("voter_key", key).maybeSingle());
    },
    async deletePollVote(id) {
      await one(sb.from(T.poll_votes).delete().eq("id", id).select());
    },
    async updatePollVote(id, patch) {
      return one(sb.from(T.poll_votes).update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id).select().single());
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
