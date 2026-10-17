/* ============================================================================
   SQUAD UP — category colors
   Every category gets a hue from its name alone, so nobody has to pick one
   and the same name is always the same color. Names that sound alike land in
   the same family: "Beach", "Kayaking" and "Pool day" are all aqua; "Hiking"
   and "Camping" are green. Anything unrecognized gets a steady hue from a
   hash, chosen from the gaps between the families so it can't be mistaken
   for one of them.
   ========================================================================== */

// Checked in order, so a more specific family wins ("paintball" is a sport
// before "paint" can make it an art).
const FAMILIES = [
  { hue: 4,   words: ["sport", "basketball", "football", "softball", "baseball", "paintball",
                      "pickleball", "kickball", "dodgeball", "volleyball", "soccer", "tennis",
                      "golf", "disc golf", "bowling", "climb", "boulder", "gym", "workout",
                      "fitness", "run", "running", "5k", "race", "yoga", "skate", "ski",
                      "snowboard", "hockey", "frisbee", "boxing", "martial", "pilates", "crossfit"] },
  { hue: 28,  words: ["food", "dinner", "lunch", "brunch", "breakfast", "eat", "bbq", "barbecue",
                      "grill", "cook", "potluck", "restaurant", "ramen", "sushi", "pizza", "taco",
                      "burger", "wings", "coffee", "cafe", "café", "bakery", "dessert", "ice cream",
                      "picnic", "seafood", "crawfish", "pho", "thai", "steak", "donut", "food truck"] },
  { hue: 46,  words: ["drink", "bar", "bars", "beer", "brew", "brewery", "wine", "winery", "cocktail",
                      "happy hour", "pub", "cider", "distillery", "tasting", "mocktail", "boba", "tea"] },
  { hue: 128, words: ["outdoor", "hike", "hiking", "camp", "camping", "park", "trail", "nature",
                      "garden", "bike", "biking", "cycling", "walk", "zoo", "farm", "preserve",
                      "birding", "stargazing", "orchard", "botanical"] },
  { hue: 192, words: ["water", "beach", "swim", "pool", "kayak", "canoe", "paddle", "boat",
                      "sail", "surf", "snorkel", "dive", "diving", "scuba", "lake", "river",
                      "spring", "springs", "fishing", "fish", "jet ski", "tubing", "sandbar", "island"] },
  { hue: 218, words: ["trip", "travel", "road trip", "getaway", "vacation", "weekend away",
                      "flight", "cruise", "drive", "tour", "day trip", "theme park", "disney",
                      "universal", "fair", "carnival"] },
  { hue: 262, words: ["game", "games", "board game", "trivia", "poker", "cards", "gaming",
                      "video game", "arcade", "escape", "puzzle", "chess", "dnd", "d&d",
                      "laser tag", "mini golf", "go kart", "bingo"] },
  { hue: 296, words: ["movie", "movies", "film", "cinema", "show", "concert", "music", "gig",
                      "theater", "theatre", "comedy", "museum", "art", "arts", "gallery", "festival",
                      "fest", "book", "reading", "craft", "paint", "pottery", "class", "workshop"] },
  { hue: 332, words: ["party", "birthday", "celebration", "dance", "dancing", "club", "karaoke",
                      "hangout", "hang out", "meetup", "social", "night out", "volunteer", "church"] },
];

// Hues between the families above, for names nothing matched.
const SPARE = [16, 62, 92, 158, 172, 240, 278, 314, 348];

function familyHue(name) {
  const n = " " + String(name || "").toLowerCase().replace(/[^a-z0-9&é ]+/g, " ") + " ";
  for (const f of FAMILIES) {
    // whole words or word starts: "hike" matches "hikes" but "run" never
    // matches "brunch"
    if (f.words.some(w => n.includes(" " + w))) return f.hue;
  }
  return null;
}

function hashHue(name) {
  let h = 2166136261;
  for (const ch of String(name || "").toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return SPARE[h % SPARE.length];
}

function tagHue(name) {
  const f = familyHue(name);
  return f == null ? hashHue(name) : f;
}

// Lightness for filled color: yellows and greens read paler at the same
// number, so they sit darker to keep white text legible on them.
function tagLight(hue) {
  if (hue >= 35 && hue <= 150) return 40;
  if (hue >= 160 && hue <= 200) return 42;
  return 50;
}

// The inline style that colors anything inside it.
function tagStyle(tagOrName) {
  const name = tagOrName && typeof tagOrName === "object" ? tagOrName.name : tagOrName;
  const h = tagHue(name);
  return `--h:${h};--l:${tagLight(h)}%`;
}

module.exports = { tagHue, tagLight, tagStyle, familyHue, FAMILIES };
