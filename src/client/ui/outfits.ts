// Labels and curated outfit presets for the character editor.
import type { Appearance } from '../../shared/net/protocol';

export const TOP_L = ['Jacke', 'Hoodie', 'T-Shirt', 'Anzug', 'Daunenjacke'];
export const LEGS_L = ['Jeans', 'Shorts', 'Trainerhose'];
export const FEET_L = ['Sneaker', 'Stiefel', 'Lederschuhe'];
export const HAIR_L = ['Kurz', 'Lang', 'Glatze', 'Voll', 'Pferdeschwanz', 'Dutt', 'Undercut'];
export const HAT_L = ['Keine', 'Cap', 'Mütze', 'Hut'];
export const ACC_L = ['Keine', 'Brille', 'Sonnenbrille', 'Rucksack', 'Schal'];

/** Presets only set clothing; skin, hair and build stay as they are. */
export const OUTFIT_PRESETS: { name: string; a: Partial<Appearance> }[] = [
  { name: 'Paradeplatz', a: { top: 3, jacket: 0, legs: 0, pants: 0, feet: 2, shoes: 0, hat: 0, acc: 0 } },
  { name: 'Bergführer', a: { top: 4, jacket: 15, legs: 2, pants: 5, feet: 1, shoes: 1, hat: 2, acc: 2 } },
  { name: 'Langstrasse', a: { top: 1, jacket: 10, legs: 2, pants: 7, feet: 0, shoes: 2, hat: 1, acc: 0 } },
  { name: 'Sommer am See', a: { top: 2, jacket: 3, legs: 1, pants: 3, feet: 0, shoes: 2, hat: 0, acc: 2 } },
  { name: 'Winterabend', a: { top: 0, jacket: 7, legs: 0, pants: 4, feet: 1, shoes: 1, hat: 3, acc: 4 } },
  { name: 'Velokurier', a: { top: 0, jacket: 11, legs: 2, pants: 1, feet: 0, shoes: 3, hat: 1, acc: 3 } },
];
