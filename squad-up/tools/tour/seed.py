"""Demo squad for the tour video: starts a throwaway copy of the app on a
scratch file database and fills it with a believable week of plans.
Used by tools/tour/capture.py; nothing here touches the real database."""
import subprocess, time, json, urllib.request, os, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 3911
H = f"http://127.0.0.1:{PORT}"
DBFILE = "/tmp/squad_tour.json"


def start_server(fresh=True):
    env = dict(os.environ)
    env.update(SQUAD_DB_FILE=DBFILE, SQUAD_BASE_URL=H + "/squadup", PORT=str(PORT))
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "RESEND_API_KEY", "TWILIO_AUTH_TOKEN"):
        env.pop(k, None)
    if fresh and os.path.exists(DBFILE):
        os.remove(DBFILE)
    srv = subprocess.Popen(["node", "server/index.js"], cwd=ROOT, env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    return srv


def api(path, body):
    if path == "/squadup/api/signup":
        body = {"agree": True, "sms_consent": True, **body}
    r = urllib.request.Request(H + path, data=json.dumps(body).encode(),
                               headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r))


def next_weekday(d, wd):
    """the next given weekday (Mon=0) at least two days out"""
    d = d + datetime.timedelta(days=2)
    while d.weekday() != wd:
        d += datetime.timedelta(days=1)
    return d


def seed():
    today = datetime.date.today()
    fri = next_weekday(today, 4)
    sat = fri + datetime.timedelta(days=1)
    names = ["Gin", "Sebastian", "Danielle", "Marcus", "Priya", "Jordan", "Tess", "Leo", "Nina"]
    P = {}
    for i, n in enumerate(names):
        P[n] = api("/squadup/api/signup", {"name": n, "email": f"{n.lower()}@demo.test"})["token"]

    def tag(who, name, note=None):
        return api("/squadup/api/tag-new", {"token": P[who], "name": name, "note": note})["id"]

    def interest(who, tid):
        api("/squadup/api/interest", {"token": P[who], "tag_id": tid, "on": True})

    tags = {
        "Pickleball": tag("Sebastian", "Pickleball", "Lakes Park courts, all levels"),
        "Dinner": tag("Gin", "Dinner"),
        "Beach day": tag("Priya", "Beach day"),
        "Game night": tag("Marcus", "Game night"),
        "Climbing": tag("Jordan", "Climbing", "Bouldering gym, shoes to rent"),
        "Kayaking": tag("Tess", "Kayaking"),
    }
    for who, ts in {
        "Gin": ["Pickleball", "Beach day", "Game night"],
        "Sebastian": ["Dinner", "Beach day", "Climbing"],
        "Marcus": ["Pickleball", "Dinner", "Beach day"],
        "Priya": ["Dinner", "Pickleball", "Kayaking"],
        "Jordan": ["Game night", "Beach day"],
        "Tess": ["Beach day", "Dinner", "Climbing"],
        "Leo": ["Pickleball", "Game night", "Kayaking"],
        "Nina": ["Dinner", "Beach day", "Climbing"],
        "Danielle": ["Dinner", "Game night", "Pickleball"],
    }.items():
        for t in ts:
            interest(who, tags[t])

    # two plans this week
    pb = api("/squadup/api/activity", {"token": P["Sebastian"], "title": "Pickleball at Lakes Park",
             "tag_id": tags["Pickleball"], "location": "Lakes Park",
             "primary": f"{sat}T09:00", "backup": f"{sat}T10:30"})
    dn = api("/squadup/api/activity", {"token": P["Gin"], "title": "Dinner at Bella's",
             "tag_id": tags["Dinner"], "location": "Bella's Trattoria",
             "primary": f"{fri}T19:00"})
    pbo = bundle_options(pb["id"])
    dno = bundle_options(dn["id"])
    for who in ["Gin", "Marcus", "Priya", "Leo"]:
        api("/squadup/api/rsvp", {"token": P[who], "activity_id": pb["id"], "option_ids": [pbo[0]]})
    for who in ["Sebastian", "Priya", "Tess", "Nina", "Marcus", "Danielle"]:
        api("/squadup/api/rsvp", {"token": P[who], "activity_id": dn["id"], "option_ids": [dno[0]]})

    # a Find-a-time poll, mostly answered
    days = [sat + datetime.timedelta(days=7), sat + datetime.timedelta(days=8),
            sat + datetime.timedelta(days=14), sat + datetime.timedelta(days=15)]
    poll = api("/squadup/api/poll", {"token": P["Priya"], "title": "Beach day at Bowman's",
               "tag_id": tags["Beach day"], "location": "Bowman's Beach",
               "options": [{"day": str(d)} for d in days]})
    po = poll_options(poll["id"])
    votes = {"Priya": [0, 1, 2], "Gin": [0, 2], "Marcus": [0], "Tess": [0, 3], "Nina": [1, 2], "Jordan": [3]}
    for who, idx in votes.items():
        api("/squadup/api/poll-vote", {"token": P[who], "poll_id": poll["id"], "option_ids": [po[i] for i in idx]})

    return {"tokens": P, "tags": tags, "pickleball": pb["id"], "dinner": dn["id"], "poll": poll["id"]}


def _db():
    return json.load(open(DBFILE))


def bundle_options(aid):
    return [o["id"] for o in sorted((o for o in _db()["activity_options"] if o["activity_id"] == aid),
                                    key=lambda o: o["starts_at"])]


def poll_options(pid):
    d = _db()
    key = next(k for k in d if k.startswith("poll") and "option" in k)
    return [o["id"] for o in sorted((o for o in d[key] if o["poll_id"] == pid),
                                    key=lambda o: o.get("day") or o.get("starts_at") or "")]


def polish(srv, fresh=("Climbing",)):
    """Stop the server, make the demo look lived-in (everyone's email is
    confirmed; activities are a couple of months old except `fresh`), and
    start it again on the edited file."""
    srv.kill(); srv.wait()
    d = _db()
    old = (datetime.datetime.utcnow() - datetime.timedelta(days=60)).isoformat() + "Z"
    for p in d["people"]:
        p["email_confirmed_at"] = p.get("email_confirmed_at") or old
        p["confirmed_at"] = p.get("confirmed_at") or old
    for t in d["tags"]:
        if t["name"] not in fresh:
            t["created_at"] = old
    json.dump(d, open(DBFILE, "w"), indent=1)
    return start_server(fresh=False)
