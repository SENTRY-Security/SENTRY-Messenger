// Emoji pool for contact identifiers.
// All codepoints are Unicode <= 13.0, no skin-tone / gender variants, no ZWJ sequences.

export const EMOJI_POOL = {
  animals: [
    '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼',
    '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔',
    '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺',
    '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞',
    '🐙', '🦑', '🐠', '🐟', '🐡', '🐬', '🐳', '🐋',
    '🦈', '🐊', '🐢', '🦎', '🐍', '🦕', '🦖'
  ],
  plants: [
    '🌵', '🌲', '🌳', '🌴', '🌱', '🌿', '🍀', '🍁',
    '🍂', '🍃', '🌺', '🌻', '🌹', '🌷', '🌸', '💐',
    '🌾', '🍄', '🌰'
  ],
  food: [
    '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓',
    '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅',
    '🥑', '🌽', '🥕', '🧄', '🧅', '🥔', '🍔', '🍟',
    '🍕', '🌭', '🥪', '🌮', '🍣', '🍱', '🥟', '🍩',
    '🍪', '🎂', '🍰', '🧁', '🍫', '🍬', '🍭', '🍮'
  ],
  drinks: [
    '☕', '🍵', '🥤', '🍺', '🍷', '🥂', '🍶', '🧃'
  ],
  nature: [
    '🌙', '⭐', '🌟', '✨', '☀️', '🌤', '⛅', '🌈',
    '❄️', '💧', '🌊', '🔥', '💨', '🌪', '⚡', '☄️',
    '🌍', '🌏'
  ],
  transport: [
    '🚗', '🚕', '🚌', '🚎', '🏎', '🚓', '🚑', '🚒',
    '🚂', '🚀', '✈️', '🚁', '⛵', '🚤', '🛸', '🚲',
    '🛵', '🏍'
  ],
  objects: [
    '⌚', '📱', '💻', '⌨️', '🖥', '🖨', '📷', '🎥',
    '📺', '📻', '🔦', '💡', '🔑', '🗝', '🔒', '🔓',
    '🛡', '⚔️', '🔫', '💣', '🔧', '🔨', '⚙️', '🧲',
    '⚓', '🎣', '🧭', '🪓', '🔬', '🔭', '💎', '💰',
    '📦', '📫', '📝', '📌', '✂️', '📎', '🖊', '✏️'
  ],
  symbols: [
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍',
    '💯', '♻️', '⚜️', '🔱', '⚛️', '☯️', '✡️', '☪️',
    '✝️', '☸️', '🕉', '♈', '♉', '♊', '♋', '♌',
    '♍', '♎', '♏', '♐', '♑', '♒', '♓'
  ],
  activities: [
    '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉',
    '🎱', '🏓', '🏸', '🥊', '🎯', '🎳', '🏆', '🥇',
    '🎪', '🎭', '🎨', '🎬', '🎤', '🎧', '🎷', '🎸',
    '🎹', '🥁', '🎲', '🧩', '🎮', '🕹', '🎰'
  ],
  misc: [
    '🏠', '🏰', '🗼', '🗽', '⛩', '🕌', '🛕', '⛪',
    '🏗', '🌋', '🏔', '⛰', '🏝', '🏜', '🗻', '🧲'
  ]
};

export const EMOJI_CATEGORIES = [
  { id: 'animals', labelI18nKey: 'emoji.cat.animals' },
  { id: 'plants', labelI18nKey: 'emoji.cat.plants' },
  { id: 'food', labelI18nKey: 'emoji.cat.food' },
  { id: 'drinks', labelI18nKey: 'emoji.cat.drinks' },
  { id: 'nature', labelI18nKey: 'emoji.cat.nature' },
  { id: 'transport', labelI18nKey: 'emoji.cat.transport' },
  { id: 'objects', labelI18nKey: 'emoji.cat.objects' },
  { id: 'symbols', labelI18nKey: 'emoji.cat.symbols' },
  { id: 'activities', labelI18nKey: 'emoji.cat.activities' },
  { id: 'misc', labelI18nKey: 'emoji.cat.misc' }
];

const allEmojiSet = new Set(
  Object.values(EMOJI_POOL).flat()
);

export function getAllEmojis() {
  return Array.from(allEmojiSet);
}

export function isValidEmoji(emoji) {
  return typeof emoji === 'string' && allEmojiSet.has(emoji);
}

export function findCategoryOfEmoji(emoji) {
  if (!emoji) return null;
  for (const [catId, emojis] of Object.entries(EMOJI_POOL)) {
    if (emojis.includes(emoji)) return catId;
  }
  return null;
}
