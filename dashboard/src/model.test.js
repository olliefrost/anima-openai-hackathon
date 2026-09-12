import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from './model.js';
const now=100*3600000;
const record={id:'r1',patientId:'p1',title:'Prescription',status:'pending',version:1,createdAt:now-3600000,dueAt:now-1};
test('uses simulation due time and excludes completed records from attention',()=>{
 assert.equal(aggregate([{site:'gp',resources:[record]}],now)[0].overdue,true);
 assert.equal(aggregate([{site:'gp',resources:[{...record,status:'dispensed'}]}],now)[0].attention,false);
 assert.equal(aggregate([{site:'gp',resources:[{...record,dueAt:now+1}]}],now)[0].overdue,false);
});
test('deduplicates cross-silo records by ID using the newest version',()=>{
 const result=aggregate([{site:'gp',resources:[record]},{site:'pharmacy',resources:[{...record,version:2,status:'dispensed'}]}],now);
 assert.equal(result.length,1);assert.equal(result[0].done,true);assert.deepEqual(result[0].seenIn,['gp','pharmacy']);
});
test('highlights stale undated records without declaring them overdue; ignores service inventory',()=>{
 const result=aggregate([{site:'community',resources:[{...record,dueAt:undefined,createdAt:0},{...record,id:'stock',patientId:undefined}]}],now);
 assert.equal(result.length,1);assert.equal(result[0].attention,true);assert.equal(result[0].overdue,false);
});
