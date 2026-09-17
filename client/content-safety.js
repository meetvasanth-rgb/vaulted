/* Local safety checks: no text, keys or attachments leave the device. */
(function(root) {
  'use strict';
  const dictionaries = typeof module !== 'undefined' && module.exports ? require('./vendor/safety-words') : root.VaultlixSafetyWords;
  if (!dictionaries) throw Error('Safety dictionary unavailable');
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Single letters and short Latin abbreviations have no reliable meaning without context.
  const wordPattern = new RegExp('(?:^|[^\\p{L}\\p{N}])(?:' + [...new Set(Object.values(dictionaries).flat().map(normalize).filter(word => word.length > 1 && !/^[a-z0-9]{1,2}$/.test(word)))].sort((a,b)=>b.length-a.length).map(escape).join('|') + ')(?=$|[^\\p{L}\\p{N}])','u');
  // Deliberately high-confidence rules, not a claim of semantic understanding.
  // Unicode boundaries avoid matching harmless words such as "Scunthorpe".
  const rules = [
    ['threat', /(?:\b(?:i (?:will|am going to)|i['’]?ll) (?:kill|murder|rape) (?:you|your)\b|\b(?:kill yourself|go kill yourself)\b)/u],
    ['abuse', /(?:^|[^\p{L}\p{N}])(?:nigger|niggers|faggot|faggots|motherfucker|motherfuckers)(?=$|[^\p{L}\p{N}])/u],
    ['sexual exploitation', /\b(?:child porn(?:ography)?|cp for sale|(?:buy|sell|selling|send|share) (?:child|underage|minor) (?:nudes|porn)|rape (?:a |the )?(?:child|kid))\b/u],
    ['threat', /(?:тебя убью|убью тебя|я тебя изнасилую|je vais te tuer|te voy a matar|मैं तुम्हें मार दूंगा|तुझे मार डालूँगा|سأقتلك|سوف أقتلك|我要杀了你|我会杀了你|ես քեզ կսպանեմ)/u],
  ];
  function normalize(value) {
    return String(value || '').normalize('NFKC').toLowerCase()
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
      .replace(/\s+/g, ' ').trim();
  }
  function check(value) {
    const text = normalize(value);
    for (const [category, pattern] of rules) if (pattern.test(text)) return { blocked:true, category };
    if (wordPattern.test(text)) return {blocked:true,category:'objectionable language'};
    const deobfuscated = text.replace(/[013457@$!]/g, ch => ({'0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','@':'a','$':'s','!':'i'}[ch]));
    if (wordPattern.test(deobfuscated)) return {blocked:true,category:'objectionable language'};
    return { blocked:false, category:null };
  }
  const api = Object.freeze({ check, normalize });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VaultlixContentSafety = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
