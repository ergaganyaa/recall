export type Chapter = {
  /** 1-based number within the whole series */
  number: number;
  title: string;
};

export type Volume = {
  number: number;
  title: string;
  chapters: Chapter[];
};

export type Book = {
  slug: string;
  title: string;
  author: string;
  genres: string[];
  status: "Ongoing" | "Completed";
  synopsis: string;
  /** Two CSS colors used for the generated cover gradient */
  cover: [string, string];
  volumes: Volume[];
  /** Series-wide number of the last chapter the reader finished; 0 = not started */
  lastReadChapter: number;
};

export type ReadingProgress = {
  read: number;
  total: number;
  percent: number;
};

export type LastRead = {
  volume: Volume;
  chapter: Chapter;
};
