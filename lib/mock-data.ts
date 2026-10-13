import type { Book, LastRead, ReadingProgress, Volume } from "./types";

/** Builds volumes from per-volume chapter titles, numbering chapters across the series. */
function volumes(defs: { title: string; chapters: string[] }[]): Volume[] {
  let n = 0;
  return defs.map((v, i) => ({
    number: i + 1,
    title: v.title,
    chapters: v.chapters.map((title) => ({ number: ++n, title })),
  }));
}

export const books: Book[] = [
  {
    slug: "clockwork-of-the-last-star",
    title: "Clockwork of the Last Star",
    author: "Mirei Hoshizaki",
    genres: ["Fantasy", "Adventure"],
    status: "Ongoing",
    synopsis:
      "In a city powered by a dying star, an apprentice clockmaker discovers a gear that ticks in time with the heavens. Repairing it may save the city — or hasten its end.",
    cover: ["#4338ca", "#db2777"],
    lastReadChapter: 9,
    volumes: volumes([
      {
        title: "The Broken Gear",
        chapters: [
          "An Apprentice in the Lower Ward",
          "The Gear That Ticked Backwards",
          "Night Market of Mirrors",
          "A Debt to the Guild",
          "The Astronomer's Warning",
          "Beneath the Observatory",
        ],
      },
      {
        title: "Tides of Brass",
        chapters: [
          "The Harbor That Never Moved",
          "A Contract With Smoke",
          "Letters From the Upper Ward",
          "The Silent Foundry",
          "Eclipse Rehearsal",
        ],
      },
      {
        title: "The Last Star Falls",
        chapters: [
          "Count the Hours",
          "The Spire Opens",
          "What the Clock Remembers",
          "Dawn, Unwound",
        ],
      },
    ]),
  },
  {
    slug: "the-tea-shop-at-the-edge-of-worlds",
    title: "The Tea Shop at the Edge of Worlds",
    author: "Anselm Rowe",
    genres: ["Slice of Life", "Fantasy"],
    status: "Completed",
    synopsis:
      "Every door in Odette's tiny tea shop opens onto a different world. Her only rule: everyone gets a warm cup, no questions asked — until a customer arrives who has no world to return to.",
    cover: ["#0f766e", "#65a30d"],
    lastReadChapter: 14,
    volumes: volumes([
      {
        title: "First Steep",
        chapters: [
          "The Door That Wasn't There",
          "Jasmine for a Dragon",
          "The Quiet Regular",
          "Rain Over Two Moons",
        ],
      },
      {
        title: "Second Steep",
        chapters: [
          "A Recipe Lost to Time",
          "The Cartographer's Cup",
          "Honey and Thunder",
          "Closing Early",
        ],
      },
      {
        title: "Final Steep",
        chapters: [
          "The Customer With No World",
          "Every Door at Once",
          "Last Call",
          "Refill",
          "Open Tomorrow",
          "Epilogue: A Table for Two",
        ],
      },
    ]),
  },
  {
    slug: "reincarnated-as-the-villains-librarian",
    title: "Reincarnated as the Villain's Librarian",
    author: "Kaito Sumeragi",
    genres: ["Isekai", "Comedy"],
    status: "Ongoing",
    synopsis:
      "Reborn as the quiet librarian of an overlord's fortress, Haru discovers the dark lord's greatest weakness: he can't stop checking out romance novels — and never returns them on time.",
    cover: ["#7c3aed", "#0ea5e9"],
    lastReadChapter: 3,
    volumes: volumes([
      {
        title: "Overdue",
        chapters: [
          "Welcome to the Fortress Archive",
          "Late Fees Are Forever",
          "The Overlord's Reading List",
          "A Hero Walks Into the Stacks",
          "Silence, Please",
        ],
      },
      {
        title: "Restricted Section",
        chapters: [
          "The Book That Reads Back",
          "Inventory Day",
          "Plot Armor",
          "The Seventh Shelf",
        ],
      },
    ]),
  },
  {
    slug: "iron-saints-of-the-salt-sea",
    title: "Iron Saints of the Salt Sea",
    author: "Venna Okoro",
    genres: ["Dark Fantasy", "Military"],
    status: "Ongoing",
    synopsis:
      "When the tide stops coming in, the armored saints of the coastal order must march across the exposed seabed to find out what the ocean is hiding.",
    cover: ["#0c4a6e", "#475569"],
    lastReadChapter: 0,
    volumes: volumes([
      {
        title: "The Tide Withdraws",
        chapters: [
          "Low Water",
          "Oath of Rust",
          "The Wreck Road",
          "What the Gulls Knew",
          "March at Dusk",
        ],
      },
      {
        title: "Seabed Cathedral",
        chapters: [
          "Salt in the Wound",
          "The Drowned Choir",
          "A Saint Kneels",
          "Return Current",
        ],
      },
    ]),
  },
  {
    slug: "my-rival-is-a-time-loop",
    title: "My Rival Is a Time Loop",
    author: "Yuna Fairweather",
    genres: ["Romance", "Sci-Fi"],
    status: "Completed",
    synopsis:
      "Every day before the school festival, Rin wakes up to the same morning — and the same infuriatingly perfect rival. Escaping the loop means working together.",
    cover: ["#e11d48", "#f59e0b"],
    lastReadChapter: 12,
    volumes: volumes([
      {
        title: "Morning, Again",
        chapters: [
          "Day One (Again)",
          "Day Two (Definitely Again)",
          "A Truce Until Noon",
          "The Festival Committee",
          "Day Forty",
          "Cracks in the Calendar",
        ],
      },
      {
        title: "Tomorrow, Maybe",
        chapters: [
          "Different Choices",
          "The Rooftop Equation",
          "Rival, Redefined",
          "Festival Night",
          "Day One (Finally)",
          "Afterword: The Next Morning",
        ],
      },
    ]),
  },
  {
    slug: "the-wandering-inn-of-ash",
    title: "The Wandering Inn of Ash",
    author: "Tobias Leclerc",
    genres: ["Mystery", "Fantasy"],
    status: "Ongoing",
    synopsis:
      "An inn that walks the wasteland on chicken legs, a cook with no memory, and guests who all seem to be hiding the same secret. Dinner is served at midnight.",
    cover: ["#92400e", "#1e293b"],
    lastReadChapter: 11,
    volumes: volumes([
      {
        title: "Check-In",
        chapters: [
          "The Inn Stands Up",
          "Room Seven",
          "A Cook Without a Name",
          "Midnight Service",
          "The Guest Ledger",
          "Footprints on the Ceiling",
        ],
      },
      {
        title: "Check-Out",
        chapters: [
          "Ashfall Menu",
          "Whose Key Is This?",
          "The Locked Cellar",
          "Every Guest Lies",
          "The Innkeeper's Bell",
          "Three Knocks",
        ],
      },
      {
        title: "Long Stay",
        chapters: [
          "Nowhere to Be",
          "Hearth and Hunger",
          "The Map in the Soup",
          "A Name, Returned",
          "Dinner Is Served",
          "Last Orders",
        ],
      },
    ]),
  },
];

export function getBook(slug: string): Book | undefined {
  return books.find((b) => b.slug === slug);
}

export function getTotalChapters(book: Book): number {
  return book.volumes.reduce((sum, v) => sum + v.chapters.length, 0);
}

export function getProgress(book: Book): ReadingProgress {
  const total = getTotalChapters(book);
  const read = Math.min(book.lastReadChapter, total);
  return { read, total, percent: total === 0 ? 0 : Math.round((read / total) * 100) };
}

/** The last chapter the reader finished, or undefined if they haven't started. */
export function getLastRead(book: Book): LastRead | undefined {
  for (const volume of book.volumes) {
    const chapter = volume.chapters.find((c) => c.number === book.lastReadChapter);
    if (chapter) return { volume, chapter };
  }
  return undefined;
}

/** The chapter after the last-read one, or undefined if the book is finished. */
export function getNextChapter(book: Book): LastRead | undefined {
  const target = book.lastReadChapter + 1;
  for (const volume of book.volumes) {
    const chapter = volume.chapters.find((c) => c.number === target);
    if (chapter) return { volume, chapter };
  }
  return undefined;
}

/** The book the reader is mid-way through (mock: first one in progress). */
export function getContinueReadingBook(): Book {
  return (
    books.find((b) => {
      const { read, total } = getProgress(b);
      return read > 0 && read < total;
    }) ?? books[0]
  );
}
