/* ============================================================================
   SQUAD UP — category colors
   Every category gets a hue from its name alone, so nobody has to pick one
   and the same name is always the same color. Names that sound alike land in
   the same family: "Beach", "Kayaking" and "Pool day" are all aqua; "Hiking"
   and "Camping" are green. Anything unrecognized gets a steady hue from a
   hash, chosen from the gaps between the families so it can't be mistaken
   for one of them.
   ========================================================================== */

// Six main categories, each its own color, plus Travel and Community. Words
// are checked in order, so a more specific family wins. Matching is on the
// start of a word ("hike" matches "hikes", "run" never matches "brunch"); a
// trailing $ means the whole word ("tea" but not "team").
const FAMILIES = [
  // Dining: red. Food and drink.
  { hue: 4,   words: ["dining", "food", "dinner", "lunch", "brunch", "breakfast", "eat$", "bbq", "barbecue",
                      "grill", "cook", "potluck", "restaurant", "ramen", "sushi", "pizza", "taco",
                      "burger", "wings", "coffee", "cafe", "café", "bakery", "dessert", "ice cream",
                      "picnic", "seafood", "crawfish", "pho", "thai", "steak", "donut", "food truck",
                      "drink", "drinks", "bar$", "bars", "beer", "brew", "brewery", "wine", "winery",
                      "cocktail", "happy hour", "pub$", "cider", "distillery", "tasting", "mocktail",
                      "boba", "tea$"] },
  // Party: gold. Celebrations and nights out.
  { hue: 44,  words: ["party", "parties", "birthday", "celebration", "celebrate", "dance", "dancing",
                      "club", "karaoke", "hangout", "hang out", "meetup", "social", "night out",
                      "holiday", "wedding", "shower", "reunion", "get together", "gathering", "bash"] },
  // Active: green. Sports, fitness, outdoors, and anything on the water.
  { hue: 140, words: ["active", "sport", "basketball", "football", "softball", "baseball", "paintball",
                      "pickleball", "kickball", "dodgeball", "volleyball", "soccer", "tennis",
                      "golf", "disc golf", "bowling", "climb", "boulder", "gym", "workout",
                      "fitness", "run", "running", "5k", "race", "yoga", "skate", "ski$",
                      "snowboard", "hockey", "frisbee", "boxing", "martial", "pilates", "crossfit",
                      "outdoor", "outdoors", "hike", "hiking", "camp", "camping", "park", "trail",
                      "nature", "garden", "bike", "biking", "cycling", "walk", "zoo", "farm",
                      "preserve", "birding", "stargazing", "orchard", "botanical",
                      "water", "beach", "swim", "pool", "kayak", "canoe", "paddle", "boat",
                      "sail", "surf", "snorkel", "dive", "diving", "scuba", "lake", "river",
                      "spring", "springs", "fishing", "fish", "jet ski", "tubing", "sandbar", "island"] },
  // Creative: teal. Making things and taking things in quietly.
  { hue: 172, words: ["creative", "art", "arts", "craft", "crafts", "paint", "painting", "pottery",
                      "draw", "drawing", "sketch", "photo", "photography", "write", "writing", "music class",
                      "knit", "sew", "diy", "class$", "classes", "workshop", "museum", "gallery", "book", "reading"] },
  // Entertainment: blue. Things to go see.
  { hue: 218, words: ["entertainment", "movie", "movies", "film", "cinema", "show", "concert", "music",
                      "gig", "theater", "theatre", "comedy", "festival", "fest", "live$", "stream",
                      "theme park", "disney", "universal", "fair$", "carnival", "game day", "watch"] },
  // Games: purple. Playing at a table or a screen.
  { hue: 262, words: ["game", "games", "board game", "trivia", "poker", "cards", "gaming",
                      "video game", "arcade", "escape", "puzzle", "chess", "dnd", "d&d",
                      "laser tag", "mini golf", "go kart", "bingo"] },
  // Travel: orange.
  { hue: 24,  words: ["trip", "travel", "road trip", "getaway", "vacation", "weekend away",
                      "flight", "cruise", "drive", "tour$", "tours", "day trip"] },
  // Community: pink.
  { hue: 332, words: ["community", "family", "kids", "volunteer", "church", "school", "neighbors", "charity"] },
];

// Hues in the gaps between the families above, for names nothing matched.
const SPARE = [90, 296, 196];

function familyHue(name) {
  const n = " " + String(name || "").toLowerCase().replace(/[^a-z0-9&é ]+/g, " ") + " ";
  for (const f of FAMILIES) {
    // whole words or word starts: "hike" matches "hikes" but "run" never
    // matches "brunch"
    // a trailing $ means the whole word ("tea" but not "team")
    if (f.words.some(w => w.endsWith("$") ? n.includes(" " + w.slice(0, -1) + " ") : n.includes(" " + w))) return f.hue;
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

// Lightness for filled color: yellows, greens and teals read paler at the
// same number, so they sit darker to keep white text legible on them.
function tagLight(hue) {
  if (hue >= 35 && hue <= 60) return 44;      // gold
  if (hue > 60 && hue <= 150) return 40;      // greens
  if (hue >= 160 && hue <= 200) return 42;    // teals
  return 50;
}

// The inline style that colors anything inside it.
function tagStyle(tagOrName) {
  const name = tagOrName && typeof tagOrName === "object" ? tagOrName.name : tagOrName;
  const h = tagHue(name);
  return `--h:${h};--l:${tagLight(h)}%`;
}

module.exports = { tagHue, tagLight, tagStyle, familyHue, FAMILIES };
