'use strict';

// Suggests avatar features from a photo. The model only chooses from the fixed lists below, which are the
// parts of the on-device avatar builder (client/vendor/open-peeps.js; a test keeps the two in step), so the
// answer is always something the builder can draw. Anything outside the lists is dropped, not trusted.

const HEADS = [
  'afro', 'bangs', 'bangs2', 'bantuKnots', 'bear', 'bun', 'bun2', 'buns', 'cornrows', 'cornrows2', 'dreads1', 'dreads2',
  'flatTop', 'flatTopLong', 'grayBun', 'grayMedium', 'grayShort', 'hatBeanie', 'hatHip', 'hijab', 'long', 'longAfro',
  'longBangs', 'longCurly', 'medium1', 'medium2', 'medium3', 'mediumBangs', 'mediumBangs2', 'mediumBangs3',
  'mediumStraight', 'mohawk', 'mohawk2', 'noHair1', 'noHair2', 'noHair3', 'pomp', 'shaved1', 'shaved2', 'shaved3',
  'short1', 'short2', 'short3', 'short4', 'short5', 'turban', 'twists', 'twists2',
];
// Faces that read as a calm, friendly default. The builder offers every expression; a photo suggests one of these.
const FACES = ['smile', 'smileBig', 'calm', 'cute', 'serious', 'smileTeethGap', 'solemn'];
const FACIAL_HAIR = [
  'chin', 'full', 'full2', 'full3', 'full4', 'goatee1', 'goatee2', 'moustache1', 'moustache2', 'moustache3', 'moustache4',
  'moustache5', 'moustache6', 'moustache7', 'moustache8', 'moustache9',
];
const ACCESSORIES = ['eyepatch', 'glasses', 'glasses2', 'glasses3', 'glasses4', 'glasses5', 'sunglasses', 'sunglasses2'];
const COUNTS = { skin:5, hair:10, clothing:7 };

const GUIDE = `Choose the parts of a friendly cartoon avatar that best match the single most prominent person in the photo.
Use ONLY the allowed values.
- skin: 0 very light, 1 light, 2 medium or tan, 3 brown, 4 deep brown.
- hair (colour): 0 black, 1 white or silver, 2 very pale blond, 3 golden blond, 4 pink, 5 light brown, 6 auburn or copper, 7 brown, 8 dark brown, 9 red.
- head (hairstyle): the closest hairstyle. Use noHair1, noHair2 or noHair3 for a bald head, and shaved1, shaved2 or shaved3 for a very short shaved head. hijab and turban only when the person wears one.
- facialHair: "none" unless a beard or moustache is clearly visible; otherwise the closest style (moustache1 to moustache9 are moustaches only, full and goatee styles are beards).
- accessories: "none" unless glasses or sunglasses are clearly worn; otherwise the closest style.
- face: the closest friendly expression for how they look in the photo.
- clothing: the colour closest to the top they are wearing: 0 coral, 1 amber, 2 yellow, 3 green, 4 aqua, 5 blue, 6 pink-purple.
Do not guess age, identity, or anything not asked for.`;

function suggestionSchema() {
  return {
    type:'object',
    additionalProperties:false,
    required:['skin', 'hair', 'head', 'face', 'facialHair', 'accessories', 'clothing'],
    properties:{
      skin:{ type:'integer', enum:[...Array(COUNTS.skin).keys()] },
      hair:{ type:'integer', enum:[...Array(COUNTS.hair).keys()] },
      head:{ type:'string', enum:HEADS },
      face:{ type:'string', enum:FACES },
      facialHair:{ type:'string', enum:['none', ...FACIAL_HAIR] },
      accessories:{ type:'string', enum:['none', ...ACCESSORIES] },
      clothing:{ type:'integer', enum:[...Array(COUNTS.clothing).keys()] },
    },
  };
}

function suggestionRequest(model, imageDataUri) {
  return {
    model,
    messages:[{
      role:'user',
      content:[
        { type:'text', text:GUIDE },
        { type:'image_url', image_url:{ url:imageDataUri, detail:'low' } },
      ],
    }],
    response_format:{ type:'json_schema', json_schema:{ name:'avatar_choice', strict:true, schema:suggestionSchema() } },
  };
}

const inList = (list, value) => typeof value === 'string' && list.includes(value);
const inRange = (count, value) => Number.isInteger(value) && value >= 0 && value < count;

// Whatever the model sent, only valid choices come out; anything else is left out so the builder keeps its default.
function normalizeSuggestion(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const suggestion = {};
  if (inRange(COUNTS.skin, source.skin)) suggestion.skin = source.skin;
  if (inRange(COUNTS.hair, source.hair)) suggestion.hair = source.hair;
  if (inRange(COUNTS.clothing, source.clothing)) suggestion.clothing = source.clothing;
  if (inList(HEADS, source.head)) suggestion.head = source.head;
  if (inList(FACES, source.face)) suggestion.face = source.face;
  if (source.facialHair === 'none') suggestion.facialHair = null;
  else if (inList(FACIAL_HAIR, source.facialHair)) suggestion.facialHair = source.facialHair;
  if (source.accessories === 'none') suggestion.accessories = null;
  else if (inList(ACCESSORIES, source.accessories)) suggestion.accessories = source.accessories;
  return suggestion;
}

// The chat-completions answer carries the JSON as text.
function parseSuggestionResponse(body) {
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') return null;
  try { return normalizeSuggestion(JSON.parse(text)); } catch (error) { return null; }
}

module.exports = {
  HEADS, FACES, FACIAL_HAIR, ACCESSORIES, COUNTS, GUIDE,
  suggestionSchema, suggestionRequest, normalizeSuggestion, parseSuggestionResponse,
};
