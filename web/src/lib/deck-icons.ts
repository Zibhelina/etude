// The built-in deck illustrations (glossy style), grouped as in the Change icon picker. Files in assets/deck-icons.
const files = import.meta.glob<string>("../assets/deck-icons/*.webp", { eager: true, query: "?url", import: "default" });
const url = (id: string) => files[`../assets/deck-icons/${id}.webp`];

export const DECK_ART: { name: string; icons: { id: string; label: string }[] }[] = [
  { name: "Languages & writing", icons: [{ id: "languages", label: "Languages" }, { id: "literature", label: "Literature" }, { id: "writing", label: "Writing" }, { id: "calligraphy", label: "Calligraphy & kanji" }, { id: "vocabulary", label: "Vocabulary" }, { id: "listening", label: "Listening" }, { id: "cards", label: "Flashcards" }] },
  { name: "Math", icons: [{ id: "geometry", label: "Geometry" }, { id: "arithmetic", label: "Arithmetic" }, { id: "functions", label: "Functions & calculus" }, { id: "probability", label: "Probability" }, { id: "statistics", label: "Statistics" }, { id: "counting", label: "Counting" }] },
  { name: "Science", icons: [{ id: "physics", label: "Physics" }, { id: "chemistry", label: "Chemistry" }, { id: "biology", label: "Biology" }, { id: "genetics", label: "Genetics" }, { id: "astronomy", label: "Astronomy" }, { id: "magnetism", label: "Electromagnetism" }, { id: "elements", label: "Elements & 3D" }] },
  { name: "Body & medicine", icons: [{ id: "anatomy", label: "Anatomy & heart" }, { id: "psychology", label: "Psychology" }, { id: "medicine", label: "Medicine" }, { id: "pharmacology", label: "Pharmacology" }, { id: "bones", label: "Bones" }, { id: "optics", label: "Optics & vision" }] },
  { name: "Computing", icons: [{ id: "programming", label: "Programming" }, { id: "code", label: "Code" }, { id: "hardware", label: "Hardware" }, { id: "algorithms", label: "Data structures" }, { id: "databases", label: "Databases" }, { id: "security", label: "Security" }, { id: "morse", label: "Morse & codes" }] },
  { name: "Arts & music", icons: [{ id: "piano", label: "Piano & music" }, { id: "guitar", label: "Guitar" }, { id: "drums", label: "Drums & rhythm" }, { id: "painting", label: "Painting" }, { id: "photography", label: "Photography" }, { id: "film", label: "Film" }, { id: "theatre", label: "Theatre" }] },
  { name: "History & society", icons: [{ id: "ancient-history", label: "Ancient history" }, { id: "medieval", label: "Medieval history" }, { id: "documents", label: "Old documents" }, { id: "timeline", label: "Dates & timelines" }, { id: "government", label: "Government" }, { id: "law", label: "Law & philosophy" }] },
  { name: "Geography & travel", icons: [{ id: "world", label: "Countries & world" }, { id: "places", label: "Places" }, { id: "navigation", label: "Navigation" }, { id: "mountains", label: "Landforms" }, { id: "travel", label: "Travel" }, { id: "flags", label: "Flags" }, { id: "driving", label: "Driving & road rules" }] },
  { name: "Nature", icons: [{ id: "plants", label: "Plants" }, { id: "animals", label: "Animals" }, { id: "ecology", label: "Ecology" }, { id: "fungi", label: "Fungi" }, { id: "marine", label: "Marine life" }, { id: "trees", label: "Trees & earth" }] },
  { name: "Games, sport & life", icons: [{ id: "chess", label: "Chess" }, { id: "games", label: "Video games" }, { id: "arcade", label: "Arcade & retro" }, { id: "sports", label: "Sports" }, { id: "fitness", label: "Fitness" }, { id: "money", label: "Money & finance" }, { id: "business", label: "Business" }, { id: "cooking", label: "Cooking" }] },
  { name: "Study", icons: [{ id: "ideas", label: "Ideas & trivia" }, { id: "exams", label: "Exams & university" }, { id: "notes", label: "Notes & homework" }, { id: "review", label: "Daily review" }, { id: "memory", label: "Memory" }] },
];

export const EMOJI_SUGGESTIONS = ["📚", "🧠", "🌍", "🗺️", "🇯🇵", "🇫🇷", "🇪🇸", "🇧🇷", "🧪", "⚗️", "🧬", "🔭", "⚛️", "🧮", "📐", "📈", "💻", "🐍", "🔐", "🎹", "🎸", "🎨", "🎬", "📷", "♟️", "🎲", "⚽", "🏋️", "🍳", "🌱", "🐾", "🦴", "🫀", "💊", "⚖️", "🏛️", "📜", "✈️", "🚗", "💰", "💡", "✍️", "🗣️", "🎧", "⭐", "🔥", "❤️", "🎓"];

export type DeckIconValue = { kind: "art"; id: string; src: string } | { kind: "emoji"; emoji: string } | { kind: "media"; src: string } | null;

/** Reads a stored icon (`art:<id>`, `emoji:<emoji>` or `media:files/<image>`); unknown art, `none` and the default read as no picture. */
export function parseDeckIcon(icon: string | null | undefined): DeckIconValue {
  if (!icon) return null;
  if (icon.startsWith("art:")) {
    const src = url(icon.slice(4));
    return src ? { kind: "art", id: icon.slice(4), src } : null;
  }
  if (icon.startsWith("emoji:")) return { kind: "emoji", emoji: icon.slice(6) };
  if (/^media:files\/[0-9a-f]{64}\.[a-z]+$/.test(icon)) return { kind: "media", src: `/media/${icon.slice(6)}` };
  return null;
}

/** `none` turns the badge off: no picture and no count rings. */
export const noBadge = (icon: string | null | undefined) => icon === "none";
/** The deck shows a picture of its own (art, emoji or an image), not the count rings. */
export const hasPicture = (icon: string | null | undefined) => !!parseDeckIcon(icon);

export const artUrl = url;
