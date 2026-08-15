import { LANGUAGE_NAMES, TRANSLATIONS } from "./translations";

export type Lang = keyof typeof TRANSLATIONS;
export { LANGUAGE_NAMES };
export const languages = Object.keys(TRANSLATIONS) as Lang[];

export function text(key: string, lang: string = "ru", values: Record<string, string | number> = {}): string {
  const selected = languages.includes(lang as Lang) ? lang as Lang : "ru";
  const table = TRANSLATIONS[selected] as Record<string, string>;
  const fallback = TRANSLATIONS.en as Record<string, string>;
  let value = table[key] ?? fallback[key] ?? (TRANSLATIONS.ru as Record<string, string>)[key] ?? key;
  for (const [name, replacement] of Object.entries(values)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

const STRIP_WORDS = ["Translate", "Перевести", "See translation", "See more", "Показать перевод"];
export function cleanPostText(input: string): string {
  let value = input.trim();
  for (const word of STRIP_WORDS) {
    if (value.endsWith(`\n${word}`)) value = value.slice(0, -(word.length + 1)).trim();
    else if (value.endsWith(`  ${word}`)) value = value.slice(0, -(word.length + 2)).trim();
    else if (value.endsWith(word)) value = value.slice(0, -word.length).trim();
  }
  return value;
}
