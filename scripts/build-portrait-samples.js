'use strict';
// Package approved generated photographs; this script does not call an image API.
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const root = path.join(__dirname, '..');
const order = ['Selfies','Face Booster','Mirror Selfies','Family & Friends','Signature Studio','Lifestyle'];
const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
async function main() {
  if (!process.argv[2]) throw new Error('Pass the approved image-source manifest path');
  const rows = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const assets = path.join(root,'client/portrait-samples');
  const review = path.join(root,'design/portrait-samples');
  await fs.mkdir(assets,{recursive:true}); await fs.mkdir(review,{recursive:true});
  const catalog = {};
  for (const row of rows) {
    if (!/^[a-z0-9-]+$/.test(row.id) || !row.source) throw new Error(`Missing approved source: ${row.id}`);
    const version = Number.isInteger(row.version) && row.version > 0 && row.version < 100 ? row.version : 1;
    const preview = `${row.id}.v${version}.webp`, thumbnail = `${row.id}-thumb.v${version}.webp`;
    await sharp(row.source).rotate().resize({width:768,height:1024,fit:'inside',withoutEnlargement:true}).webp({quality:86,effort:5}).toFile(path.join(assets,preview));
    await sharp(row.source).rotate().resize({width:320,height:426,fit:'inside',withoutEnlargement:true}).webp({quality:78,effort:5}).toFile(path.join(assets,thumbnail));
    catalog[row.id] = {name:row.name,collection:row.collection,preview:`/portrait-samples/${preview}`,thumbnail:`/portrait-samples/${thumbnail}`};
    if (row.beforeSource) {
      const before = `${row.id}-before.v1.webp`, beforeThumbnail = `${row.id}-before-thumb.v1.webp`;
      await sharp(row.beforeSource).rotate().resize({width:768,height:1024,fit:'inside',withoutEnlargement:true}).webp({quality:86,effort:5}).toFile(path.join(assets,before));
      await sharp(row.beforeSource).rotate().resize({width:320,height:426,fit:'inside',withoutEnlargement:true}).webp({quality:78,effort:5}).toFile(path.join(assets,beforeThumbnail));
      Object.assign(catalog[row.id],{before:`/portrait-samples/${before}`,beforeThumbnail:`/portrait-samples/${beforeThumbnail}`,comparisonLayout:'separate'});
    } else if (row.collection === 'Mirror Selfies') {
      Object.assign(catalog[row.id],{before:catalog[row.id].preview,beforeThumbnail:catalog[row.id].thumbnail,comparisonLayout:'paired'});
    }

  }
  await fs.writeFile(path.join(assets,'catalog.json'),JSON.stringify(catalog,null,2)+'\n');
  await fs.writeFile(path.join(review,'prompts.json'),JSON.stringify({generator:'Built-in image generation tool',subjects:'Fictional young adults, approximately 22–28; approved burgundy-blouse replacement in all group samples',purpose:'Illustrative preset examples, not guaranteed outputs or customer photographs',presets:rows.map(({id,name,collection,prompt})=>({id,name,collection,prompt}))},null,2)+'\n');
  await fs.writeFile(path.join(review,'before-prompts.json'),JSON.stringify({generator:'Built-in image generation tool',purpose:'Illustrative before samples; not actual provider evaluation pairs',presets:rows.filter(row=>row.beforeSource).map(({id,beforePrompt})=>({id,prompt:beforePrompt}))},null,2)+'\n');
  const sorted = [...rows].sort((a,b)=>order.indexOf(a.collection)-order.indexOf(b.collection));
  const layers = [];
  for (let i=0;i<sorted.length;i++) {
    const row=sorted[i],left=(i%6)*200,top=Math.floor(i/6)*285;
    const entry=catalog[row.id];
    if (entry.comparisonLayout==='separate') {
      const before=await sharp(path.join(assets,path.basename(entry.before))).resize(96,240,{fit:'contain',background:'#f6f1f3'}).toBuffer();
      const after=await sharp(path.join(assets,path.basename(entry.preview))).resize(96,240,{fit:'contain',background:'#f6f1f3'}).toBuffer();
      layers.push({input:before,left:left+4,top},{input:after,left:left+100,top});
    } else {
      const tile=await sharp(path.join(assets,path.basename(entry.preview))).resize(192,240,{fit:'contain',background:'#f6f1f3'}).toBuffer();
      layers.push({input:tile,left:left+4,top});
    }
    const label=Buffer.from(`<svg width="200" height="45"><rect width="200" height="45" fill="white"/><text x="8" y="17" font-size="12" font-family="sans-serif" fill="#482535">${escapeXml(row.name)}</text><text x="8" y="34" font-size="10" font-family="sans-serif" fill="#88727d">${escapeXml(row.collection)}</text></svg>`);
    layers.push({input:label,left,top:top+240});
  }
  await sharp({create:{width:1200,height:Math.ceil(sorted.length/6)*285,channels:3,background:'#ffffff'}}).composite(layers).jpeg({quality:88}).toFile(path.join(review,'contact-sheet.jpg'));
  console.log(`Packaged ${rows.length} preset samples with thumbnails and a review sheet.`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
