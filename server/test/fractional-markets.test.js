import assert from 'node:assert/strict';
import test from 'node:test';
import { loadServerConfig } from '../config.js';
import { MarketResolver } from '../infrastructure/market-resolver.js';
import { marketSoldPercent } from '../../src/imported-markets.js';
import { isMarketSoldOut } from '../../src/market-display.js';
import { parseTokenAmount, formatTokenAmount } from '../../src/market.js';
import { fractionalFactoryArgs } from '../../scripts/deploy-fractional-factory.js';

const legacy='0x1111111111111111111111111111111111111111';
const fractional='0x2222222222222222222222222222222222222222';
const market='0x3333333333333333333333333333333333333333';
const creator='0x4444444444444444444444444444444444444444';

test('a separate fractional factory retains the existing trusted registry', () => {
  const config=loadServerConfig({ ARC_NETWORK:'mainnet', VITE_MEMEVERSE_FACTORY_ADDRESS:legacy, VITE_FRACTIONAL_FACTORY_ADDRESS:fractional });
  assert.equal(config.marketFactoryAddress,legacy);
  assert.equal(config.fractionalFactoryAddress,fractional);
  assert.throws(()=>loadServerConfig({ ARC_NETWORK:'mainnet', VITE_FRACTIONAL_FACTORY_ADDRESS:'0x363124490E953EEbB414eB4c3e2f03a40eef8F2C' }),/testnet/);
  assert.throws(()=>loadServerConfig({ ARC_NETWORK:'mainnet', VITE_MEMEVERSE_FACTORY_ADDRESS:legacy, VITE_FRACTIONAL_FACTORY_ADDRESS:legacy }),/separate/);
});
test('artwork authentication accepts either trusted registry and rejects unrelated markets',async()=>{
  for(const registeredIn of [legacy,fractional,null]){
    const calls=[];
    const resolver=new MarketResolver({ factoryAddress:legacy, fractionalFactoryAddress:fractional, publicClient:{ async readContract({address,functionName}){
      calls.push([address,functionName]);
      return functionName==='isMarket'?address===registeredIn:creator;
    }}});
    if(registeredIn){ assert.equal((await resolver.resolveMarket(market)).creatorAddress,creator); }
    else await assert.rejects(()=>resolver.resolveMarket(market),error=>error.code==='MARKET_NOT_REGISTERED');
    assert.equal(calls.filter(([,name])=>name==='isMarket').length,2);
  }
});
test('decimal sell parsing preserves all eighteen digits and legacy limits',()=>{
  assert.equal(parseTokenAmount('0.123456789012345678',{fractional:true}),123456789012345678n);
  assert.equal(parseTokenAmount('1.25',{fractional:true}),1250000000000000000n);
  for(const invalid of ['0','-1','1e2','NaN','0.1234567890123456789']) assert.throws(()=>parseTokenAmount(invalid,{fractional:true}));
  assert.throws(()=>parseTokenAmount('1.25'),/whole/);
  assert.equal(parseTokenAmount('2'),2n*10n**18n);
});
test('fractional circulation is never truncated when measuring sold supply',()=>{
  const state={tradingVersion:2,totalSupplyTokens:100n,soldTokenCount:99n,soldTokenUnits:99500000000000000000n};
  assert.equal(isMarketSoldOut(state),false);
  assert.equal(marketSoldPercent(state),100); // percent bar rounds; availability never does.
  assert.equal(isMarketSoldOut({...state,soldTokenUnits:100n*10n**18n}),true);
});
test('fractional deployment preserves trusted USDC and explicit existing fee allocations',()=>{
  assert.deepEqual(fractionalFactoryArgs({usdc:'0x3600000000000000000000000000000000000000',treasury:creator,creatorFeeBps:100,treasuryFeeBps:100}),['0x3600000000000000000000000000000000000000',creator,100n,100n]);
  assert.throws(()=>fractionalFactoryArgs({usdc:legacy,treasury:creator,creatorFeeBps:100,treasuryFeeBps:100}),/Arc USDC/);
});

test('tiny positive fractional quotes never round down to a displayed zero',()=>{
  assert.equal(formatTokenAmount(1n,6),'0.000000000000000001');
  assert.equal(formatTokenAmount(123456789n,6),'0.000000000123456789');
  assert.equal(formatTokenAmount(980392156862745098n,6),'0.980392');
  assert.equal(formatTokenAmount(0n,6),'0');
});
