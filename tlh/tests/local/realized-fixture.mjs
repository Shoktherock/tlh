import {realizedHeaders} from '../../src/realized/engine.mjs';
const quote=v=>'"'+String(v).replaceAll('"','""')+'"';
export function realizedFixture({end='09/30/2026',loss='-20.00',basis='120.00'}={}){
 const title=`Realized Gain/Loss - Lot Details for Synthetic as of Wed Sep 30 02:00:00 EDT 2026 from 01/01/2026 to ${end}`;
 const row=['EXAMPLE','Synthetic company','09/23/2026','01/01/2026','1','$100','$120','$100',basis,loss,'-16.67%','',loss,'Short Term',basis,'No','','09/23/2026','','','','','','',''];
 return [[title,...Array(24).fill('')],realizedHeaders,row].map(r=>r.map(quote).join(',')).join('\n');
}
