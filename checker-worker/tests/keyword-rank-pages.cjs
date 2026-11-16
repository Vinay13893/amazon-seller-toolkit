const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const browser = require('../dist/utils/browser')
const { runKeywordRankCheck } = require('../dist/checkers/keywordRank')

const input = { workspace_id:'test', tracked_keyword_id:'test', asin:'TEST000001', keyword:'fixture', marketplace:'IN' }
const card = (asin='TEST000002', sponsored=false) => ({asin,sponsored,positionOnPage:1})
async function scan(pages, {blocked=false,next=true,waitFails=false}={}) {
  let index=-1
  browser.withBrowserPage=async callback=>callback({
    goto:async()=>{index++}, title:async()=>blocked?'Robot Check':'Search', textContent:async()=>'',
    waitForSelector:async()=>{if(waitFails)throw new Error('timeout')},
    evaluate:async()=>pages[index]??[],
    locator:selector=>({first:()=>({isVisible:async()=>false}),count:async()=>selector.includes('pagination')&&next?1:0}),
  })
  return runKeywordRankCheck(input)
}
test('empty or changed search cards are failures, never not-found', async()=>{
  const result=await scan([[]]); assert.equal(result.status,'failed'); assert.equal(result.ok,false)
})
test('a card-loading timeout is not a negative rank', async()=>{
  assert.equal((await scan([[]],{waitFails:true})).status,'failed')
})
test('an unreadable later page invalidates an incomplete scan', async()=>{
  assert.equal((await scan([[card()],[]])).status,'failed')
})
test('five readable pages can confirm not-found within that scan', async()=>{
  const result=await scan([[card()],[card()],[card()],[card()],[card()]])
  assert.equal(result.status,'not_found'); assert.equal(result.pages_checked,5); assert.equal(result.scanned_results,5)
})
test('the checker never requests a sixth page', async()=>{
  const result=await scan([[card()],[card()],[card()],[card()],[card()],[card('TEST000001')]])
  assert.equal(result.status,'not_found'); assert.equal(result.pages_checked,5)
})
test('last readable page ends scanning without requesting nonexistent pages', async()=>{
  const result=await scan([[card()]],{next:false})
  assert.equal(result.status,'not_found'); assert.equal(result.pages_checked,1)
})
test('organic and sponsored discoveries retain their separate ranks', async()=>{
  const result=await scan([[card('TEST000001'),card('TEST000001',true)]])
  assert.equal(result.status,'success'); assert.equal(result.organic_rank,1); assert.equal(result.sponsored_rank,1)
})
test('Amazon sponsored-card signals include ad links, labels and accessibility markers',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/checkers/keywordRank.ts'),'utf8')
  for (const marker of ['/sspa/click','data-ad-id','data-ad-feedback','puis-sponsored-label-text','aria-label*="sponsored"','card.matches(sponsoredSelector)']) {
    assert.ok(source.includes(marker),`missing sponsored marker: ${marker}`)
  }
})
test('blocked pages remain blocked', async()=>{
  assert.equal((await scan([[]],{blocked:true})).status,'blocked')
})
