import { test } from '@bicycle-codes/tapzero'
import { IndexedStore, MetaData } from '../src/store.js'
let store:InstanceType<typeof IndexedStore>

test('IndexedStore', t => {
    store = new IndexedStore()
    t.ok(store, 'should create a store')
    t.equal(store.name, 'partylog', 'should have the default store name')
})

let meta1:MetaData|null
test('add something to the store', async t => {
    meta1 = await store.add({ type: 'test' })
    t.ok(meta1, 'should create metadata')
    t.ok(meta1!.id, 'should return metadata with an ID')
    t.equal(meta1!.seq, 1, 'should have the right sequence number')

    // @ts-expect-error  b/c testing
    const meta2 = await store.add({ type: 'testing' }, { seq: 7 })
    t.equal((meta2 as MetaData).seq, 2,
        'should overwrite the sequence I passed in')
})

test('can get something from the store', async t => {
    const [action, metadata] = await store.byId((meta1 as MetaData).id)
    t.equal(action?.type, 'test', 'should return an action')
    t.equal(metadata?.seq, 1, 'should return the right metadata')
})
